"""MC02 regression: simulation time is an explicit input, never the wall clock.

Contract under test:
- ``run_monte_carlo`` / ``generate_scenario_timeline`` require an explicit
  ``as_of: datetime.date`` keyword; no module below the CLI/API boundary may
  read the wall clock to place scenario events.
- Horizon semantics are inclusive: an event dated on ``as_of`` itself and an
  event on the last day both belong to the horizon.
- Results are a pure function of (ledger, timeline, config seed, as_of).
- Public risk output records ``as_of``, ``seed`` and the simulation
  algorithm version.
"""

import ast
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest import mock

from monte_carlo_ledger import risk
from monte_carlo_ledger.monte_carlo_config import MonteCarloConfig

REPO_ROOT = Path(__file__).resolve().parents[1]

# Fixed ledger fixture; no wall-clock dependence.
BASE_TIMELINE = [
    {"date": "2026-03-15", "name": "Salary", "type": "income", "priority": 0, "amount": 100000},
    {"date": "2026-05-01", "name": "Rent", "type": "bill", "priority": 1, "amount": -80000},
]


class FakeClock:
    """Stands in for the ``datetime`` symbol inside the module under test."""

    def __init__(self, fixed):
        self._fixed = fixed

    def now(self, tz=None):
        return self._fixed


def _run(balance, timeline, config, as_of):
    return risk.run_monte_carlo(balance, timeline, config, as_of=as_of)


class TestExplicitClockDeterminism(unittest.TestCase):
    """(a) Same ledger/config/seed/as_of -> identical results under two fake wall clocks."""

    def test_identical_results_under_two_fake_wall_clocks(self):
        config = MonteCarloConfig(runs=5, seed=7, surprise_probability=1.0)
        as_of = date(2026, 3, 1)

        # Two hostile wall clocks, 19 days apart. If any scenario code below
        # the boundary read the wall clock, the surprise placement window
        # (and therefore the results) would differ between these runs.
        clock_a = FakeClock(__import__("datetime").datetime(2026, 3, 1, 0, 0, 0))
        clock_b = FakeClock(__import__("datetime").datetime(2026, 3, 20, 0, 0, 0))

        with mock.patch.object(risk, "datetime", clock_a, create=True):
            res_a = _run(50000, BASE_TIMELINE, config, as_of)
        with mock.patch.object(risk, "datetime", clock_b, create=True):
            res_b = _run(50000, BASE_TIMELINE, config, as_of)

        self.assertEqual(res_a, res_b)

    def test_as_of_is_required_keyword(self):
        config = MonteCarloConfig(runs=1, seed=1)
        with self.assertRaises(TypeError):
            risk.run_monte_carlo(50000, BASE_TIMELINE, config)
        with self.assertRaises(TypeError):
            rng = __import__("random").Random(1)
            risk.generate_scenario_timeline(BASE_TIMELINE, rng, config)


