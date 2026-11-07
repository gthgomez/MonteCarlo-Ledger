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
from .contract import ContractError, run_scenario
from .contract.engine import SUPPORTED_CONTRACT_VERSIONS

DEFAULT_HORIZON_DAYS = 90
DEFAULT_SIM: Dict[str, int] = {"runs": 500, "seed": 42}


def _sim(overrides: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    merged: Dict[str, Any] = dict(DEFAULT_SIM)
    if overrides:
        merged.update(overrides)
    return merged


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


def _build(
    as_of: str,
    horizon_days: int,
    sim: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Build a canonical scenario for a decision operation.

    Deliberately ``read_only=True``: every operation on this surface is read-only or
    purely hypothetical, so it must not generate or mutate bill occurrences in the
    database as a side effect of being asked a question.
    """
    if sim is None:
        return scenario_mod.build_scenario(as_of, horizon_days, read_only=True)
    return scenario_mod.build_scenario(
        as_of, horizon_days, include_simulation=sim, read_only=True
    )


def _ledger_status() -> Dict[str, Any]:
    """Provenance for every decision result: source, consistency and reconciliation.

    The forecast itself always uses the authoritative transaction sum; this block
    tells a caller whether the stored cache and the optional bank balance agree, so
    an unexplained difference is visible rather than presented as spendable cash.
    """
    is_sync, ledger, stored = db_manager.validate_balance_consistency()
    with db_manager.get_db_connection() as conn:
        row = conn.execute(
            "SELECT value FROM settings WHERE key = 'bank_balance_cents'"
        ).fetchone()
    bank = int(row["value"]) if row and row["value"] is not None else None
    return {
        "source": "local sqlite ledger",
        "read_only": True,
        "balance_consistent": bool(is_sync),
        "ledger_balance_cents": ledger,
        "stored_balance_cents": stored,
        "bank_balance_cents": bank,
        "reconciled_with_bank": bool(bank is not None and bank == ledger),
    }


def _attach_ledger(result: Dict[str, Any]) -> Dict[str, Any]:
    result = dict(result)
    result["ledger"] = _ledger_status()
    return result


def forecast(as_of: str, horizon_days: int = DEFAULT_HORIZON_DAYS) -> Dict[str, Any]:
    """Deterministic forecast only (no simulation)."""
    _require_date(as_of, "as_of")
    return _attach_ledger(run_scenario(_build(as_of, horizon_days)))


def risk(
    as_of: str,
    horizon_days: int = DEFAULT_HORIZON_DAYS,
    sim: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Forecast + Monte Carlo risk block."""
    _require_date(as_of, "as_of")
    return _attach_ledger(run_scenario(_build(as_of, horizon_days, _sim(sim))))


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
    _require_date(purchase_date, "purchase_date")
    _require_date(as_of, "as_of")
    overrides = dict(sim or {})
    overrides.setdefault("expense_variation_min", 0)
    overrides.setdefault("expense_variation_max", 0)
    params = _sim(overrides)

    baseline = run_scenario(_build(as_of, horizon_days, dict(params)))
    with_purchase_scenario = _build(as_of, horizon_days, dict(params))
    with_purchase_scenario["events"].append({
        "date": purchase_date,
        "amount_cents": -amount_cents,
        "type": "expense",
        "name": "Planned purchase",
    })
    with_purchase = run_scenario(with_purchase_scenario)
    return {
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
        "ledger": _ledger_status(),
    }


def simulate_paycheck_delay(
    delay_days: int,
    as_of: str,
    horizon_days: int = DEFAULT_HORIZON_DAYS,
    sim: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Compare baseline vs the next in-window paycheck arriving ``delay_days`` late."""
    _require_date(as_of, "as_of")
    if not isinstance(delay_days, int) or isinstance(delay_days, bool) or delay_days < 0:
        raise ContractError("INVALID_HORIZON", f"delay_days must be a non-negative integer, got {delay_days!r}")
    params = _sim(sim)
    baseline = run_scenario(_build(as_of, horizon_days, dict(params)))
    delayed_scenario = _build(as_of, horizon_days, dict(params))
    _shift_first_income(delayed_scenario, delay_days)
    delayed = run_scenario(delayed_scenario)
    return {
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
        "ledger": _ledger_status(),
    }


def compare_scenarios(
    first: Dict[str, Any],
    second: Dict[str, Any],
    as_of: str,
    horizon_days: int = DEFAULT_HORIZON_DAYS,
    sim: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Run two caller-supplied event lists over the same base state and compare."""
    _require_date(as_of, "as_of")
    params = _sim(sim)
    results: List[Dict[str, Any]] = []
    for extra_events in (first, second):
        scenario = _build(as_of, horizon_days, dict(params))
        scenario["events"].extend(extra_events)
        results.append(run_scenario(scenario))
    a, b = results
    return {
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
    }


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
    from . import db_manager

    is_sync, ledger_balance, stored_balance = db_manager.validate_balance_consistency()
    # Bounded aggregate: counts and freshness come from SQL, never from materializing the
    # ledger. A large history must not make this operation load every transaction.
    stats = db_manager.get_ledger_stats()
    with db_manager.get_db_connection() as conn:
        row = conn.execute("SELECT value FROM settings WHERE key = 'bank_balance_cents'").fetchone()
    bank_balance = int(row["value"]) if row and row["value"] is not None else None
    return {
        "ledger_balance_cents": ledger_balance,
        "stored_balance_cents": stored_balance,
        "bank_balance_cents": bank_balance,
        "reconciled_with_bank": bool(bank_balance is not None and bank_balance == ledger_balance),
        "balance_consistent": bool(is_sync),
        "counts": {
            "transactions": stats["transaction_count"],
            "income_sources": stats["income_source_count"],
            "payments": stats["payment_count"],
        },
        "newest_transaction_date": stats["newest_date"],
        # A future adapter must present this basis, not just the numbers.
        "data_source": "local sqlite ledger (monte_carlo_ledger/db_manager)",
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
    results: Dict[str, Any] = {}
    for strategy in ("snowball", "avalanche"):
        scenario = _build(as_of, DEFAULT_HORIZON_DAYS)
        scenario["liabilities"] = copy.deepcopy(liabilities)
        scenario["debt_strategy"] = strategy
        scenario["extra_monthly_payment_cents"] = extra_monthly_payment_cents
        results[strategy] = run_scenario(scenario)["debt"]
    return {
        "as_of": as_of,
        "strategies": results,
        # Honest interplay note: amortization and cash flow are separate models.
        "cash_flow_note": (
            "Deterministic payoff schedules only; these payments are not included in the "
            "cash-flow forecast or overdraft estimate. Affordability of any extra payment "
            "must be validated separately via simulate_purchase/forecast."
        ),
    }


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
            ],
        },
        "writes": {"allowed": False},
    }
