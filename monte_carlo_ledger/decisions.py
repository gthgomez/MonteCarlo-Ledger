"""Goal-oriented decision operations (MC-04).

Every operation maps to a canonical scenario transformation and delegates the
financial conclusion to the contract engine. No operation performs financial math
here; the engine owns the answer (MCD-0006..0010).
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any, Dict, List, Optional

from . import scenario as scenario_mod
from .contract import run_scenario, scenario_rows

DEFAULT_HORIZON_DAYS = 90
DEFAULT_SIM: Dict[str, int] = {"runs": 500, "seed": 42}


def _sim(overrides: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    merged: Dict[str, Any] = dict(DEFAULT_SIM)
    if overrides:
        merged.update(overrides)
    return merged


def forecast(as_of: str, horizon_days: int = DEFAULT_HORIZON_DAYS) -> Dict[str, Any]:
    """Deterministic forecast only (no simulation)."""
    return run_scenario(scenario_mod.build_scenario(as_of, horizon_days))


def forecast_detail(
    as_of: str, horizon_days: int = DEFAULT_HORIZON_DAYS
) -> Dict[str, Any]:
    """Deterministic forecast plus per-event running-balance rows (display).

    The aggregate ``forecast`` block is the contract result; ``rows`` is a
    non-normative view produced by the contract engine's own walk, so a displayed
    row can never disagree with the aggregate.
    """
    scenario = scenario_mod.build_scenario(as_of, horizon_days)
    result = run_scenario(scenario)
    return {"forecast": result["forecast"], "rows": scenario_rows(scenario)}


def risk(
    as_of: str,
    horizon_days: int = DEFAULT_HORIZON_DAYS,
    sim: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Forecast + Monte Carlo risk block."""
    scenario = scenario_mod.build_scenario(
        as_of, horizon_days, include_simulation=_sim(sim)
    )
    return run_scenario(scenario)


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
    overrides = dict(sim or {})
    overrides.setdefault("expense_variation_min", 0)
    overrides.setdefault("expense_variation_max", 0)
    params = _sim(overrides)

    baseline = run_scenario(
        scenario_mod.build_scenario(as_of, horizon_days, include_simulation=dict(params))
    )
    with_purchase_scenario = scenario_mod.build_scenario(
        as_of, horizon_days, include_simulation=dict(params)
    )
    with_purchase_scenario["events"].append({
        "date": purchase_date,
        "amount_cents": -abs(int(amount_cents)),
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
    }


def simulate_paycheck_delay(
    delay_days: int,
    as_of: str,
    horizon_days: int = DEFAULT_HORIZON_DAYS,
    sim: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Compare baseline vs the next in-window paycheck arriving ``delay_days`` late."""
    params = _sim(sim)
    baseline = run_scenario(
        scenario_mod.build_scenario(as_of, horizon_days, include_simulation=dict(params))
    )
    delayed_scenario = scenario_mod.build_scenario(
        as_of, horizon_days, include_simulation=dict(params)
    )
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
    }


def compare_scenarios(
    first: Dict[str, Any],
    second: Dict[str, Any],
    as_of: str,
    horizon_days: int = DEFAULT_HORIZON_DAYS,
    sim: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Run two caller-supplied event lists over the same base state and compare."""
    params = _sim(sim)
    results: List[Dict[str, Any]] = []
    for extra_events in (first, second):
        scenario = scenario_mod.build_scenario(
            as_of, horizon_days, include_simulation=dict(params)
        )
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
