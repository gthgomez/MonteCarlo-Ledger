import unittest
import os
from datetime import datetime, timedelta

import db_manager
import timeline_service
import main
from monte_carlo_config import MonteCarloConfig
from fastapi.testclient import TestClient
from api import app

class TestRefactorVerification(unittest.TestCase):
    def setUp(self):
        # Use a separate test database
        self.db_path = 'test_ledger_verification.db'
        db_manager.DB_PATH = self.db_path
        if os.path.exists(self.db_path):
            os.remove(self.db_path)
        db_manager.init_db()
        self.api_client = TestClient(app)

    def tearDown(self):
        if os.path.exists(self.db_path):
            os.remove(self.db_path)

    def test_scenario_1_paycheck_then_rent(self):
        """
        Scenario: Start with 1000.
        Paycheck (2000) was 25 days ago, Monthly -> Next is in ~5 days.
        Rent (1500) is due in 10 days.
        Sequence:
        Day 0: 1000
        Day 5: +2000 (3000)
        Day 10: -1500 (1500)
        Minima is 1000 (Today).
        """
        # 1. Setup Data
        db_manager.add_transaction(100000, 'System', 'Initial', t_type='Adjustment')
        # Last pay 25 days ago means next is in 5-6 days
        last_pay = (datetime.now() - timedelta(days=25)).strftime('%Y-%m-%d')
        db_manager.add_income_source("Paycheck", 200000, "Monthly", last_pay)
        
        # Rent due on Day 28 (which is in 10 days if today is 18th)
        due_day = (datetime.now() + timedelta(days=10)).date().day
        db_manager.add_payment("Rent", 150000, "Monthly", due_day)
        
        # 2. Verify Timeline
        today_str = datetime.now().strftime('%Y-%m-%d')
        end_date_str = (datetime.now() + timedelta(days=30)).strftime('%Y-%m-%d')
        
        # We must sync FIRST so the occurrences exist, then mark them paid to isolate the test
        db_manager.sync_bill_occurrences(today_str, end_date_str)
        with db_manager.get_db_connection() as conn:
            with conn:
                conn.execute("UPDATE bill_occurrences SET paid = 1 WHERE due_date < ?", (today_str,))
        
        timeline = timeline_service.build_financial_timeline(30)
        self.assertEqual(len(timeline), 2)
        
        # 3. Verify Safe Spend
        safe_spend = main.calculate_safe_spend(100000, timeline)
        self.assertEqual(safe_spend, 100000)
        
        # 4. API Consistency
        response = self.api_client.get("/safe-to-spend?days_ahead=30")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['safe_spend_cents'], 100000)

    def test_scenario_2_multi_income_overlap(self):
        """
        Scenario: Two income sources, bi-weekly and monthly.
        Target: Ensure $300 safe spend (after accounting for a bill that drops us).
        """
        db_manager.add_transaction(50000, 'System', 'Initial', t_type='Adjustment')
        # Job A: Paid 12 days ago -> next in 2 days
        last_a = (datetime.now() - timedelta(days=12)).strftime('%Y-%m-%d')
        db_manager.add_income_source("Job A", 100000, "Bi-weekly", last_a)
        
        # Job B: Paid 10 days ago -> next in 20/21 days
        last_b = (datetime.now() - timedelta(days=10)).strftime('%Y-%m-%d')
        db_manager.add_income_source("Job B", 50000, "Monthly", last_b)
        
        # Bill: 1200 on Day 10
        due_day = (datetime.now() + timedelta(days=10)).date().day
        db_manager.add_payment("Large Bill", 120000, "Monthly", due_day)
        
        today_str = datetime.now().strftime('%Y-%m-%d')
        end_date_str = (datetime.now() + timedelta(days=30)).strftime('%Y-%m-%d')
        
        # Sync so they exist, then mark paid
        db_manager.sync_bill_occurrences(today_str, end_date_str)
        with db_manager.get_db_connection() as conn:
            with conn:
                conn.execute("UPDATE bill_occurrences SET paid = 1 WHERE due_date < ?", (today_str,))
                
        timeline = timeline_service.build_financial_timeline(30)
        # Sequence:
        # Day 0: 500
        # Day 2: +1000 (1500)
        # Day 10: -1200 (300)
        # Day 16: +1000 (1300)
        # ...
        # Minima is 300 (Day 10).
        safe_spend = main.calculate_safe_spend(50000, timeline)
        self.assertEqual(safe_spend, 30000)
        
        # API Check
        response = self.api_client.get("/safe-to-spend?days_ahead=30")
        self.assertEqual(response.json()['safe_spend_cents'], 30000)

    def test_scenario_3_negative_balance_risk(self):
        """
        Scenario: Rent is more than current balance + next paycheck.
        """
        db_manager.add_transaction(50000, 'System', 'Initial', t_type='Adjustment')
        last_pay = (datetime.now() - timedelta(days=26)).strftime('%Y-%m-%d')
        db_manager.add_income_source("Small Pay", 50000, "Monthly", last_pay)
        
        due_day = (datetime.now() + timedelta(days=10)).date().day
        db_manager.add_payment("Giant Rent", 120000, "Monthly", due_day)
        
        today_str = datetime.now().strftime('%Y-%m-%d')
        end_date_str = (datetime.now() + timedelta(days=30)).strftime('%Y-%m-%d')
        
        # Sync so they exist, then mark paid
        db_manager.sync_bill_occurrences(today_str, end_date_str)
        with db_manager.get_db_connection() as conn:
            with conn:
                conn.execute("UPDATE bill_occurrences SET paid = 1 WHERE due_date < ?", (today_str,))
                
        timeline = timeline_service.build_financial_timeline(30)
        # Day 0: 500
        # Day 5 (approx): +500 (1000)
        # Day 10: -1200 (-200)
        safe_spend = main.calculate_safe_spend(50000, timeline)
        self.assertEqual(safe_spend, -20000)
        
        # Check Monte Carlo reproducibility
        config = MonteCarloConfig(runs=100, seed=42)
        res1 = main.run_monte_carlo(50000, timeline, config)
        res2 = main.run_monte_carlo(50000, timeline, config)
        self.assertEqual(res1['median_ending_balance'], res2['median_ending_balance'])
        self.assertGreater(res1['probability_negative'], 0)

if __name__ == "__main__":
    unittest.main()
