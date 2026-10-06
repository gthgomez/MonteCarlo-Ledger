"""Canonical interactive view for the terminal dashboards (MC-07).

The interactive dashboards previously rendered from ``forecasting`` / ``risk`` /
``timeline_service``, whose semantics diverged from Contract 1.x (inclusive horizon,
floor-division percentages, and a second Monte Carlo PRNG). This module renders the
same screens from the canonical scenario + contract engine, so the terminal cannot
produce a different answer from the CLI/API.

It owns no financial rule: ``rows`` are the contract's canonical ordered events with
running balances, and ``result`` is the contract result. ``daily_pacing_cents`` is the
single product heuristic retained here; it is explicitly **non-normative** (Contract
1.x has no daily-pacing concept) and is derived from the canonical projected low point
so it can never contradict the canonical number it is shown next to.
"""

from __future__ import annotations

from datetime import date
from typing import Any, Dict, Optional

from . import scenario as scenario_mod
from .contract import event_rows, run_scenario


def build(
    as_of: date,
    horizon_days: int = 90,
    *,
    runs: Optional[int] = None,
    seed: int = 42,
    reserve_cents: int = 0,
) -> Dict[str, Any]:
    """Return the canonical scenario, contract result and display rows.

    ``as_of`` is explicit (MCD-0001); nothing here reads the wall clock.
    """
    include_simulation: Optional[Dict[str, Any]] = None
    if runs is not None:
        include_simulation = {"runs": runs, "seed": seed, "reserve_cents": reserve_cents}
    built = scenario_mod.build_scenario(
        as_of.isoformat(), horizon_days, include_simulation=include_simulation, read_only=True
    )
    result = run_scenario(built)
    return {"scenario": built, "result": result, "rows": event_rows(built)}


def next_income(rows: list) -> Optional[Dict[str, Any]]:
    """First future income row, if any (display helper)."""
    for row in rows:
        if row["type"] == "income":
            return row
    return None


def projected_low_point(result: Dict[str, Any]) -> int:
    """The canonical deterministic low point (MCD-0009: `forecast` family)."""
    return int(result["forecast"]["minimum_balance_cents"])


def safe_to_spend(result: Dict[str, Any]) -> int:
    """The canonical quantile safe-to-spend, when a simulation was run (MCD-0008)."""
    risk = result.get("risk")
    if risk is not None:
        return int(risk["safe_to_spend_cents"])
    return projected_low_point(result)


def daily_pacing_cents(low_point_cents: int, days_until_payday: int) -> int:
    """NON-NORMATIVE product heuristic: spread the low point over the days to payday.

    Contract 1.x defines no daily pacing. This is display guidance only and is derived
    from the canonical projected low point, so it cannot contradict the canonical
    number shown beside it. It is never a financial conclusion on its own.
    """
    if low_point_cents <= 0:
        return 0
    if days_until_payday <= 0:
        return low_point_cents
    return low_point_cents // days_until_payday
