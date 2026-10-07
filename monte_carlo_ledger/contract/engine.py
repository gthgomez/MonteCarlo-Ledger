"""Pure, clock-free reference engine for MonteCarlo Contract 1.0.

This module is the Python reference implementation of the contract. It has no
database, no wall-clock, and no floating point in any contract-observable value.
"""

from __future__ import annotations

import calendar
from datetime import date, timedelta
from typing import Any, Dict, List, Optional, Tuple

from .money import ContractError, checked_add, round_half_away, scale_cents_by_percent
from .prng import SplitMix64

CONTRACT_VERSION = "1.1"
SUPPORTED_CONTRACT_VERSIONS = ("1.0", "1.1")
_MAX_OCCURRENCES = 100_000
_MONTH_STEPS = {"monthly": 1, "bimonthly": 2, "quarterly": 3, "semiannually": 6, "annually": 12}
_FREQUENCIES = {
    "weekly", "biweekly", "semimonthly", "monthly", "bimonthly",
    "quarterly", "semiannually", "annually", "onetime",
}

SIMULATION_DEFAULTS: Dict[str, int] = {
    "runs": 500,
    "seed": 42,
    "income_variation_min": -8,
    "income_variation_max": 8,
    "expense_variation_min": 0,
    "expense_variation_max": 0,
    "surprise_probability_ppm": 150000,
    "surprise_check_interval_days": 14,
    "surprise_amount_min": 2000,
    "surprise_amount_max": 15000,
    "quantile_num": 1,
    "quantile_den": 10,
    "reserve_cents": 0,
}


def _parse_date(value: Any, code: str = "INVALID_DATE") -> date:
    if not isinstance(value, str):
        raise ContractError(code, repr(value))
    try:
        return date.fromisoformat(value)
    except ValueError as exc:  # pragma: no cover - defensive
        raise ContractError(code, str(exc)) from exc


def _last_day(year: int, month: int) -> int:
    return calendar.monthrange(year, month)[1]


def _validate_event(ev: Dict[str, Any]) -> None:
    amount = ev.get("amount_cents")
    etype = ev.get("type")
    if not isinstance(amount, int) or isinstance(amount, bool):
        raise ContractError("INVALID_AMOUNT", repr(amount))
    if etype == "income" and amount <= 0:
        raise ContractError("INVALID_AMOUNT", f"income {amount}")
    if etype == "expense" and amount >= 0:
        raise ContractError("INVALID_AMOUNT", f"expense {amount}")
    if etype == "adjustment" and amount == 0:
        raise ContractError("INVALID_AMOUNT", "zero adjustment")
    if etype not in ("income", "expense", "adjustment"):
        raise ContractError("INVALID_EVENT_TYPE", repr(etype))


def _validate_recurrence(rec: Dict[str, Any]) -> None:
    rtype = rec.get("type")
    amount = rec.get("amount_cents")
    if not isinstance(amount, int) or isinstance(amount, bool):
        raise ContractError("INVALID_AMOUNT", repr(amount))
    if rtype == "income" and amount <= 0:
        raise ContractError("INVALID_AMOUNT", f"income {amount}")
    if rtype == "expense" and amount >= 0:
        raise ContractError("INVALID_AMOUNT", f"expense {amount}")
    if rtype not in ("income", "expense"):
        raise ContractError("INVALID_EVENT_TYPE", repr(rtype))
    if rec.get("frequency") not in _FREQUENCIES:
        raise ContractError("INVALID_FREQUENCY", repr(rec.get("frequency")))


def _contract_version(scenario: Dict[str, Any]) -> str:
    version = scenario.get("contract_version", CONTRACT_VERSION)
    if version not in SUPPORTED_CONTRACT_VERSIONS:
        raise ContractError("SCHEMA_INVALID", f"unsupported contract_version {version!r}")
    return version


