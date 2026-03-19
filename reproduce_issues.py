import unittest
import os
import sqlite3
from datetime import datetime, timedelta
import db_manager
import timeline_service
import domain_rules
from fastapi.testclient import TestClient
from api import app

class TestReproduction(unittest.TestCase):
    def setUp(self):
        self.test_db = 'repro_budget.db'
        db_manager.DB_PATH = self.test_db
        if os.path.exists(self.test_db):
            os.remove(self.test_db)
        db_manager.init_db()
        self.client = TestClient(app)

    def tearDown(self):
        if os.path.exists(self.test_db):
            os.remove(self.test_db)

    def test_issue_1_get_mutation(self):
        """GET /safe-to-spend must not mutate database state."""
        # Setup source
        today = datetime.now()
        bill_date = (today + timedelta(days=5)).strftime('%Y-%m-%d')
        db_manager.add_payment("MutationTest", 1000, "One-time", bill_date)
        
        # Check count before
        with db_manager.get_db_connection() as conn:
            count_before = conn.execute("SELECT COUNT(*) FROM bill_occurrences").fetchone()[0]
        
        # Trigger GET
        response = self.client.get("/safe-to-spend?days_ahead=30")
        self.assertEqual(response.status_code, 200)
        
        # Check count after
        with db_manager.get_db_connection() as conn:
            count_after = conn.execute("SELECT COUNT(*) FROM bill_occurrences").fetchone()[0]
        
        self.assertEqual(count_before, count_after, "GET /safe-to-spend mutated the database!")

    def test_issue_2_duplicate_occurrences(self):
        """bill_occurrences must be protected against duplicates."""
        today = datetime.now()
        bill_date = (today + timedelta(days=10)).strftime('%Y-%m-%d')
        pid = 1
        db_manager.add_payment("DupTest", 1000, "One-time", bill_date)
        
        # With fix: INSERT OR IGNORE and UNIQUE index should prevent duplication
        with db_manager.get_db_connection() as conn:
            with conn:
                conn.execute("INSERT OR IGNORE INTO bill_occurrences (payment_id, due_date) VALUES (?, ?)", (pid, bill_date))
                conn.execute("INSERT OR IGNORE INTO bill_occurrences (payment_id, due_date) VALUES (?, ?)", (pid, bill_date))
        
        with db_manager.get_db_connection() as conn:
            count = conn.execute("SELECT COUNT(*) FROM bill_occurrences WHERE payment_id = ? AND due_date = ?", (pid, bill_date)).fetchone()[0]
        
        self.assertEqual(count, 1, "Expected duplicates to be prevented by unique constraint")

    def test_issue_3_api_stale_balance(self):
        """API must not blindly trust stale stored balance."""
        # 1. Add transaction
        db_manager.add_transaction(10000, "Income", "Initial", t_type='Income')
        
        # 2. Corrupt stored balance directly in DB (bypass db_manager)
        with db_manager.get_db_connection() as conn:
            with conn:
                conn.execute("UPDATE settings SET value = 5000 WHERE key = 'current_balance'")
        
        # 3. Call API
        response = self.client.get("/safe-to-spend")
        self.assertEqual(response.status_code, 409, "Expected 409 Conflict when ledger desync occurs")
        self.assertIn("Ledger desync detected", response.json()['detail'])

    def test_issue_4_zero_dollar_rejection(self):
        """Reject zero-dollar Income and Expense transactions."""
        # Income = 0
        with self.assertRaisesRegex(ValueError, "positive"):
            db_manager.add_transaction(0, "Income", "Zero Income", t_type='Income')
            
        # Expense = 0
        with self.assertRaisesRegex(ValueError, "negative"):
            db_manager.add_transaction(0, "Expense", "Zero Expense", t_type='Expense')

    def test_issue_5_transaction_reuse(self):
        """Prevent reuse of one transaction_id across multiple bill occurrences."""
        today = datetime.now()
        d1 = (today + timedelta(days=5)).strftime('%Y-%m-%d')
        d2 = (today + timedelta(days=10)).strftime('%Y-%m-%d')
        
        db_manager.add_payment("Bill1", 1000, "One-time", d1)
        db_manager.add_payment("Bill2", 1000, "One-time", d2)
        
        db_manager.sync_bill_occurrences(today.strftime('%Y-%m-%d'), (today + timedelta(days=30)).strftime('%Y-%m-%d'))
        
        with db_manager.get_db_connection() as conn:
            occs = conn.execute("SELECT id FROM bill_occurrences ORDER BY id ASC").fetchall()
            occ1_id, occ2_id = occs[0]['id'], occs[1]['id']
            
        txn_id = db_manager.add_transaction(-1000, "Bills", "Single Payment", t_type='Expense')
        
        # Mark first as paid
        db_manager.mark_occurrence_paid(occ1_id, txn_id)
        
        # Try to mark second as paid with SAME txn_id
        with self.assertRaisesRegex(ValueError, "already linked"):
            db_manager.mark_occurrence_paid(occ2_id, txn_id)

    def test_issue_6_timeline_boundary_bug(self):
        """Fix the timeline/income bug causing behavioral equivalence failure."""
        today = datetime.now()
        # End date exactly on payday
        start_date = today.strftime('%Y-%m-%d')
        end_date = (today + timedelta(days=14)).strftime('%Y-%m-%d')
        
        # Bi-weekly income due exactly on end_date
        db_manager.add_income_source("WindowTest", 200000, "Bi-weekly", (today - timedelta(days=14)).strftime('%Y-%m-%d'))
        # next_payday will be today. Next-next will be today + 14 (end_date).
        
        events = timeline_service.generate_income_events(start_date, end_date)
        dates = [e['date'] for e in events]
        
        # With the fix (<= end_dt), it should include end_date
        self.assertIn(end_date, dates, "Expected end_date income to be included after fix")

if __name__ == '__main__':
    unittest.main()
