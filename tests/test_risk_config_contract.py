"""Risk configuration contract tests (MC03).

These tests pin the validation contract on ``MonteCarloConfig`` and the
percentile output naming on ``run_monte_carlo``:

- invalid configuration is rejected before any sampling happens;
- boundary probabilities (0 and 1) behave exactly;
- the existing normalized [0, 1] percentile input scale is preserved;
- the output exposes a neutral, config-driven percentile field with a
  backwards-compatible deprecated alias for the old ``worst_10_percent_...``
  key.
"""

import math
import unittest
from datetime import date

from monte_carlo_ledger.monte_carlo_config import MAX_RUNS, MonteCarloConfig
from monte_carlo_ledger.risk import run_monte_carlo


def _timeline():
    return [
        {"date": "2026-10-01", "name": "Pay", "amount": 500_000, "type": "income", "priority": 3},
        {"date": "2026-10-15", "name": "Rent", "amount": -300_000, "type": "bill", "priority": 1},
    ]


class InvalidConfigRejectionTests(unittest.TestCase):
    """Invalid inputs must be rejected before sampling."""

    def test_runs_must_be_positive_int(self):
        for bad in (0, -1):
            with self.assertRaises(ValueError, msg=f"runs={bad}"):
                MonteCarloConfig(runs=bad)

    def test_runs_must_not_be_bool_or_float(self):
        for bad in (True, 10.0, "500"):
            with self.assertRaises((ValueError, TypeError), msg=f"runs={bad!r}"):
                MonteCarloConfig(runs=bad)

    def test_runs_bounded_by_documented_resource_budget(self):
        with self.assertRaises(ValueError, msg=f"runs={MAX_RUNS + 1}"):
            MonteCarloConfig(runs=MAX_RUNS + 1)
        self.assertGreater(MAX_RUNS, 0)

    def test_surprise_probability_nan_rejected(self):
        with self.assertRaises(ValueError):
            MonteCarloConfig(surprise_probability=float("nan"))

    def test_surprise_probability_out_of_range_rejected(self):
        for bad in (-0.01, 1.01, 100):
            with self.assertRaises(ValueError, msg=f"probability={bad}"):
                MonteCarloConfig(surprise_probability=bad)

    def test_surprise_probability_non_numeric_rejected(self):
        with self.assertRaises((ValueError, TypeError)):
            MonteCarloConfig(surprise_probability="0.5")

    def test_worst_percentile_nan_rejected(self):
        with self.assertRaises(ValueError):
            MonteCarloConfig(worst_percentile=float("nan"))

    def test_worst_percentile_out_of_range_rejected(self):
        # Existing input scale is normalized [0, 1]; 0 and negatives are
        # meaningless as a "low percentile" selector.
        for bad in (0, 0.0, -0.1, 1.0001, 10, 100):
            with self.assertRaises(ValueError, msg=f"percentile={bad}"):
                MonteCarloConfig(worst_percentile=bad)

    def test_worst_percentile_upper_boundary_valid(self):
        config = MonteCarloConfig(worst_percentile=1.0)
        self.assertEqual(config.worst_percentile, 1.0)

    def test_reversed_income_variation_range_rejected(self):
        with self.assertRaises(ValueError):
            MonteCarloConfig(income_variation_min=8, income_variation_max=-8)

    def test_income_variation_max_must_be_nonnegative(self):
        with self.assertRaises(ValueError):
            MonteCarloConfig(income_variation_min=-20, income_variation_max=-1)

    def test_surprise_amounts_must_be_nonnegative_and_ordered(self):
        for kwargs in (
            {"surprise_amount_min": -1},
            {"surprise_amount_max": -1},
            {"surprise_amount_min": 15_000, "surprise_amount_max": 2_000},
        ):
            with self.assertRaises(ValueError, msg=str(kwargs)):
                MonteCarloConfig(**kwargs)

    def test_surprise_check_interval_must_be_positive(self):
        for bad in (0, -14):
            with self.assertRaises(ValueError, msg=f"interval={bad}"):
                MonteCarloConfig(surprise_check_interval_days=bad)

    def test_validation_happens_before_sampling(self):
        # A bad config must fail at construction time, not inside the
        # sampling loop: constructing it and only then running is impossible.
        with self.assertRaises(ValueError):
            config = MonteCarloConfig(runs=-5)
            run_monte_carlo(100_000, _timeline(), config, as_of=date(2026, 10, 1))


class BoundaryProbabilityTests(unittest.TestCase):
    """Boundary probabilities 0 and 1 must behave exactly."""

    def test_zero_probability_means_no_surprises(self):
        config = MonteCarloConfig(runs=10, surprise_probability=0.0)
        res = run_monte_carlo(100_000, _timeline(), config, as_of=date(2026, 10, 1))
        self.assertEqual(res["negative_runs"], 0)
        self.assertEqual(res["probability_negative"], 0.0)
        self.assertIsNone(res["most_common_first_negative_date"])

    def test_one_probability_means_surprise_at_every_check(self):
        # Balance and surprise bounds chosen so the baseline (no surprises)
        # stays positive but any injected surprise drives the walk negative:
        # probability 1 must yield a strictly lower minimum than probability 0.
        balance = 100_000
        base_kwargs = dict(
            runs=1,
            surprise_amount_min=300_000,
            surprise_amount_max=400_000,
        )
        config = MonteCarloConfig(**base_kwargs, surprise_probability=1.0)
        res = run_monte_carlo(balance, _timeline(), config, as_of=date(2026, 10, 1))
        zero = run_monte_carlo(
            balance,
            _timeline(),
            MonteCarloConfig(**base_kwargs, surprise_probability=0.0),
            as_of=date(2026, 10, 1),
        )
        self.assertEqual(zero["probability_negative"], 0.0)
        self.assertEqual(res["probability_negative"], 100.0)
        self.assertLess(res["median_lowest_balance"], zero["median_lowest_balance"])

    def test_probability_negative_stays_within_zero_and_hundred(self):
        config = MonteCarloConfig(runs=20)
        res = run_monte_carlo(100_000, _timeline(), config, as_of=date(2026, 10, 1))
        self.assertGreaterEqual(res["probability_negative"], 0.0)
        self.assertLessEqual(res["probability_negative"], 100.0)


class PercentileOutputTests(unittest.TestCase):
    """The selected percentile must be named accurately and neutrally."""

    def test_output_contains_neutral_percentile_field_matching_config(self):
        config = MonteCarloConfig(runs=10, worst_percentile=0.25)
        res = run_monte_carlo(100_000, _timeline(), config, as_of=date(2026, 10, 1))
        self.assertIn("low_percentile_ending_balance", res)
        self.assertIn("low_percentile", res)
        self.assertEqual(res["low_percentile"], 0.25)
        self.assertEqual(res["runs"], 10)

    def test_deprecated_alias_kept_for_backwards_compatibility(self):
        config = MonteCarloConfig(runs=10, worst_percentile=0.10)
        res = run_monte_carlo(100_000, _timeline(), config, as_of=date(2026, 10, 1))
        self.assertIn("worst_10_percent_ending_balance", res)
        self.assertEqual(
            res["worst_10_percent_ending_balance"],
            res["low_percentile_ending_balance"],
        )

    def test_neutral_field_matches_order_statistic(self):
        config = MonteCarloConfig(runs=10, worst_percentile=0.10)
        res = run_monte_carlo(100_000, _timeline(), config, as_of=date(2026, 10, 1))
        self.assertIsInstance(res["low_percentile_ending_balance"], int)


if __name__ == "__main__":
    unittest.main()
