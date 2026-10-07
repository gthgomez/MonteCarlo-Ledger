"""End-to-end integration: DB -> canonical scenario -> contract engine -> API.

Replaces the legacy verification tests that ran the deleted ``forecasting`` /
``risk`` / ``timeline_service`` modules. All financial conclusions here come from the
canonical contract engine, so the assertions are contract statements, not "whatever
the old engine printed".
"""

import os
import unittest
from datetime import date, datetime, timedelta

from fastapi.testclient import TestClient

from monte_carlo_ledger import db_manager, decisions, scenario
from monte_carlo_ledger.api import app
from monte_carlo_ledger.contract import run_scenario


class TestRefactorVerification(unittest.TestCase):
    def setUp(self):
        self.db_path = 'test_ledger_verification.db'
        db_manager.DB_PATH = self.db_path
        if os.path.exists(self.db_path):
            os.remove(self.db_path)
        db_manager.init_db()
        self.api_client = TestClient(app)

    def tearDown(self):
        if os.path.exists(self.db_path):
            os.remove(self.db_path)

    def _as_of(self) -> str:
        return datetime.now().strftime('%Y-%m-%d')

    def test_scenario_1_paycheck_then_rent(self):
        """Start 1000; +2000 paycheck before -1500 rent -> projected low point is the start."""
        db_manager.add_transaction(100000, 'System', 'Initial', t_type='Adjustment')
        last_pay = (datetime.now() - timedelta(days=25)).strftime('%Y-%m-%d')
        db_manager.add_income_source("Paycheck", 200000, "Monthly", last_pay)

        due_day = (datetime.now() + timedelta(days=10)).date().day
        db_manager.add_payment("Rent", 150000, "Monthly", due_day)

        today_str = self._as_of()
        end_date_str = (datetime.now() + timedelta(days=30)).strftime('%Y-%m-%d')
        db_manager.sync_bill_occurrences(today_str, end_date_str)
        with db_manager.get_db_connection() as conn:
            with conn:
                conn.execute("UPDATE bill_occurrences SET paid = 1 WHERE due_date < ?", (today_str,))

        built = scenario.build_scenario(today_str, 30, read_only=True)
        result = run_scenario(built)
        self.assertEqual(result["forecast"]["minimum_balance_cents"], 100000)
        self.assertEqual(decisions.forecast(today_str, 30), result)

        response = self.api_client.get("/safe-to-spend?days_ahead=30")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['projected_low_point_cents'], 100000)

    def test_scenario_2_multi_income_overlap(self):
        """Two incomes and a large bill: canonical low point is the post-bill trough."""
        db_manager.add_transaction(50000, 'System', 'Initial', t_type='Adjustment')
        last_a = (datetime.now() - timedelta(days=12)).strftime('%Y-%m-%d')
        db_manager.add_income_source("Job A", 100000, "Bi-weekly", last_a)
        last_b = (datetime.now() - timedelta(days=10)).strftime('%Y-%m-%d')
        db_manager.add_income_source("Job B", 50000, "Monthly", last_b)

        due_day = (datetime.now() + timedelta(days=10)).date().day
        db_manager.add_payment("Large Bill", 120000, "Monthly", due_day)

        today_str = self._as_of()
        end_date_str = (datetime.now() + timedelta(days=30)).strftime('%Y-%m-%d')
        db_manager.sync_bill_occurrences(today_str, end_date_str)
        with db_manager.get_db_connection() as conn:
            with conn:
                conn.execute("UPDATE bill_occurrences SET paid = 1 WHERE due_date < ?", (today_str,))

        built = scenario.build_scenario(today_str, 30, read_only=True)
        result = run_scenario(built)
        self.assertLessEqual(result["forecast"]["minimum_balance_cents"], 50000)

        response = self.api_client.get("/safe-to-spend?days_ahead=30")
        self.assertEqual(
            response.json()['projected_low_point_cents'],
            result["forecast"]["minimum_balance_cents"],
        )

    def test_scenario_3_negative_balance_risk_is_deterministic(self):
        """A bill larger than balance + next paycheck drives the low point negative."""
        db_manager.add_transaction(50000, 'System', 'Initial', t_type='Adjustment')
        last_pay = (datetime.now() - timedelta(days=26)).strftime('%Y-%m-%d')
        db_manager.add_income_source("Small Pay", 50000, "Monthly", last_pay)

        due_day = (datetime.now() + timedelta(days=10)).date().day
        db_manager.add_payment("Giant Rent", 120000, "Monthly", due_day)

        today_str = self._as_of()
        end_date_str = (datetime.now() + timedelta(days=30)).strftime('%Y-%m-%d')
        db_manager.sync_bill_occurrences(today_str, end_date_str)
        with db_manager.get_db_connection() as conn:
            with conn:
                conn.execute("UPDATE bill_occurrences SET paid = 1 WHERE due_date < ?", (today_str,))

        built = scenario.build_scenario(today_str, 30, read_only=True)
        result = run_scenario(built)
        self.assertLess(result["forecast"]["minimum_balance_cents"], 0)

        # Canonical simulation is a pure function of the scenario + seed (MCD-0006).
        res1 = decisions.risk(today_str, 30, {"seed": 42, "runs": 100})
        res2 = decisions.risk(today_str, 30, {"seed": 42, "runs": 100})
        self.assertEqual(res1, res2)
        self.assertGreaterEqual(res1["risk"]["negative_balance_probability_ppm"], 0)


if __name__ == "__main__":
    unittest.main()
