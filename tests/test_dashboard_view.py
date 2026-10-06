"""MC-07: the interactive terminal path is canonical and clock-free.

These tests pin the retirement of the duplicate Python engines: the legacy modules
must be gone, the financial core must not read a clock, the dashboard rows must be
derived from the contract's canonical events, and the one retained product heuristic
(daily pacing) must be derived from the canonical low point.
"""

import ast
import os
import unittest
from datetime import date
from pathlib import Path

from monte_carlo_ledger import dashboard_view, db_manager, scenario
from monte_carlo_ledger.contract import event_rows, run_scenario

REPO_ROOT = Path(__file__).resolve().parents[1]
PKG = REPO_ROOT / "monte_carlo_ledger"

FIXED_AS_OF = "2026-10-01"


def _explicit_scenario():
    return {
        "scenario_id": "rows",
        "as_of": FIXED_AS_OF,
        "horizon_days": 30,
        "starting_balance_cents": 100000,
        "events": [
            {"date": "2026-10-05", "amount_cents": -75000, "type": "expense", "name": "Bill"},
            {"date": "2026-10-05", "amount_cents": 50000, "type": "income", "name": "Pay"},
        ],
    }


class LegacyRetirementTests(unittest.TestCase):
    def test_duplicate_engines_are_removed(self):
        for name in ("forecasting", "risk", "timeline_service", "monte_carlo_config"):
            self.assertFalse((PKG / f"{name}.py").exists(), f"{name}.py must be deleted")

    def test_financial_core_never_reads_a_wall_clock(self):
        """No module that decides a financial conclusion may call now()/today()."""
        core = list((PKG / "contract").glob("*.py")) + [
            PKG / "scenario.py",
            PKG / "decisions.py",
            PKG / "dashboard_view.py",
            PKG / "dashboards.py",
            PKG / "commands.py",
        ]
        offenders = {}
        for path in core:
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in ast.walk(tree):
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                    if node.func.attr in {"now", "today", "utcnow"}:
                        offenders.setdefault(path.name, []).append(node.lineno)
        self.assertEqual(offenders, {}, "financial core must not read the wall clock (MCD-0001)")


class CanonicalRowTests(unittest.TestCase):
    def test_rows_are_consistent_with_the_canonical_forecast(self):
        scenario_doc = _explicit_scenario()
        result = run_scenario(scenario_doc)
        rows = event_rows(scenario_doc)

        self.assertEqual([r["type"] for r in rows], ["income", "expense"])  # same-day income first (MCD-0003)
        self.assertEqual(rows[0]["balance_after"], 150000)
        self.assertEqual(rows[1]["balance_after"], 75000)

        balances = [scenario_doc["starting_balance_cents"]] + [r["balance_after"] for r in rows]
        self.assertEqual(min(balances), result["forecast"]["minimum_balance_cents"])
        self.assertEqual(rows[-1]["balance_after"], result["forecast"]["ending_balance_cents"])


class DashboardViewTests(unittest.TestCase):
    def setUp(self):
        self.db_path = 'test_dashboard_view.db'
        db_manager.DB_PATH = self.db_path
        if os.path.exists(self.db_path):
            os.remove(self.db_path)
        db_manager.init_db()

    def tearDown(self):
        if os.path.exists(self.db_path):
            os.remove(self.db_path)

    def test_build_is_deterministic_and_explicit(self):
        db_manager.add_transaction(100000, "System", "start", t_type="Adjustment")
        first = dashboard_view.build(date(2026, 10, 1), 90)
        second = dashboard_view.build(date(2026, 10, 1), 90)
        self.assertEqual(first["result"], second["result"])
        self.assertEqual(first["scenario"]["as_of"], FIXED_AS_OF)

    def test_safe_to_spend_is_the_contract_quantile_not_the_low_point(self):
        db_manager.add_transaction(100000, "System", "start", t_type="Adjustment")
        view = dashboard_view.build(date(2026, 10, 1), 90, runs=200)
        risk = view["result"]["risk"]
        self.assertEqual(dashboard_view.safe_to_spend(view["result"]), risk["safe_to_spend_cents"])
        # MCD-0008/MCD-0009: the two families are distinct fields, even if a fixture makes them equal.
        self.assertEqual(
            dashboard_view.projected_low_point(view["result"]),
            view["result"]["forecast"]["minimum_balance_cents"],
        )

    def test_daily_pacing_is_derived_from_the_canonical_low_point(self):
        self.assertEqual(dashboard_view.daily_pacing_cents(-5000, 5), 0)
        self.assertEqual(dashboard_view.daily_pacing_cents(50000, 5), 10000)
        self.assertEqual(dashboard_view.daily_pacing_cents(50000, 0), 50000)

    def test_timeline_dashboard_renders_canonical_value(self):
        import contextlib
        import io

        from monte_carlo_ledger import dashboards

        db_manager.add_transaction(100000, "System", "start", t_type="Adjustment")
        db_manager.add_payment("Rent", 200000, "One-time", "2026-10-05")

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            dashboards.render_timeline_dashboard(as_of=date(2026, 10, 1))
        out = buf.getvalue()
        self.assertIn("PROJECTED LOW POINT", out)
        self.assertIn("DAILY PACING", out)


if __name__ == "__main__":
    unittest.main()
