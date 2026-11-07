"""Goal-oriented decision operations (MC-04).

Every operation maps to a canonical scenario transformation and delegates the
financial conclusion to the contract engine. No operation performs financial math
here; the engine owns the answer (MCD-0006..0010).
"""

from __future__ import annotations

import copy
from datetime import date, timedelta
from typing import Any, Dict, List, Optional

from . import db_manager
from . import scenario as scenario_mod
from .contract import CONTRACT_VERSION, ContractError, run_scenario
from .contract.engine import SIMULATION_DEFAULTS, SUPPORTED_CONTRACT_VERSIONS
from .contract.money import MAX_MONEY_CENTS

DEFAULT_HORIZON_DAYS = 90
DEFAULT_SIM: Dict[str, int] = {"runs": 500, "seed": 42}

# Central execution bounds shared by the MCP-ready surface and the local HTTP API.
# Programmatic callers get the same protection as unauthenticated HTTP clients.
MAX_HORIZON_DAYS = 3650
MAX_RUNS = 10_000
MAX_QUANTILE = 1_000
MAX_RESERVE_CENTS = 10**12
MAX_AMOUNT_CENTS = 10**12


def _sim(overrides: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    merged: Dict[str, Any] = dict(SIMULATION_DEFAULTS)
    merged.update(DEFAULT_SIM)
    if overrides:
        merged.update(overrides)
    _validate_sim(merged)
    return merged


def _require_int_field(value: Any, field: str, code: str, *, minimum: int, maximum: int) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < minimum or value > maximum:
        raise ContractError(code, f"{field} must be an integer in [{minimum}, {maximum}], got {value!r}")
    return value


def _validate_sim(params: Dict[str, Any]) -> None:
    """Validate simulation parameters before they reach the engine or a PRNG."""
    _require_int_field(params.get("runs"), "runs", "INVALID_RUNS", minimum=1, maximum=MAX_RUNS)
    _require_int_field(params.get("seed"), "seed", "INVALID_SEED", minimum=0, maximum=2**63 - 1)
    num = _require_int_field(
        params.get("quantile_num"), "quantile_num", "INVALID_QUANTILE", minimum=1, maximum=MAX_QUANTILE
    )
    den = _require_int_field(
        params.get("quantile_den"), "quantile_den", "INVALID_QUANTILE", minimum=1, maximum=MAX_QUANTILE
    )
    if num > den:
        raise ContractError("INVALID_QUANTILE", f"quantile_num {num} exceeds quantile_den {den}")
    _require_int_field(
        params.get("reserve_cents"),
        "reserve_cents",
        "INVALID_AMOUNT",
        minimum=0,
        maximum=MAX_RESERVE_CENTS,
    )


def _require_horizon(horizon_days: Any) -> int:
    return _require_int_field(
        horizon_days,
        "horizon_days",
        "INVALID_HORIZON",
        minimum=0,
        maximum=MAX_HORIZON_DAYS,
    )


def _require_date(value: Any, field: str) -> str:
    """Reject an invalid date with a typed error instead of letting it change meaning."""
    if not isinstance(value, str):
        raise ContractError("INVALID_DATE", f"{field} must be an ISO date string, got {value!r}")
    try:
        date.fromisoformat(value)
    except ValueError as exc:
        raise ContractError("INVALID_DATE", f"{field} {value!r}: {exc}") from exc
    return value


def _require_positive_int(value: Any, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
        raise ContractError("INVALID_AMOUNT", f"{field} must be a positive integer, got {value!r}")
    return value


def _require_non_negative_int(value: Any, field: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ContractError("INVALID_AMOUNT", f"{field} must be a non-negative integer, got {value!r}")
    return value


def _view_for(as_of: str, horizon_days: int) -> Dict[str, Any]:
    """One consistent read snapshot for both calculation and provenance."""
    start = date.fromisoformat(as_of)
    window_end = start + timedelta(days=horizon_days)
    return db_manager.read_ledger_view(start.isoformat(), window_end.isoformat())


def _build(
    as_of: str,
    horizon_days: int,
    sim: Optional[Dict[str, Any]] = None,
    ledger: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Build a canonical scenario for a decision operation.

    Deliberately ``read_only=True``: every operation on this surface is read-only or
    purely hypothetical, so it must not generate or mutate bill occurrences in the
    database as a side effect of being asked a question. ``ledger`` is a consistent
    read view shared by the baseline and comparison runs of one operation.
    """
    if ledger is None:
        ledger = _view_for(as_of, horizon_days)
    if sim is None:
        return scenario_mod.build_scenario(as_of, horizon_days, read_only=True, ledger=ledger)
    return scenario_mod.build_scenario(
        as_of, horizon_days, include_simulation=sim, read_only=True, ledger=ledger
    )


def _ledger_status(
    view: Optional[Dict[str, Any]] = None,
    *,
    as_of: Optional[str] = None,
    horizon_days: Optional[int] = None,
    sim: Optional[Dict[str, Any]] = None,
    hypothetical: bool = True,
) -> Dict[str, Any]:
    """Provenance for every decision result: source, consistency and reconciliation.

    The forecast itself always uses the authoritative transaction sum; this block
    tells a caller whether the stored cache and the optional bank balance agree, so
    an unexplained difference is visible rather than presented as spendable cash.
    When ``view`` is supplied, every value here comes from the same read snapshot as
    the calculation.
    """
    if view is None:
        is_sync, ledger, stored = db_manager.validate_balance_consistency()
        stats = db_manager.get_ledger_stats()
        with db_manager.get_db_connection() as conn:
            row = conn.execute(
                "SELECT value FROM settings WHERE key = 'bank_balance_cents'"
            ).fetchone()
        bank = int(row["value"]) if row and row["value"] is not None else None
        counts = {
            "transaction_count": stats["transaction_count"],
            "income_source_count": stats["income_source_count"],
            "payment_count": stats["payment_count"],
            "newest_transaction_date": stats["newest_date"],
        }
    else:
        ledger = view["ledger_balance_cents"]
        stored = view["stored_balance_cents"]
        bank = view["bank_balance_cents"]
        is_sync = ledger == stored
        counts = {
            "transaction_count": view["counts"]["transaction_count"],
            "income_source_count": view["counts"]["income_source_count"],
            "payment_count": view["counts"]["payment_count"],
            "newest_transaction_date": view["counts"]["newest_date"],
        }

    status: Dict[str, Any] = {
        "source": "local sqlite ledger",
        "contract_version": CONTRACT_VERSION,
        "read_only": True,
        "hypothetical": hypothetical,
        "balance_consistent": bool(is_sync),
        "ledger_balance_cents": ledger,
        "stored_balance_cents": stored,
        # The cache is what older clients display; it is exposed separately so a
        # discrepancy is never mistaken for spendable cash.
        "cached_balance_cents": stored,
        "bank_balance_cents": bank,
        "reconciled_with_bank": bool(bank is not None and bank == ledger),
        "snapshot": counts,
        "model": {
            "basis": "canonical Contract 2.0 deterministic projection + SplitMix64 Monte Carlo",
            "assumptions": (
                "Synthetic scenario derived from persisted ledger data; no historical "
                "calibration is applied and probabilities are model estimates, not forecasts."
            ),
        },
    }
    if as_of is not None:
        status["as_of"] = as_of
    if horizon_days is not None:
        status["horizon_days"] = horizon_days
    if sim is not None:
        status["simulation"] = {"runs": sim.get("runs"), "seed": sim.get("seed")}
    return status


def _attach_ledger(
    result: Dict[str, Any],
    *,
    as_of: Optional[str] = None,
    horizon_days: Optional[int] = None,
    sim: Optional[Dict[str, Any]] = None,
    view: Optional[Dict[str, Any]] = None,
    hypothetical: bool = True,
) -> Dict[str, Any]:
    result = dict(result)
    result["ledger"] = _ledger_status(
        view, as_of=as_of, horizon_days=horizon_days, sim=sim, hypothetical=hypothetical
    )
    return result


def forecast(as_of: str, horizon_days: int = DEFAULT_HORIZON_DAYS) -> Dict[str, Any]:
    """Deterministic forecast only (no simulation)."""
    _require_date(as_of, "as_of")
    _require_horizon(horizon_days)
    view = _view_for(as_of, horizon_days)
    return _attach_ledger(
        run_scenario(_build(as_of, horizon_days, ledger=view)),
        as_of=as_of,
        horizon_days=horizon_days,
        view=view,
        hypothetical=False,
    )


def risk(
    as_of: str,
    horizon_days: int = DEFAULT_HORIZON_DAYS,
    sim: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Forecast + Monte Carlo risk block."""
    _require_date(as_of, "as_of")
    _require_horizon(horizon_days)
    params = _sim(sim)
    view = _view_for(as_of, horizon_days)
    return _attach_ledger(
        run_scenario(_build(as_of, horizon_days, params, ledger=view)),
        as_of=as_of,
        horizon_days=horizon_days,
        sim=params,
        view=view,
        hypothetical=False,
    )


def _shift_first_income(scenario: Dict[str, Any], days: int) -> None:
    incomes = sorted(
        (e for e in scenario["events"] if e["type"] == "income"),
        key=lambda e: e["date"],
    )
    if not incomes:
        return
    target = incomes[0]
    target["date"] = (date.fromisoformat(target["date"]) + timedelta(days=days)).isoformat()


def simulate_purchase(
    amount_cents: int,
    purchase_date: str,
    as_of: str,
    horizon_days: int = DEFAULT_HORIZON_DAYS,
    sim: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Compare baseline vs a one-time purchase on ``purchase_date``.

    Expense variation is forced off so the only difference between the two runs is
    the purchase itself (the purchase event consumes no RNG draws).
    """
    _require_positive_int(amount_cents, "amount_cents")
    if amount_cents > MAX_AMOUNT_CENTS:
        raise ContractError("INVALID_AMOUNT", f"amount_cents exceeds {MAX_AMOUNT_CENTS}")
    _require_date(purchase_date, "purchase_date")
    _require_date(as_of, "as_of")
    _require_horizon(horizon_days)
    overrides = dict(sim or {})
    overrides.setdefault("expense_variation_min", 0)
    overrides.setdefault("expense_variation_max", 0)
    params = _sim(overrides)
    view = _view_for(as_of, horizon_days)

    baseline = run_scenario(_build(as_of, horizon_days, dict(params), ledger=view))
    with_purchase_scenario = _build(as_of, horizon_days, dict(params), ledger=view)
    with_purchase_scenario["events"].append({
        "date": purchase_date,
        "amount_cents": -amount_cents,
        "type": "expense",
        "name": "Planned purchase",
    })
    with_purchase = run_scenario(with_purchase_scenario)
    return _attach_ledger(
        {
            "baseline": baseline,
            "with_purchase": with_purchase,
            "change": {
                "negative_balance_probability_ppm": (
                    with_purchase["risk"]["negative_balance_probability_ppm"]
                    - baseline["risk"]["negative_balance_probability_ppm"]
                ),
                "minimum_balance_p10_cents": (
                    with_purchase["risk"]["minimum_balance_p10_cents"]
                    - baseline["risk"]["minimum_balance_p10_cents"]
                ),
                "safe_to_spend_cents": (
                    with_purchase["risk"]["safe_to_spend_cents"]
                    - baseline["risk"]["safe_to_spend_cents"]
                ),
            },
        },
        as_of=as_of,
        horizon_days=horizon_days,
        sim=params,
        view=view,
        hypothetical=True,
    )


def simulate_paycheck_delay(
    delay_days: int,
    as_of: str,
    horizon_days: int = DEFAULT_HORIZON_DAYS,
    sim: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Compare baseline vs the next in-window paycheck arriving ``delay_days`` late."""
    _require_date(as_of, "as_of")
    _require_horizon(horizon_days)
    if not isinstance(delay_days, int) or isinstance(delay_days, bool) or delay_days < 0:
        raise ContractError("INVALID_HORIZON", f"delay_days must be a non-negative integer, got {delay_days!r}")
    params = _sim(sim)
    view = _view_for(as_of, horizon_days)
    baseline = run_scenario(_build(as_of, horizon_days, dict(params), ledger=view))
    delayed_scenario = _build(as_of, horizon_days, dict(params), ledger=view)
    _shift_first_income(delayed_scenario, delay_days)
    delayed = run_scenario(delayed_scenario)
    return _attach_ledger(
        {
            "baseline": baseline,
            "delayed": delayed,
            "change": {
                "minimum_balance_p10_cents": (
                    delayed["risk"]["minimum_balance_p10_cents"]
                    - baseline["risk"]["minimum_balance_p10_cents"]
                ),
                "negative_balance_probability_ppm": (
                    delayed["risk"]["negative_balance_probability_ppm"]
                    - baseline["risk"]["negative_balance_probability_ppm"]
                ),
            },
        },
        as_of=as_of,
        horizon_days=horizon_days,
        sim=params,
        view=view,
        hypothetical=True,
    )


_COMPARE_EVENT_FIELDS = frozenset(
    {"date", "amount_cents", "type", "name", "sequence", "category"}
)


def _validate_compare_events(
    events: Any, field: str, as_of: str, horizon_days: int
) -> List[Dict[str, Any]]:
    """Validate a caller-supplied canonical event list.

    A dictionary container used to be passed to ``list.extend``, which iterated its
    keys and silently produced garbage. Inputs must be a list of canonical event
    objects, fully validated before the engine sees them.
    """
    if not isinstance(events, list):
        raise ContractError(
            "SCHEMA_INVALID",
            f"{field} must be a list of canonical event objects, got {type(events).__name__}",
        )
    start = date.fromisoformat(as_of)
    window_end = start + timedelta(days=horizon_days)
    seen = set()
    validated: List[Dict[str, Any]] = []
    for index, event in enumerate(events):
        path = f"{field}[{index}]"
        if not isinstance(event, dict):
            raise ContractError("SCHEMA_INVALID", f"{path} must be an object")
        unknown = set(event) - _COMPARE_EVENT_FIELDS
        if unknown:
            raise ContractError(
                "SCHEMA_INVALID", f"{path} has unsupported fields: {sorted(unknown)}"
            )
        event_date = _require_date(event.get("date"), f"{path}.date")
        event_day = date.fromisoformat(event_date)
        if event_day < start or event_day >= window_end:
            raise ContractError(
                "EVENT_OUT_OF_HORIZON",
                f"{path}.date {event_date!r} is outside [{as_of}, {window_end.isoformat()})",
            )
        amount = event.get("amount_cents")
        if not isinstance(amount, int) or isinstance(amount, bool):
            raise ContractError("INVALID_AMOUNT", f"{path}.amount_cents must be an integer")
        if abs(amount) > MAX_MONEY_CENTS:
            raise ContractError("MONEY_OVERFLOW", f"{path}.amount_cents")
        etype = event.get("type")
        if etype == "income" and amount <= 0:
            raise ContractError("INVALID_AMOUNT", f"{path}: income must be positive")
        if etype == "expense" and amount >= 0:
            raise ContractError("INVALID_AMOUNT", f"{path}: expense must be negative")
        if etype == "adjustment" and amount == 0:
            raise ContractError("INVALID_AMOUNT", f"{path}: zero adjustment")
        if etype not in ("income", "expense", "adjustment"):
            raise ContractError("INVALID_EVENT_TYPE", f"{path}.type {etype!r}")
        name = event.get("name")
        if name is not None and not isinstance(name, str):
            raise ContractError("SCHEMA_INVALID", f"{path}.name must be a string")
        sequence = event.get("sequence")
        if sequence is not None and (
            not isinstance(sequence, int) or isinstance(sequence, bool)
        ):
            raise ContractError("SCHEMA_INVALID", f"{path}.sequence must be an integer")
        category = event.get("category")
        if category is not None and not isinstance(category, str):
            raise ContractError("SCHEMA_INVALID", f"{path}.category must be a string")

        signature = (event_date, amount, etype, name)
        if signature in seen:
            # An identical duplicate is ambiguous (two bills or an accidental copy?)
            # and would silently double-count.
            raise ContractError(
                "SCHEMA_INVALID", f"{path} duplicates an earlier event exactly"
            )
        seen.add(signature)
        validated.append(dict(event))
    return validated


def compare_scenarios(
    first: List[Dict[str, Any]],
    second: List[Dict[str, Any]],
    as_of: str,
    horizon_days: int = DEFAULT_HORIZON_DAYS,
    sim: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Run two caller-supplied canonical event lists over the same base state.

    ``first``/``second`` are typed lists of canonical event objects. Malformed input
    raises a ``ContractError``; it is never coerced or partially applied.
    """
    _require_date(as_of, "as_of")
    _require_horizon(horizon_days)
    params = _sim(sim)
    first_events = _validate_compare_events(first, "first", as_of, horizon_days)
    second_events = _validate_compare_events(second, "second", as_of, horizon_days)
    view = _view_for(as_of, horizon_days)
    results: List[Dict[str, Any]] = []
    for extra_events in (first_events, second_events):
        scenario = _build(as_of, horizon_days, dict(params), ledger=view)
        scenario["events"].extend(extra_events)
        results.append(run_scenario(scenario))
    a, b = results
    return _attach_ledger(
        {
            "first": a,
            "second": b,
            "change": {
                "negative_balance_probability_ppm": (
                    b["risk"]["negative_balance_probability_ppm"]
                    - a["risk"]["negative_balance_probability_ppm"]
                ),
                "minimum_balance_p10_cents": (
                    b["risk"]["minimum_balance_p10_cents"]
                    - a["risk"]["minimum_balance_p10_cents"]
                ),
                "safe_to_spend_cents": (
                    b["risk"]["safe_to_spend_cents"] - a["risk"]["safe_to_spend_cents"]
                ),
            },
        },
        as_of=as_of,
        horizon_days=horizon_days,
        sim=params,
        view=view,
        hypothetical=True,
    )


def overdraft_risk(
    as_of: str,
    horizon_days: int = DEFAULT_HORIZON_DAYS,
    sim: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Interpretable overdraft summary derived from the canonical risk block."""
    result = risk(as_of, horizon_days, sim)
    forecast = result["forecast"]
    risk_block = result["risk"]
    return {
        "as_of": as_of,
        "horizon_days": horizon_days,
        "projected_low_point_cents": forecast["minimum_balance_cents"],
        "projected_low_point_date": forecast["minimum_balance_date"],
        "first_negative_date": forecast["first_negative_date"],
        "negative_balance_probability_ppm": risk_block["negative_balance_probability_ppm"],
        "minimum_balance_p10_cents": risk_block["minimum_balance_p10_cents"],
        "safe_to_spend_cents": risk_block["safe_to_spend_cents"],
        "forecast": forecast,
        "risk": risk_block,
        # Reuse the provenance produced by the same operation instead of re-reading
        # the ledger, which could describe a different revision.
        "ledger": result["ledger"],
    }


# ---------------------------------------------------------------------------
# MCP-ready structured surface (docs/MCP_READINESS.md)
#
# These operations exist so a future MCP adapter can be thin: each returns a
# stable, versioned, JSON-serialisable structure produced by the canonical
# engine, or raises a typed error — it never returns a fabricated number. All
# of them are read-only or purely hypothetical (no ledger writes, no sync).


def financial_snapshot() -> Dict[str, Any]:
    """Balances, reconciliation state and data freshness for the local ledger.

    Read-only. Exposes no transaction details — only balances, counts and the
    newest ledger date so a caller can judge freshness.
    """
    meta = db_manager.read_ledger_metadata()
    ledger_balance = meta["ledger_balance_cents"]
    stored_balance = meta["stored_balance_cents"]
    bank_balance = meta["bank_balance_cents"]
    return {
        "ledger_balance_cents": ledger_balance,
        "stored_balance_cents": stored_balance,
        "cached_balance_cents": stored_balance,
        "bank_balance_cents": bank_balance,
        "reconciled_with_bank": bool(bank_balance is not None and bank_balance == ledger_balance),
        "balance_consistent": bool(ledger_balance == stored_balance),
        "counts": {
            "transactions": meta["counts"]["transaction_count"],
            "income_sources": meta["counts"]["income_source_count"],
            "payments": meta["counts"]["payment_count"],
        },
        "newest_transaction_date": meta["counts"]["newest_date"],
        # A future adapter must present this basis, not just the numbers.
        "data_source": "local sqlite ledger (monte_carlo_ledger/db_manager)",
        "source": "local sqlite ledger",
        "contract_version": CONTRACT_VERSION,
        "read_only": True,
        "hypothetical": False,
    }


def compare_debt_strategies(
    liabilities: List[Dict[str, Any]],
    as_of: str,
    extra_monthly_payment_cents: int = 0,
) -> Dict[str, Any]:
    """Compare canonical snowball vs avalanche payoff for the same liabilities.

    Deterministic amortization only. The result explicitly states that these
    payments are NOT injected into the cash-flow forecast: affordability of an
    extra payment must be checked with simulate_purchase/forecast separately.
    """
    if not isinstance(liabilities, list) or not liabilities:
        raise ContractError("SCHEMA_INVALID", "liabilities must be a non-empty array")
    _require_date(as_of, "as_of")
    # Negative extra payments are invalid input, not "zero extra": silently clamping would
    # change the caller's meaning and could understate the payoff cost.
    _require_non_negative_int(extra_monthly_payment_cents, "extra_monthly_payment_cents")
    view = _view_for(as_of, DEFAULT_HORIZON_DAYS)
    results: Dict[str, Any] = {}
    for strategy in ("snowball", "avalanche"):
        scenario = _build(as_of, DEFAULT_HORIZON_DAYS, ledger=view)
        scenario["liabilities"] = copy.deepcopy(liabilities)
        scenario["debt_strategy"] = strategy
        scenario["extra_monthly_payment_cents"] = extra_monthly_payment_cents
        results[strategy] = run_scenario(scenario)["debt"]
    return _attach_ledger(
        {
            "as_of": as_of,
            "strategies": results,
            # Honest interplay note: amortization and cash flow are separate models.
            "cash_flow_note": (
                "Deterministic payoff schedules only; these payments are not included in the "
                "cash-flow forecast or overdraft estimate. Affordability of any extra payment "
                "must be validated separately via simulate_purchase/forecast."
            ),
        },
        as_of=as_of,
        horizon_days=DEFAULT_HORIZON_DAYS,
        view=view,
        hypothetical=True,
    )


def validate_scenario(scenario: Dict[str, Any]) -> Dict[str, Any]:
    """Structurally and semantically validate a canonical scenario without side effects.

    Mirrors the cross-engine pipeline: JSON-schema first (SCHEMA_INVALID), then a typed
    engine dry-run. Returns a machine-readable verdict; never raises for invalid input.

    Fail-closed by construction: ``valid`` is true only when the schema was actually
    checked, the document passed it, and the engine evaluated it without error. A missing
    validation dependency is reported as ``VALIDATION_UNAVAILABLE`` — never as success.
    """
    import json
    import pathlib

    errors: List[Dict[str, str]] = []

    def verdict() -> Dict[str, Any]:
        return {
            "valid": bool(
                schema_checked and schema_valid and engine_evaluated and not errors
            ),
            "schema_checked": schema_checked,
            "schema_valid": schema_valid,
            "engine_evaluated": engine_evaluated,
            "errors": errors,
        }

    schema_checked = False
    schema_valid = False
    engine_evaluated = False

    if not isinstance(scenario, dict):
        errors.append({
            "code": "SCHEMA_INVALID",
            "path": "(root)",
            "message": f"scenario must be an object, got {type(scenario).__name__}",
        })
        return verdict()

    try:
        import jsonschema
    except ImportError:
        errors.append({
            "code": "VALIDATION_UNAVAILABLE",
            "path": "(schema)",
            "message": (
                "jsonschema is not installed, so schema validation cannot run; "
                "the scenario is NOT validated"
            ),
        })
        return verdict()

    # Load the schema shipped inside the package. Resolving it relative to the repository root
    # (parents[1]) works only in a source checkout; a real wheel has no `schemas/` there.
    schema_path = pathlib.Path(__file__).resolve().parent / "schemas" / "scenario.schema.json"
    schema_checked = True
    try:
        schema = json.loads(schema_path.read_text())
        # Deliberately no FormatChecker: the cross-engine pipeline treats `format: date` as
        # annotation-only and lets the engine reject malformed dates (INVALID_DATE), so both
        # paths classify the same corpus identically.
        validator = jsonschema.Draft202012Validator(schema)
        schema_errors = sorted(validator.iter_errors(scenario), key=lambda e: list(e.absolute_path))
    except (OSError, json.JSONDecodeError) as exc:
        # A missing/corrupt schema is an engine-environment failure, not a valid scenario.
        errors.append({
            "code": "VALIDATION_UNAVAILABLE",
            "path": "(schema)",
            "message": f"scenario schema could not be loaded: {exc}",
        })
        return verdict()

    for err in schema_errors:
        errors.append({
            "code": "SCHEMA_INVALID",
            "path": ".".join(str(p) for p in err.absolute_path) or "(root)",
            "message": err.message,
        })
    schema_valid = not schema_errors

    if schema_valid:
        engine_evaluated = True
        try:
            run_scenario(scenario)
        except ContractError as exc:
            errors.append({"code": exc.code, "path": "(engine)", "message": str(exc)})
        except (KeyError, TypeError, ValueError, OverflowError, ArithmeticError) as exc:
            errors.append({"code": "INTERNAL_ERROR", "path": "(engine)", "message": str(exc)})

    return verdict()


def engine_capabilities() -> Dict[str, Any]:
    """Static descriptor of what this engine supports (contract version, bounds, operations)."""
    from . import contract

    return {
        "contract_version": contract.CONTRACT_VERSION,
        "supported_contract_versions": list(SUPPORTED_CONTRACT_VERSIONS),
        "operations": [
            "forecast", "risk", "overdraft_risk", "safe_to_spend",
            "simulate_purchase", "simulate_paycheck_delay", "compare_scenarios",
            "compare_debt_strategies", "financial_snapshot", "validate_scenario",
            "engine_capabilities",
        ],
        "money": {"unit": "cents", "currency": "USD", "single_currency": True,
                  "overflow_is_error": True},
        "time": {"as_of_required": True, "horizon_half_open": True},
        "simulation": dict(DEFAULT_SIM),
        "limits": {
            "max_horizon_days": MAX_HORIZON_DAYS,
            "max_runs": MAX_RUNS,
            "max_quantile": MAX_QUANTILE,
            "max_reserve_cents": MAX_RESERVE_CENTS,
            "max_amount_cents": MAX_AMOUNT_CENTS,
        },
        "provenance": {
            "field": "ledger",
            "operations": [
                "forecast", "risk", "overdraft_risk", "safe_to_spend",
                "simulate_purchase", "simulate_paycheck_delay", "compare_scenarios",
                "compare_debt_strategies", "financial_snapshot",
            ],
            "read_only": True,
        },
        "validation": {
            "operation": "validate_scenario",
            "fail_closed": True,
            "schema_dependency": "jsonschema>=4.0 (runtime dependency)",
            "verdict_fields": [
                "valid", "schema_checked", "schema_valid", "engine_evaluated", "errors",
            ],
            "failure_codes": [
                "SCHEMA_INVALID", "VALIDATION_UNAVAILABLE", "INTERNAL_ERROR",
                "MONEY_OVERFLOW", "INVALID_DATE", "INVALID_AMOUNT", "INVALID_HORIZON",
                "INVALID_EVENT_TYPE", "INVALID_FREQUENCY", "INVALID_RUNS", "MISSING_AS_OF",
                "INVALID_SEED", "INVALID_QUANTILE", "EVENT_OUT_OF_HORIZON",
            ],
        },
        "writes": {"allowed": False},
    }