def _exclusions(scenario: Dict[str, Any], version: str) -> set:
    """Set of (recurrence_id, ISO date) pairs to skip (contract 1.1).

    The field is a 1.1 addition, so a `1.0` document that carries it is `SCHEMA_INVALID`
    rather than being silently reinterpreted under 1.1 semantics.
    """
    if "occurrence_exclusions" in scenario and version == "1.0":
        raise ContractError("SCHEMA_INVALID", "occurrence_exclusions requires contract_version 1.1")
    result = set()
    for item in scenario.get("occurrence_exclusions", []) or []:
        if not isinstance(item, dict):
            raise ContractError("SCHEMA_INVALID", "occurrence_exclusions item must be an object")
        rid = item.get("recurrence_id")
        raw = item.get("date")
        if not isinstance(rid, str) or not isinstance(raw, str):
            raise ContractError("SCHEMA_INVALID", "occurrence exclusion requires recurrence_id and date")
        result.add((rid, _parse_date(raw).isoformat()))
    return result


def _occurrences(rec: Dict[str, Any], ceiling: date) -> List[date]:
    """Ascending occurrence dates from start_date up to (but excluding) ceiling."""
    freq = rec["frequency"]
    start = _parse_date(rec["start_date"])
    anchor = int(rec.get("anchor_day", start.day))
    end = _parse_date(rec["end_date"]) if rec.get("end_date") else None

    def stop(d: date) -> bool:
        return d >= ceiling or (end is not None and d > end)

    out: List[date] = []
    if freq == "onetime":
        return [start] if not stop(start) else []
    if freq in ("weekly", "biweekly"):
        step = timedelta(days=7 if freq == "weekly" else 14)
        d = start
        while not stop(d) and len(out) < _MAX_OCCURRENCES:
            out.append(d)
            d = d + step
        return out
    if freq == "semimonthly":
        year, month = start.year, start.month
        while len(out) < _MAX_OCCURRENCES:
            last = _last_day(year, month)
            for day in ([1, 15] if anchor < 15 else [15, last]):
                d = date(year, month, min(day, last))
                if d < start:
                    continue
                if stop(d):
                    return out
                out.append(d)
            month += 1
            if month > 12:
                month, year = 1, year + 1
            if stop(date(year, month, 1)):
                return out
        return out
    if freq == "annually" or freq in _MONTH_STEPS:
        step = _MONTH_STEPS[freq]
        year, month = start.year, start.month
        while len(out) < _MAX_OCCURRENCES:
            last = _last_day(year, month)
            d = date(year, month, min(anchor, last))
            if stop(d):
                return out
            if d >= start:  # start_date is a lower bound (MCD-0022)
                out.append(d)
            month += step
            year += (month - 1) // 12
            month = (month - 1) % 12 + 1
        return out
    raise ContractError("INVALID_FREQUENCY", freq)


