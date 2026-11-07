"""Regression tests for MCD-0022 recurrence anchoring in the ledger adapter.

The confirmed defect: monthly income advanced from the previously clamped
``next_payday`` (Jan 31 -> Feb 28 -> Mar 28), losing the day-of-month anchor.
"""

import os
import tempfile
import unittest

from datetime import date

from monte_carlo_ledger import db_manager, scenario
from monte_carlo_ledger.contract import ContractError, recurrence_dates, run_scenario


class IncomeAnchoringTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        db_manager.DB_PATH = os.path.join(self.tmp.name, "ledger.db")
        db_manager.init_db()

    def tearDown(self):
        self.tmp.cleanup()

    def _dates(self, as_of, horizon=120):
        return [
            e["date"]
            for e in scenario.build_scenario(as_of, horizon, read_only=True)["events"]
            if e["type"] == "income"
        ]

    # --- the confirmed bug -------------------------------------------------

    def test_month_end_anchor_survives_february(self):
        db_manager.add_income_source("Pay", 100_000, "Monthly", "2026-01-31")
        # Stored next payday is the clamped Feb 28; March must return to the 31st.
        self.assertEqual(self._dates("2026-01-01"), [
            "2026-02-28", "2026-03-31", "2026-04-30",
        ])

    def test_leap_year_february_then_march_31(self):
        db_manager.add_income_source("Pay", 100_000, "Monthly", "2024-01-31")
        self.assertEqual(self._dates("2024-01-01"), ["2024-02-29", "2024-03-31"])

    def test_monthly_income_crosses_year_boundary(self):
        db_manager.add_income_source("Pay", 100_000, "Monthly", "2026-11-30")
        self.assertEqual(self._dates("2026-11-30"), [
            "2026-12-30", "2027-01-30", "2027-02-28",
        ])

    def test_manually_moved_payday_becomes_the_new_anchor(self):
        db_manager.add_income_source("Pay", 100_000, "Monthly", "2026-01-31")
        db_manager.update_income_source(
            1, "Pay", 100_000, "Monthly", "2026-01-31", "2026-02-20"
        )
        self.assertEqual(self._dates("2026-02-01", 90), [
            "2026-02-20", "2026-03-20", "2026-04-20",
        ])

    # --- boundaries --------------------------------------------------------

    def test_first_projected_income_is_on_or_after_as_of(self):
        db_manager.add_income_source("Pay", 100_000, "Monthly", "2026-01-31")
        self.assertEqual(self._dates("2026-03-15", 40), ["2026-03-31"])

    def test_income_on_as_of_is_included_and_horizon_end_is_excluded(self):
        db_manager.add_income_source("Pay", 100_000, "One-time", "2026-05-01")
        self.assertEqual(self._dates("2026-05-01", 1), ["2026-05-01"])
        self.assertEqual(self._dates("2026-05-01", 0), [])

    def test_weekly_and_biweekly_boundaries(self):
        db_manager.add_income_source("Weekly", 10_000, "Weekly", "2026-01-05")
        self.assertEqual(
            self._dates("2026-01-01", 21),
            ["2026-01-12", "2026-01-19"],
        )
        db_manager.delete_income_source(1)
        db_manager.add_income_source("Biweekly", 50_000, "Bi-weekly", "2026-01-09")
        self.assertEqual(self._dates("2026-01-01", 29), ["2026-01-23"])

    def test_month_end_paycheck_immediately_before_rent(self):
        db_manager.add_income_source("Pay", 220_000, "Monthly", "2025-12-31")
        db_manager.add_payment("Rent", 135_000, "Monthly", 1)
        built = scenario.build_scenario("2026-01-15", 90, read_only=True)
        result = run_scenario(built)
        # The Jan 1 rent is past-due (excluded); the Jan 31 paycheck lands before Feb rent.
        self.assertEqual(result["forecast"]["minimum_balance_cents"], 0)
        dates = [e["date"] for e in built["events"] if e["name"] == "Pay"]
        self.assertEqual(dates[:2], ["2026-01-31", "2026-02-28"])

    # --- invalid persisted state is explicit, not silently skipped --------

    def test_invalid_payday_raises_typed_error(self):
        with db_manager.get_db_connection() as conn:
            with conn:
                conn.execute(
                    "INSERT INTO income (name, amount, frequency, last_payday, next_payday) "
                    "VALUES (?, ?, ?, ?, ?)",
                    ("Broken", 100_000, "Monthly", "2026-13-40", "2026-13-40"),
                )
        with self.assertRaises(ContractError) as ctx:
            self._dates("2026-01-01")
        self.assertEqual(ctx.exception.code, "INVALID_DATE")

    def test_unsupported_frequency_raises_typed_error(self):
        # The table CHECK constraint blocks this on write; the adapter must also
        # refuse it if it arrives from legacy or externally restored data.
        inc = db_manager.IncomeSource(
            id=1, name="Odd", amount=100_000, frequency="Fortnightly-ish",
            last_payday="2026-01-31", next_payday="2026-02-28",
        )
        with self.assertRaises(ContractError) as ctx:
            scenario._income_recurrence(inc)
        self.assertEqual(ctx.exception.code, "INVALID_FREQUENCY")

    def test_zero_and_negative_income_are_rejected_by_the_engine(self):
        with db_manager.get_db_connection() as conn:
            with conn:
                conn.executemany(
                    "INSERT INTO income (name, amount, frequency, last_payday, next_payday) "
                    "VALUES (?, ?, ?, ?, ?)",
                    [
                        ("Zero", 0, "Monthly", "2026-01-31", "2026-02-28"),
                        ("Negative", -1, "Monthly", "2026-01-31", "2026-02-28"),
                    ],
                )
        for source in ("Zero", "Negative"):
            with self.subTest(source=source):
                self.assertRaises(
                    ContractError,
                    run_scenario,
                    scenario.build_scenario("2026-02-01", 60, read_only=True),
                )

    # --- adapter equals canonical expansion --------------------------------

    def test_adapter_matches_canonical_expansion_for_equivalent_recurrence(self):
        db_manager.add_income_source("Pay", 100_000, "Monthly", "2026-01-31")
        adapter = self._dates("2026-01-01")
        canonical = [
            d.isoformat()
            for d in recurrence_dates(
                {"frequency": "monthly", "start_date": "2026-02-28", "anchor_day": 31},
                date(2026, 5, 1),
            )
        ]
        self.assertEqual(adapter, canonical)
        self.assertEqual(adapter[:3], ["2026-02-28", "2026-03-31", "2026-04-30"])


if __name__ == "__main__":
    unittest.main()
