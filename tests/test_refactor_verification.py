"""DB -> contract-engine verification for representative scenarios.

These tests used to read the legacy ``timeline_service`` / ``forecasting`` path.
They now assert the contract meaning directly (MCD-0002 half-open window,
MCD-0008 split low point vs safe-to-spend, MCD-0004 ppm), captured with an
explicit ``as_of`` at the test boundary.
"""

import unittest
import os
from datetime import date, datetime, timedelta

from monte_carlo_ledger import db_manager, decisions, scenario
from fastapi.testclient import TestClient
from monte_carlo_ledger.api import app


class TestRefactorVerification(unittest.TestCase):
    def setUp(self):
        # Use a separate test database
        self.db_path = 'test_ledger_verification.db'
        db_manager.DB_PATH = self.db_path
        if os.path.exists(self.db_path):
            os.remove(self.db_path)
        db_manager.init_db()
        self.api_client = TestClient(app)
        # Clock boundary: capture "today" once for the whole test.
        self.as_of = date.today()
        self.as_of_str = self.as_of.isoformat()

    def tearDown(self):
        if os.path.exists(self.db_path):
            os.remove(self.db_path)

    def _mark_past_occurrences_paid(self):
        end_str = (self.as_of + timedelta(days=30)).isoformat()
        db_manager.sync_bill_occurrences(self.as_of_str, end_str)
        with db_manager.get_db_connection() as conn:
            with conn:
                conn.execute(
                    "UPDATE bill_occurrences SET paid = 1 WHERE due_date < ?",
                    (self.as_of_str,),
                )

    def test_scenario_1_paycheck_then_rent(self):
        """
        Scenario: Start with 1000.
        Paycheck (2000) was 25 days ago, Monthly -> Next is in ~5 days.
        Rent (1500) is due in 10 days.
        Day 0: 1000 -> Day 5: +2000 (3000) -> Day 10: -1500 (1500).
        Contract low point is the starting balance.
        """
        db_manager.add_transaction(100000, 'System', 'Initial', t_type='Adjustment')
        last_pay = (datetime.now() - timedelta(days=25)).strftime('%Y-%m-%d')
        db_manager.add_income_source("Paycheck", 200000, "Monthly", last_pay)

        due_day = (datetime.now() + timedelta(days=10)).date().day
        db_manager.add_payment("Rent", 150000, "Monthly", due_day)

        self._mark_past_occurrences_paid()

        # Contract forecast: the deterministic low point is the starting balance.
        forecast = decisions.forecast(self.as_of_str, 30)["forecast"]
        self.assertEqual(forecast["minimum_balance_cents"], 100000)
        self.assertEqual(forecast["minimum_balance_date"], self.as_of_str)

        # API: the deterministic low point is reported separately from the
        # quantile-based safe-to-spend (MCD-0008).
        response = self.api_client.get("/safe-to-spend?days_ahead=30")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['projected_low_point_cents'], 100000)
        self.assertLessEqual(
            response.json()['safe_spend_cents'],
            response.json()['projected_low_point_cents'],
        )

    def test_scenario_2_multi_income_overlap(self):
        """
        Two income sources plus a bill that drops the balance to the low point.
        Day 0: 500 -> Day 2: +1000 (1500) -> Day 10: -1200 (300) -> ...
        Contract low point is 300.
        """
        db_manager.add_transaction(50000, 'System', 'Initial', t_type='Adjustment')
        last_a = (datetime.now() - timedelta(days=12)).strftime('%Y-%m-%d')
        db_manager.add_income_source("Job A", 100000, "Bi-weekly", last_a)

        last_b = (datetime.now() - timedelta(days=10)).strftime('%Y-%m-%d')
        db_manager.add_income_source("Job B", 50000, "Monthly", last_b)

        due_day = (datetime.now() + timedelta(days=10)).date().day
        db_manager.add_payment("Large Bill", 120000, "Monthly", due_day)

        self._mark_past_occurrences_paid()

        forecast = decisions.forecast(self.as_of_str, 30)["forecast"]
        self.assertEqual(forecast["minimum_balance_cents"], 30000)

        response = self.api_client.get("/safe-to-spend?days_ahead=30")
        self.assertEqual(response.json()['projected_low_point_cents'], 30000)

    def test_scenario_3_negative_balance_risk(self):
        """Rent exceeds current balance plus the next paycheck -> negative low point."""
        db_manager.add_transaction(50000, 'System', 'Initial', t_type='Adjustment')
        last_pay = (datetime.now() - timedelta(days=26)).strftime('%Y-%m-%d')
        db_manager.add_income_source("Small Pay", 50000, "Monthly", last_pay)

        due_day = (datetime.now() + timedelta(days=10)).date().day
        db_manager.add_payment("Giant Rent", 120000, "Monthly", due_day)

        self._mark_past_occurrences_paid()

        forecast = decisions.forecast(self.as_of_str, 30)["forecast"]
        self.assertEqual(forecast["minimum_balance_cents"], -20000)

        # Contract risk is reproducible and reports a non-zero overdraft chance.
        first = decisions.risk(self.as_of_str, 30, {"runs": 100, "seed": 42})
        second = decisions.risk(self.as_of_str, 30, {"runs": 100, "seed": 42})
        self.assertEqual(first, second)
        self.assertGreater(first["risk"]["negative_balance_probability_ppm"], 0)

    def test_scenario_is_deterministic_and_half_open(self):
        db_manager.add_transaction(50000, 'System', 'Initial', t_type='Adjustment')
        db_manager.add_payment("Rent", 10000, "One-time", self.as_of_str)
        first = scenario.build_scenario(self.as_of_str, 30)
        second = scenario.build_scenario(self.as_of_str, 30)
        self.assertEqual(first, second)
        window_end = (self.as_of + timedelta(days=30)).isoformat()
        self.assertTrue(first["events"])
        self.assertTrue(
            all(self.as_of_str <= e["date"] < window_end for e in first["events"])
        )


if __name__ == "__main__":
    unittest.main()