def expand(scenario: Dict[str, Any]) -> Tuple[List[Dict[str, Any]], date, int, date]:
    """Expand explicit events and recurrences; return (events, as_of, horizon, window_end)."""
    if "as_of" not in scenario:
        raise ContractError("MISSING_AS_OF")
    as_of = _parse_date(scenario["as_of"])
    horizon = scenario.get("horizon_days")
    if not isinstance(horizon, int) or isinstance(horizon, bool) or horizon < 0:
        raise ContractError("INVALID_HORIZON", repr(horizon))
    version = _contract_version(scenario)
    exclusions = _exclusions(scenario, version)
    window_end = as_of + timedelta(days=horizon)

    events: List[Dict[str, Any]] = []
    order = 0
    for index, ev in enumerate(scenario.get("events", [])):
        _validate_event(ev)
        d = _parse_date(ev["date"])
        seq = ev.get("sequence")
        if seq is None:
            seq = 0 if ev["type"] == "income" else 1
        if d < as_of or d >= window_end:
            # Overdue / out-of-window explicit events are not projected (MCD-0002, MCD-0014).
            order = index + 1
            continue
        events.append(
            {"date": d, "amount": ev["amount_cents"], "type": ev["type"],
             "sequence": seq, "order": index, "name": ev.get("name", "")}
        )
        order = index + 1

    for rec in scenario.get("recurrences", []):
        _validate_recurrence(rec)
        rec_id = rec.get("id")
        first_in_window = True
        for d in _occurrences(rec, window_end):
            if d < as_of or d >= window_end:
                continue
            # Contract 1.1: a declared exclusion removes the occurrence before the
            # expected-amount slot is decided, so it does not consume expected_amount_cents
            # (the amount applies to the first *remaining* occurrence).
            if (rec_id, d.isoformat()) in exclusions:
                continue
            amount = rec["amount_cents"]
            if first_in_window and rec["type"] == "income" and "expected_amount_cents" in rec:
                amount = rec["expected_amount_cents"]
            first_in_window = False
            events.append(
                {"date": d, "amount": amount, "type": rec["type"],
                 "sequence": 0 if rec["type"] == "income" else 1,
                 "order": order, "name": rec.get("name", rec.get("id", ""))}
            )
            order += 1
    return events, as_of, horizon, window_end


