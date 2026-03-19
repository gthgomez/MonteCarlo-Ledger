import unittest
import sqlite3
import os
import sys
from datetime import datetime, date, timedelta
from unittest.mock import patch, MagicMock

# Ensure local modules can be found
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
if BASE_DIR not in sys.path:
    sys.path.append(BASE_DIR)

import db_manager
import timeline_service

DB_PATH = 'test_hardening.db'

class TestHardening(unittest.TestCase):
    def setUp(self):
        if os.path.exists(DB_PATH):
            os.remove(DB_PATH)
        db_manager.DB_PATH = DB_PATH
        db_manager.init_db()

    def tearDown(self):
        if os.path.exists(DB_PATH):
            os.remove(DB_PATH)

    def test_sqlite_version_check(self):
        """Verify that init_db raises RuntimeError on old SQLite versions."""
        with patch('sqlite3.sqlite_version_info', (3, 24, 9)):
            with self.assertRaises(RuntimeError) as cm:
                db_manager.init_db()
            self.assertIn("SQLite 3.25.0+ is required", str(cm.exception))

    def test_atomic_balance_validation(self):
        """Verify that validate_balance_consistency returns correct status."""
        # Setup: 1000 in ledger, 1000 in stored
        db_manager.add_transaction(1000, "Category", "Desc", t_type='Income')
        # Note: add_transaction updates stored balance automatically in db_manager
        
        is_sync, ledger, stored = db_manager.validate_balance_consistency()
        self.assertTrue(is_sync)
        self.assertEqual(ledger, 1000)
        self.assertEqual(stored, 1000)
        
        # Force desync
        with db_manager.get_db_connection() as conn:
            with conn:
                conn.execute("UPDATE settings SET value = '500' WHERE key = 'current_balance'")
        
        is_sync, ledger, stored = db_manager.validate_balance_consistency()
        self.assertFalse(is_sync)
        self.assertEqual(ledger, 1000)
        self.assertEqual(stored, 500)

    def test_past_due_lookback(self):
        """Verify that unpaid bills from the past are included in the timeline."""
        today = date.today()
        past_due_date = (today - timedelta(days=5)).strftime('%Y-%m-%d')
        today_str = today.strftime('%Y-%m-%d')
        end_date_str = (today + timedelta(days=30)).strftime('%Y-%m-%d')
        
        # Add a one-time bill due 5 days ago
        with db_manager.get_db_connection() as conn:
            with conn:
                conn.execute("INSERT INTO payments (name, amount, recurrence, due_date) VALUES ('Past Due Bill', 5000, 'One-time', ?)", (past_due_date,))
                p_id = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
                # Note: schema.sql has idx_occurrences_unique(payment_id, due_date)
                # sync_bill_occurrences will generate it if we use lookback
        
        # Run sync and get events
        events = timeline_service.get_unpaid_bill_events(today_str, end_date_str, read_only=False)
        
        # Verify past due bill is present
        found = False
        for e in events:
            if e['name'] == 'Past Due Bill':
                found = True
                self.assertEqual(e['date'], past_due_date)
        
        self.assertTrue(found, "Past due bill should be found in timeline even if it's before start_date")

    def test_past_due_projection_lookback(self):
        """Verify that read_only=True path also catches past-due bills."""
        today = date.today()
        past_due_date = (today - timedelta(days=10)).strftime('%Y-%m-%d')
        today_str = today.strftime('%Y-%m-%d')
        end_date_str = (today + timedelta(days=30)).strftime('%Y-%m-%d')
        
        # Add a payment rule (not an occurrence)
        db_manager.add_payment('Missed Utility', 7500, 'One-time', past_due_date)
        
        # Projection (read_only=True) should catch it if lookback works
        events = timeline_service.get_unpaid_bill_events(today_str, end_date_str, read_only=True)
        
        found = False
        for e in events:
            if e['name'] == 'Missed Utility':
                found = True
                self.assertEqual(e['date'], past_due_date)
        
        self.assertTrue(found, "Read-only projection should find past-due payment rules via lookback")

if __name__ == '__main__':
    unittest.main()
