"""End-to-end synthetic-household journeys through the real CLI.

Unlike the unit suites, these tests execute the installed command line in
subprocesses against a disposable SQLite ledger, so they exercise argument
parsing, the decision layer, the contract engine, JSON serialization, exit
codes and database failure handling as a user would.

The household is entirely synthetic and fixed in time (no wall-clock reads in
the financial path).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from monte_carlo_ledger import db_manager
from monte_carlo_ledger import scenario as scenario_mod


REPO_ROOT = Path(__file__).resolve().parents[1]
AS_OF = "2026-11-09"


class HouseholdJourneyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.tmp.name) / "household.db")
        db_manager.DB_PATH = self.db
        db_manager.init_db()
        # Synthetic household: opening cash, biweekly income, fixed bills, irregular spending.
        db_manager.add_transaction(
            500_000, "System", "Opening Balance", t_type="Adjustment", date_str="2026-10-01"
        )
        db_manager.add_income_source("Primary Paycheck", 220_000, "Bi-weekly", "2026-10-30")
        db_manager.add_payment("Apartment Rent", 135_000, "Monthly", 1)
        db_manager.add_payment("Utilities", 18_000, "Monthly", 10)
        db_manager.add_payment("Internet", 7_500, "Monthly", 14)
        db_manager.add_payment("Subscriptions", 1_500, "Monthly", 20)
        db_manager.add_transaction(-4_200, "Food", "Groceries", t_type="Expense", date_str="2026-10-12")
        db_manager.add_transaction(-9_900, "Car", "Repair", t_type="Expense", date_str="2026-10-22")

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, *args: str, db: str | None = None) -> subprocess.CompletedProcess:
        env = os.environ.copy()
        env["MC_LEDGER_DB"] = db or self.db
        return subprocess.run(
            [sys.executable, "-m", "monte_carlo_ledger", *args],
            cwd=str(REPO_ROOT),
            env=env,
            capture_output=True,
            text=True,
        )

    def _occurrence_count(self) -> int:
        with db_manager.get_db_connection() as conn:
            return conn.execute("SELECT COUNT(*) AS n FROM bill_occurrences").fetchone()["n"]

    # -- ordinary forecast -------------------------------------------------

    def test_ordinary_90_day_forecast(self):
        proc = self.run_cli("forecast", "--as-of", AS_OF, "--horizon", "90", "--json")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)

        self.assertEqual(result["contract_version"], "2.0")
        forecast = result["forecast"]
        # Opening cash (500,000 - 4,200 - 9,900) + 7 biweekly paychecks - scheduled bills.
        self.assertEqual(forecast["ending_balance_cents"], 1_539_900)
        # The lowest point is after the first bill (utilities, Nov 10) and before the first
        # paycheck (Nov 13): 485,900 - 18,000 = 467,900.
        self.assertEqual(forecast["minimum_balance_cents"], 467_900)
        self.assertEqual(forecast["minimum_balance_date"], "2026-11-10")
        self.assertIsNone(forecast["first_negative_date"])

    def test_forecast_does_not_write_bill_occurrences(self):
        before = self._occurrence_count()
        proc = self.run_cli("forecast", "--as-of", AS_OF, "--horizon", "90", "--json")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(before, self._occurrence_count(), "a forecast must not mutate the ledger")

    # -- hypothetical purchase ---------------------------------------------

    def test_650_dollar_purchase_scenario(self):
        proc = self.run_cli(
            "simulate-purchase", "65000", "--date", "2026-11-10", "--as-of", AS_OF, "--json"
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)

        baseline = result["baseline"]["forecast"]
        with_purchase = result["with_purchase"]["forecast"]
        self.assertEqual(with_purchase["ending_balance_cents"], baseline["ending_balance_cents"] - 65_000)
        # Metamorphic invariant: adding an expense cannot improve the projected trough.
        self.assertLessEqual(
            with_purchase["minimum_balance_cents"], baseline["minimum_balance_cents"]
        )
        self.assertIn("negative_balance_probability_ppm", result["change"])

    # -- paycheck delay ----------------------------------------------------

    def test_three_day_paycheck_delay(self):
        proc = self.run_cli(
            "simulate-paycheck-delay", "3", "--as-of", AS_OF, "--json"
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        # Delaying income cannot raise the conservative trough.
        self.assertLessEqual(
            result["delayed"]["risk"]["minimum_balance_p10_cents"],
            result["baseline"]["risk"]["minimum_balance_p10_cents"],
        )

    def test_rent_before_payroll_overdraft_summary(self):
        # Force a thin balance so the Nov 10 utilities bill lands before the Nov 13 paycheck.
        db_manager.add_transaction(-480_000, "Adjustment", "Drain", t_type="Adjustment", date_str="2026-11-08")
        proc = self.run_cli("overdraft", "--as-of", AS_OF, "--json")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        result = json.loads(proc.stdout)
        self.assertLessEqual(result["projected_low_point_cents"], 0)
        self.assertIsNotNone(result["first_negative_date"])
        self.assertIn("negative_balance_probability_ppm", result)

    # -- month-end recurrence ---------------------------------------------

    def test_month_end_bill_keeps_its_anchor(self):
        db_manager.add_payment("Month-end Rent", 135_000, "Monthly", 31)
        built = scenario_mod.build_scenario("2026-11-09", 120, read_only=True)
        dates = [e["date"] for e in built["events"] if e["name"] == "Month-end Rent"]
        self.assertIn("2026-12-31", dates)
        self.assertIn("2027-01-31", dates)
        self.assertIn("2027-02-28", dates, "February must clamp to the 28th, not drift")
        self.assertNotIn("2027-02-31", dates)

    # -- invalid input -----------------------------------------------------

    def test_invalid_amount_is_rejected_without_numbers(self):
        proc = self.run_cli(
            "simulate-purchase", "0", "--date", "2026-11-10", "--as-of", AS_OF, "--json"
        )
        self.assertEqual(proc.returncode, 2)
        self.assertIn("INVALID_AMOUNT", proc.stderr)
        self.assertEqual(proc.stdout.strip(), "", "no fabricated result on failure")

        proc = self.run_cli(
            "simulate-purchase", "-65000", "--date", "2026-11-10", "--as-of", AS_OF, "--json"
        )
        self.assertEqual(proc.returncode, 2)
        self.assertIn("INVALID_AMOUNT", proc.stderr)

    def test_invalid_date_is_rejected_without_numbers(self):
        proc = self.run_cli("forecast", "--as-of", "2026-13-40", "--json")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("INVALID_DATE", proc.stderr)
        self.assertEqual(proc.stdout.strip(), "")

    # -- damaged database --------------------------------------------------

    def test_corrupted_database_fails_safely(self):
        corrupt = str(Path(self.tmp.name) / "corrupt.db")
        Path(corrupt).write_bytes(b"this is not a sqlite database")
        proc = self.run_cli("forecast", "--as-of", AS_OF, "--json", db=corrupt)
        self.assertEqual(proc.returncode, 3)
        self.assertIn("DATABASE_CORRUPT", proc.stderr)
        self.assertEqual(proc.stdout.strip(), "")

    def test_empty_ledger_is_a_valid_state(self):
        empty = str(Path(self.tmp.name) / "empty.db")
        # Create a clean schema at a separate path by switching the module path temporarily.
        previous = db_manager.DB_PATH
        db_manager.DB_PATH = empty
        try:
            db_manager.init_db()
        finally:
            db_manager.DB_PATH = previous
        proc = self.run_cli("forecast", "--as-of", AS_OF, "--json", db=empty)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        forecast = json.loads(proc.stdout)["forecast"]
        self.assertEqual(forecast["ending_balance_cents"], 0)
        self.assertEqual(forecast["minimum_balance_cents"], 0)
        self.assertIsNone(forecast["first_negative_date"])


if __name__ == "__main__":
    unittest.main()