def _ordered(events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return sorted(events, key=lambda e: (e["date"], e["sequence"], e["order"]))


def ordered_events(scenario: Dict[str, Any]) -> List[Dict[str, Any]]:
    """The canonical in-window event sequence for a scenario (MCD-0002/0003/0021).

    Exposes the same ordering the forecast and simulation use, so surface adapters
    (CLI/dashboard renderers) never re-implement recurrence or ordering semantics.
    """
    events, _as_of, _horizon, _window_end = expand(scenario)
    return _ordered(events)


def event_rows(scenario: Dict[str, Any]) -> List[Dict[str, Any]]:
    """Canonical ordered event timeline with running balances.

    A display adapter over ``ordered_events`` + ``checked_add``; it introduces no
    new financial rule, so every row is consistent with the canonical forecast.
    """
    balance = int(scenario["starting_balance_cents"])
    rows: List[Dict[str, Any]] = []
    for ev in ordered_events(scenario):
        balance = checked_add(balance, ev["amount"])
        rows.append({
            "date": ev["date"].isoformat(),
            "name": ev["name"],
            "type": ev["type"],
            "amount": ev["amount"],
            "balance_after": balance,
        })
    return rows


def forecast(start: int, as_of: date, ordered_events: List[Dict[str, Any]]) -> Dict[str, Any]:
    balance = start
    minimum = start
    minimum_date = as_of
    first_negative: Optional[str] = as_of.isoformat() if start < 0 else None
    ending = start
    for ev in ordered_events:
        balance = checked_add(balance, ev["amount"])
        ending = balance
        if balance < minimum:
            minimum = balance
            minimum_date = ev["date"]
        if first_negative is None and balance < 0:
            first_negative = ev["date"].isoformat()
    return {
        "minimum_balance_cents": minimum,
        "minimum_balance_date": minimum_date.isoformat(),
        "ending_balance_cents": ending,
        "first_negative_date": first_negative,
    }


def nearest_rank(sorted_values: List[int], num: int, den: int) -> int:
    n = len(sorted_values)
    idx = ((n * num) + den - 1) // den - 1
    idx = max(0, min(idx, n - 1))
    return sorted_values[idx]


def _params(simulation: Dict[str, Any]) -> Dict[str, int]:
    params = dict(SIMULATION_DEFAULTS)
    for key, value in simulation.items():
        params[key] = value
    if not isinstance(params["runs"], int) or params["runs"] < 1:
        raise ContractError("INVALID_RUNS", repr(params["runs"]))
    if params["surprise_check_interval_days"] < 1:
        raise ContractError("INVALID_HORIZON", "check interval")
    return params  # type: ignore[return-value]


def _simulate_once(
    base: List[Dict[str, Any]], start: int, as_of: date, horizon: int,
    window_end: date, p: Dict[str, int], rng: SplitMix64,
) -> Dict[str, Any]:
    scenario = [dict(e) for e in base]
    imin, imax = p["income_variation_min"], p["income_variation_max"]
    emin, emax = p["expense_variation_min"], p["expense_variation_max"]
    for ev in scenario:
        if ev["type"] == "income" and (imin != 0 or imax != 0):
            pct = rng.next_int(imin, imax)
            ev["amount"] = max(0, scale_cents_by_percent(ev["amount"], pct))
        elif ev["type"] != "income" and (emin != 0 or emax != 0):
            pct = rng.next_int(emin, emax)
            ev["amount"] = min(0, scale_cents_by_percent(ev["amount"], pct))

    interval = p["surprise_check_interval_days"]
    checks = horizon // interval
    for i in range(checks):
        if rng.next_ppm_hit(p["surprise_probability_ppm"]):
            offset = i * interval + rng.next_int(0, interval - 1)
            d = as_of + timedelta(days=offset)
            if d < window_end:
                amount = -rng.next_int(p["surprise_amount_min"], p["surprise_amount_max"])
                scenario.append(
                    {"date": d, "amount": amount, "type": "expense",
                     "sequence": 1, "order": len(base) + i, "name": "Unexpected Expense"}
                )
    return forecast(start, as_of, _ordered(scenario))


def run_scenario(scenario: Dict[str, Any]) -> Dict[str, Any]:
    """Run one canonical scenario, returning a canonical result. Raises ContractError."""
    events, as_of, horizon, window_end = expand(scenario)
    base = _ordered(events)
    result: Dict[str, Any] = {
        # Echo the scenario's declared version so a 1.0 scenario stays byte-identical
        # (see contracts/timeline.md, "Result contract version").
        "contract_version": scenario.get("contract_version", CONTRACT_VERSION),
        "scenario_id": scenario.get("scenario_id", ""),
        "forecast": forecast(int(scenario["starting_balance_cents"]), as_of, base),
    }
    simulation = scenario.get("simulation")
    if simulation is None:
        return result

    start = int(scenario["starting_balance_cents"])
    p = _params(simulation)
    rng = SplitMix64(p["seed"])
    endings: List[int] = []
    minimums: List[int] = []
    negative_runs = 0
    for _ in range(p["runs"]):
        r = _simulate_once(base, start, as_of, horizon, window_end, p, rng)
        endings.append(r["ending_balance_cents"])
        minimums.append(r["minimum_balance_cents"])
        if r["first_negative_date"] is not None:
            negative_runs += 1
    endings.sort()
    minimums.sort()

    def pct(values: List[int], num: int, den: int) -> int:
        return nearest_rank(values, num, den)

    result["risk"] = {
        "negative_balance_probability_ppm": round_half_away(negative_runs * 1_000_000, p["runs"]),
        "minimum_balance_p10_cents": pct(minimums, 1, 10),
        "minimum_balance_p50_cents": pct(minimums, 1, 2),
        "minimum_balance_p90_cents": pct(minimums, 9, 10),
        "ending_balance_p10_cents": pct(endings, 1, 10),
        "ending_balance_p50_cents": pct(endings, 1, 2),
        "ending_balance_p90_cents": pct(endings, 9, 10),
        "projected_low_point_cents": result["forecast"]["minimum_balance_cents"],
        "safe_to_spend_cents": pct(minimums, p["quantile_num"], p["quantile_den"]) - p["reserve_cents"],
    }
    return result


def run_scenario_safe(scenario: Dict[str, Any]) -> Dict[str, Any]:
    """Like run_scenario but returns {"error": CODE} instead of raising."""
    try:
        return run_scenario(scenario)
    except ContractError as exc:
        return {"error": exc.code}
