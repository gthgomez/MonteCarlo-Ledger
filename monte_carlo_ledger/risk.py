"""DEPRECATED native risk overlay.

The interactive dashboards and the CLI/API decision surfaces no longer use this
module; they delegate to the contract engine (``decisions.risk``). This module is
retained only for existing importers and its regression tests, and its financial
bugs are fixed in place so it can no longer emit a different convention than the
contract:

- B-02: percentage variation now uses the contract's round-half-away scaling
  (MCD-0007) instead of floor division.
- B-04: the median now uses the contract's single nearest-rank percentile
  convention (MCD-0005) instead of a floored average.

The contract engine remains the single source of truth; do not add new callers.
"""

import math
import random
from collections import Counter
from datetime import date, timedelta
from typing import Dict, List, Optional

from .contract import nearest_rank, scale_cents_by_percent
from .forecasting import build_balance_forecast, calculate_forecast_summary
from .monte_carlo_config import MonteCarloConfig

# Version of the scenario-generation algorithm. Recorded in run_monte_carlo
# output; no guarantee of identical results across future versions.
SIMULATION_ALGORITHM_VERSION = "1"


def generate_scenario_timeline(
    base_timeline: List[Dict],
    rng: random.Random,
    config: MonteCarloConfig,
    *,
    as_of: date,
) -> List[Dict]:
    """
    Generates a Monte Carlo scenario timeline.
    Mutates amounts safely within integer bounds and appends bounded surprise events.

    ``as_of`` is the explicit simulation date (captured once at the CLI/API
    boundary). This module must never read the wall clock. The horizon is
    inclusive: both ``as_of`` itself and the last event date belong to it.
    """
    scenario = []

    for event in base_timeline:
        new_event = event.copy()
        if new_event["type"] == "income":
            variation_percent = rng.randint(
                config.income_variation_min, config.income_variation_max
            )
            # MCD-0007: scale by (100 + percent) with round-half-away, never floor.
            new_event["amount"] = max(
                0, scale_cents_by_percent(new_event["amount"], variation_percent)
            )

        scenario.append(new_event)

    if base_timeline:
        end_date = date.fromisoformat(base_timeline[-1]["date"])
        days_total = (end_date - as_of).days + 1

        checks = days_total // config.surprise_check_interval_days
        for i in range(checks):
            if rng.random() < config.surprise_probability:
                surprise_day = as_of + timedelta(
                    days=i * config.surprise_check_interval_days
                    + rng.randint(0, config.surprise_check_interval_days - 1)
                )
                if surprise_day <= end_date:
                    surprise_amt = rng.randint(
                        config.surprise_amount_min, config.surprise_amount_max
                    )
                    scenario.append(
                        {
                            "date": surprise_day.strftime("%Y-%m-%d"),
                            "name": "Unexpected Expense",
                            "amount": -surprise_amt,
                            "type": "bill",
                            "priority": 1,
                        }
                    )

    scenario.sort(key=lambda x: (x["date"], x["priority"]))
    return scenario


def simulate_scenario(balance_cents: int, scenario_timeline: List[Dict]) -> Dict:
    """Simulates a generated scenario via the deterministic forecast logic."""
    forecast_rows = build_balance_forecast(balance_cents, scenario_timeline)
    return calculate_forecast_summary(balance_cents, forecast_rows)


def _median(sorted_list: List[int]) -> int:
    """B-04: P50 via the contract's single nearest-rank convention (MCD-0005)."""
    if not sorted_list:
        return 0
    return nearest_rank(sorted_list, 1, 2)


def run_monte_carlo(
    balance_cents: int,
    base_timeline: List[Dict],
    config: Optional[MonteCarloConfig] = None,
    *,
    as_of: date,
) -> Dict:
    """Executes multiple scenarios and aggregates deterministic risk metrics.

    ``as_of`` is the explicit simulation date; the caller (CLI/API boundary)
    supplies it. Results are a pure function of the inputs and the seed.
    """
    if config is None:
        config = MonteCarloConfig()

    rng = random.Random(config.seed)

    ending_balances = []
    lowest_balances = []
    negative_runs = 0
    negative_dates = []

    for _ in range(config.runs):
        scenario = generate_scenario_timeline(base_timeline, rng, config, as_of=as_of)
        res = simulate_scenario(balance_cents, scenario)

        ending_balances.append(res["ending_balance"])
        lowest_balances.append(res["lowest_balance"])

        if res["first_negative_date"]:
            negative_runs += 1
            negative_dates.append(res["first_negative_date"])

    ending_balances.sort()
    lowest_balances.sort()

    median_ending = _median(ending_balances)
    median_lowest = _median(lowest_balances)

    # Low-percentile order statistic at the configured (normalized, 0 < p <= 1)
    # percentile of the simulated ending balances. This is a simulated estimate,
    # not a guarantee and not a worst case.
    low_idx = max(0, math.ceil(config.worst_percentile * len(ending_balances)) - 1)
    low_percentile_ending = ending_balances[low_idx] if ending_balances else 0

    most_common_neg_date = None
    window_start = None
    window_end = None

    if negative_dates:
        counter = Counter(negative_dates)
        most_common_neg_date = counter.most_common(1)[0][0]
        window_start = most_common_neg_date
        window_end = most_common_neg_date

    prob_neg = (negative_runs * 100) / config.runs if config.runs > 0 else 0

    return {
        "runs": config.runs,
        "seed": config.seed,
        "as_of": as_of.isoformat(),
        "simulation_algorithm_version": SIMULATION_ALGORITHM_VERSION,
        "probability_negative": prob_neg,
        "negative_runs": negative_runs,
        "median_ending_balance": median_ending,
        "median_lowest_balance": median_lowest,
        "low_percentile": config.worst_percentile,
        "low_percentile_ending_balance": low_percentile_ending,
        # Deprecated alias kept for backwards compatibility with the old fixed
        # 10% label; use ``low_percentile_ending_balance`` instead.
        "worst_10_percent_ending_balance": low_percentile_ending,
        "most_common_first_negative_date": most_common_neg_date,
        "most_common_negative_window": {
            "start": window_start,
            "end": window_end,
        },
    }