class TestInclusiveHorizonSemantics(unittest.TestCase):
    """(b) Midnight and month/leap-day fixtures have exact inclusive horizon lengths."""

    def _surprise_dates(self, as_of, last_date, interval_days=14):
        """Collect surprise dates over several runs with surprises guaranteed."""
        config = MonteCarloConfig(
            runs=10,
            seed=11,
            surprise_probability=1.0,
            surprise_check_interval_days=interval_days,
        )
        timeline = [
            {"date": last_date, "name": "Distant Bill", "type": "bill", "priority": 1, "amount": -1000}
        ]
        dates = []
        for _ in range(config.runs):
            rng = __import__("random").Random(config.seed)
            scenario = risk.generate_scenario_timeline(timeline, rng, config, as_of=as_of)
            dates += [e["date"] for e in scenario if e["name"] == "Unexpected Expense"]
        return dates

    def test_same_day_horizon_is_one_inclusive_day(self):
        # as_of == event date: horizon is exactly 1 day. With interval=1 and
        # probability 1.0 exactly one check occurs and the surprise must land
        # on as_of itself. Under the old wall-clock code the day count was
        # taken from a time-of-day-stamped datetime.now(), so this was
        # unstable around midnight.
        dates = self._surprise_dates(date(2026, 1, 1), "2026-01-01", interval_days=1)
        self.assertTrue(dates, "expected at least one surprise in a 1-day horizon")
        self.assertTrue(all(d == "2026-01-01" for d in dates))

    def test_month_boundary_horizon_is_two_inclusive_days(self):
        # 2026-03-31 -> 2026-04-01 spans a month boundary: 2 inclusive days.
        # interval=2 gives exactly one check; exclusive semantics would give
        # (end - start).days == 1 -> 1 // 2 == 0 checks and no surprise.
        dates = self._surprise_dates(date(2026, 3, 31), "2026-04-01", interval_days=2)
        self.assertTrue(dates, "inclusive 2-day horizon must admit one surprise check")
        self.assertTrue(all(d in {"2026-03-31", "2026-04-01"} for d in dates))

    def test_leap_day_horizon_is_exact(self):
        # 2024-02-28 -> 2024-02-29: leap day is inside the horizon (2 days).
        dates = self._surprise_dates(date(2024, 2, 28), "2024-02-29", interval_days=2)
        self.assertTrue(dates, "leap-day inclusive horizon must admit one surprise check")
        self.assertTrue(all(d in {"2024-02-28", "2024-02-29"} for d in dates))

    def test_surprises_stay_within_as_of_to_end_window(self):
        for as_of, last in [
            (date(2026, 2, 27), "2026-03-02"),
            (date(2024, 2, 27), "2024-03-01"),
        ]:
            for d in self._surprise_dates(as_of, last, interval_days=7):
                self.assertGreaterEqual(d, as_of.isoformat())
                self.assertLessEqual(d, last)


class TestNoWallClockBelowBoundary(unittest.TestCase):
    """(c) AST scan: no datetime.now / date.today below the CLI/API boundary."""

    # Modules allowed to read the wall clock. cli.py and api.py are the
    # MC02 boundary (they capture today once and pass it down). The others
    # are pre-existing display/persistence defaults outside this slice's
    # file list; narrowing them is deferred, not silently ignored.
    ALLOWED_WALL_CLOCK_MODULES = {
        "cli.py",
        "api.py",
        "timeline_service.py",
        "dashboards.py",
        "budget_engine.py",
        "db_manager.py",
        "workflow_reporting.py",
        "workflow_onboarding.py",
        "workflow_payments.py",
    }

    def _wall_clock_reads(self, path: Path):
        tree = ast.parse(path.read_text(encoding="utf-8"))
        hits = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
                continue
            if node.func.attr not in {"now", "today"}:
                continue
            target = node.func.value
            name = target.id if isinstance(target, ast.Name) else (
                target.attr if isinstance(target, ast.Attribute) else None
            )
            if name in {"datetime", "date", "self"} or name is None:
                hits.append(f"{node.func.attr} at line {node.lineno}")
        return hits

    def test_risk_module_never_reads_wall_clock(self):
        src = (REPO_ROOT / "monte_carlo_ledger" / "risk.py").read_text(encoding="utf-8")
        for banned in ("datetime.now", "date.today", "datetime.today"):
            self.assertNotIn(banned, src)
        hits = self._wall_clock_reads(REPO_ROOT / "monte_carlo_ledger" / "risk.py")
        self.assertEqual(hits, [], "risk.py must not read the wall clock")

    def test_wall_clock_reads_confined_to_boundary_or_documented_modules(self):
        pkg = REPO_ROOT / "monte_carlo_ledger"
        offenders = {}
        for path in pkg.glob("*.py"):
            if path.name in self.ALLOWED_WALL_CLOCK_MODULES:
                continue
            hits = self._wall_clock_reads(path)
            if hits:
                offenders[path.name] = hits
        self.assertEqual(offenders, {}, "unexpected wall-clock reads outside the allowlist")


class TestOutputExposesAsOfAndSeed(unittest.TestCase):
    """(d) Public output records as_of, seed and simulation algorithm version."""

    def test_output_fields(self):
        config = MonteCarloConfig(runs=3, seed=99)
        res = _run(50000, BASE_TIMELINE, config, date(2026, 3, 1))
        self.assertEqual(res["as_of"], "2026-03-01")
        self.assertEqual(res["seed"], 99)
        self.assertIsInstance(res["simulation_algorithm_version"], str)
        self.assertTrue(res["simulation_algorithm_version"])


if __name__ == "__main__":
    unittest.main()
