"""Structured scenario API (MC-04).

Builds a canonical Contract-1.0 scenario from persisted state. This is the single
bridge from the database to the contract engine; it contains no financial math of
its own and it never reads a clock -- ``as_of`` is always an explicit input.
"""

from __future__ import annotations

import calendar
from datetime import date, timedelta
from typing import Any, Dict, List, Optional

from . import budget_engine, db_manager
from .contract import CONTRACT_VERSION, ContractError, recurrence_dates

_INCOME_FREQUENCY = {
    "Weekly": "weekly",
    "Bi-weekly": "biweekly",
    "Monthly": "monthly",
    "One-time": "onetime",
}


def _income_recurrence(inc: db_manager.IncomeSource) -> Dict[str, Any]:
    """Map a persisted income row to canonical recurrence fields (MCD-0022).

    The anchor is the day of ``last_payday`` (the original schedule anchor), not
    the day of the possibly month-end-clamped ``next_payday``. A stored next
    payday that does not match the anchored (possibly clamped) date was moved
    deliberately, so it becomes the new anchor.
    """
    try:
        last = date.fromisoformat(inc.last_payday)
        start = date.fromisoformat(inc.next_payday)
    except (TypeError, ValueError) as exc:
        raise ContractError(
            "INVALID_DATE", f"income {inc.name!r} has an invalid payday"
        ) from exc

    frequency = _INCOME_FREQUENCY.get(inc.frequency)
    if frequency is None:
        raise ContractError(
            "INVALID_FREQUENCY", f"income {inc.name!r}: {inc.frequency!r}"
        )

    rec: Dict[str, Any] = {"frequency": frequency, "start_date": start.isoformat()}
    if frequency == "monthly":
        anchor = last.day
        clamped = min(anchor, calendar.monthrange(start.year, start.month)[1])
        if start.day != clamped:
            anchor = start.day
        rec["anchor_day"] = anchor
    return rec


def _income_events(as_of: date, window_end: date) -> List[Dict[str, Any]]:
    """Materialize in-window income occurrences with a stable anchor (MCD-0002, MCD-0022)."""
    events: List[Dict[str, Any]] = []
    for inc in db_manager.get_all_income():
        dates = recurrence_dates(_income_recurrence(inc), window_end)
        first_in_window = True
        for occurrence in dates:
            if occurrence < as_of:
                continue
            amount = inc.amount
            if first_in_window and inc.expected_amount is not None:
                amount = inc.expected_amount
            events.append({
                "date": occurrence.isoformat(),
                "amount_cents": int(amount),
                "type": "income",
                "name": inc.name,
            })
            first_in_window = False
    return events


def _bill_events_rw(as_of: date, window_end: date) -> List[Dict[str, Any]]:
    """Materialize in-window unpaid bill occurrences. Overdue (< as_of) is excluded (MCD-0014)."""
    db_manager.sync_bill_occurrences(as_of.isoformat(), window_end.isoformat())
    occurrences = db_manager.get_unpaid_occurrences(as_of.isoformat(), window_end.isoformat())
    events: List[Dict[str, Any]] = []
    lo, hi = as_of.isoformat(), window_end.isoformat()
    for occ in occurrences:
        if occ.amount is None or occ.name is None:
            continue
        if lo <= occ.due_date < hi:
            events.append({
                "date": occ.due_date,
                "amount_cents": -int(occ.amount),
                "type": "expense",
                "name": occ.name,
            })
    return events


def _bill_events_readonly(as_of: date, window_end: date) -> List[Dict[str, Any]]:
    """Project in-window unpaid bills in-memory (no writes), half-open ``[as_of, window_end)``."""
    payments = db_manager.get_all_payments()
    pmt_dicts = [dict(vars(p)) for p in payments]
    schedule = budget_engine.get_upcoming_schedule(
        pmt_dicts, as_of.isoformat(), window_end.isoformat()
    )
    with db_manager.get_db_connection() as conn:
        paid = conn.execute(
            "SELECT payment_id, due_date FROM bill_occurrences "
            "WHERE paid = 1 AND due_date >= ? AND due_date <= ?",
            (as_of.isoformat(), window_end.isoformat()),
        ).fetchall()
    paid_set = {(r["payment_id"], r["due_date"]) for r in paid}
    hi = window_end.isoformat()
    events: List[Dict[str, Any]] = []
    for item in schedule:
        if item["date"] >= hi:  # enforce half-open even though the helper is inclusive
            continue
        if (item["payment_id"], item["date"]) in paid_set:
            continue
        events.append({
            "date": item["date"],
            "amount_cents": -int(item["amount"]),
            "type": "expense",
            "name": item["name"],
        })
    return events


def _bill_events(as_of: date, window_end: date, read_only: bool) -> List[Dict[str, Any]]:
    return _bill_events_readonly(as_of, window_end) if read_only else _bill_events_rw(as_of, window_end)


def build_scenario(
    as_of: str,
    horizon_days: int = 90,
    include_simulation: Optional[Dict[str, Any]] = None,
    read_only: bool = False,
) -> Dict[str, Any]:
    """Return a canonical scenario for the given explicit ``as_of`` (YYYY-MM-DD)."""
    start = date.fromisoformat(as_of)
    window_end = start + timedelta(days=horizon_days)
    events = _bill_events(start, window_end, read_only) + _income_events(start, window_end)
    scenario: Dict[str, Any] = {
        "contract_version": CONTRACT_VERSION,
        "scenario_id": f"db-{as_of}-{horizon_days}",
        "as_of": as_of,
        "starting_balance_cents": db_manager.get_ledger_balance(),
        "horizon_days": horizon_days,
        "events": events,
    }
    if include_simulation is not None:
        scenario["simulation"] = include_simulation
    return scenario
