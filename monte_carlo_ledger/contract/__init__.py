"""MonteCarlo Contract 1.0 reference implementation (pure, clock-free)."""

from __future__ import annotations

from .engine import (
    CONTRACT_VERSION,
    SIMULATION_DEFAULTS,
    expand,
    forecast,
    nearest_rank,
    run_scenario,
    run_scenario_safe,
)
from .money import (
    MAX_MONEY_CENTS,
    MIN_MONEY_CENTS,
    ContractError,
    checked_add,
    round_half_away,
    scale_cents_by_basis_points,
    scale_cents_by_percent,
)
from .prng import SplitMix64

__all__ = [
    "CONTRACT_VERSION",
    "SIMULATION_DEFAULTS",
    "MAX_MONEY_CENTS",
    "MIN_MONEY_CENTS",
    "ContractError",
    "SplitMix64",
    "checked_add",
    "expand",
    "forecast",
    "nearest_rank",
    "round_half_away",
    "run_scenario",
    "run_scenario_safe",
    "scale_cents_by_basis_points",
    "scale_cents_by_percent",
]
