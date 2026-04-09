import math
import random
from collections import Counter
from datetime import datetime, timedelta
from typing import Dict, List, Optional

from .forecasting import build_balance_forecast, calculate_forecast_summary
from .monte_carlo_config import MonteCarloConfig


def generate_scenario_timeline(
    base_timeline: List[Dict], rng: random.Random, config: MonteCarloConfig
) -> List[Dict]:
    """
    Generates a Monte Carlo scenario timeline.
    Mutates amounts safely within integer bounds and appends bounded surprise events.
    """
    scenario = []

    for event in base_timeline:
        new_event = event.copy()
        if new_event["type"] == "income":
            variation_percent = rng.randint(
                config.income_variation_min, config.income_variation_max
            )
            delta = (new_event["amount"] * variation_percent) // 100
            new_event["amount"] += delta
            new_event["amount"] = max(0, new_event["amount"])

        scenario.append(new_event)

    if base_timeline:
        start_date = datetime.now()
        end_date = datetime.strptime(base_timeline[-1]["date"], "%Y-%m-%d")
        days_total = (end_date - start_date).days

        checks = days_total // config.surprise_check_interval_days
        for i in range(checks):
            if rng.random() < config.surprise_probability:
                surprise_day = start_date + timedelta(
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


def run_monte_carlo(
    balance_cents: int,
    base_timeline: List[Dict],
    config: Optional[MonteCarloConfig] = None,
) -> Dict:
    """Executes multiple scenarios and aggregates deterministic risk metrics."""
    if config is None:
        config = MonteCarloConfig()

    rng = random.Random(config.seed)

    ending_balances = []
    lowest_balances = []
    negative_runs = 0
    negative_dates = []

    for _ in range(config.runs):
        scenario = generate_scenario_timeline(base_timeline, rng, config)
        res = simulate_scenario(balance_cents, scenario)

        ending_balances.append(res["ending_balance"])
        lowest_balances.append(res["lowest_balance"])

        if res["first_negative_date"]:
            negative_runs += 1
            negative_dates.append(res["first_negative_date"])

    ending_balances.sort()
    lowest_balances.sort()

    def get_median(sorted_list: List[int]) -> int:
        if not sorted_list:
            return 0
        n = len(sorted_list)
        if n % 2 == 1:
            return sorted_list[n // 2]
        return (sorted_list[n // 2 - 1] + sorted_list[n // 2]) // 2

    median_ending = get_median(ending_balances)
    median_lowest = get_median(lowest_balances)

    tenth_idx = max(0, math.ceil(config.worst_percentile * len(ending_balances)) - 1)
    worst_10_ending = ending_balances[tenth_idx] if ending_balances else 0

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
        "probability_negative": prob_neg,
        "negative_runs": negative_runs,
        "median_ending_balance": median_ending,
        "median_lowest_balance": median_lowest,
        "worst_10_percent_ending_balance": worst_10_ending,
        "most_common_first_negative_date": most_common_neg_date,
        "most_common_negative_window": {
            "start": window_start,
            "end": window_end,
        },
    }
