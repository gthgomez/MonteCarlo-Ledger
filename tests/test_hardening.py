import unittest
import os
from datetime import date, timedelta
from unittest.mock import patch

from monte_carlo_ledger import db_manager, scenario

DB_PATH = 'test_ledger_hardening.db'

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

    def test_overdue_bills_are_excluded_from_canonical_scenario(self):
        """MCD-0014: occurrences dated before ``as_of`` are not projected.

        The legacy ``timeline_service`` hoisted a 30-day past-due lookback into the
        forecast window; that behaviour contradicted the contract and has been removed.
        """
        as_of = date.today()
        past_due = (as_of - timedelta(days=5)).strftime('%Y-%m-%d')
        end_date = (as_of + timedelta(days=30)).strftime('%Y-%m-%d')

        with db_manager.get_db_connection() as conn:
            with conn:
                conn.execute(
                    "INSERT INTO payments (name, amount, recurrence, due_date) VALUES ('Past Due Bill', 5000, 'One-time', ?)",
                    (past_due,),
                )

        built = scenario.build_scenario(as_of.strftime('%Y-%m-%d'), 30, read_only=False)
        names = [e["name"] for e in built["events"]]
        self.assertNotIn('Past Due Bill', names, "overdue bills must not be projected (MCD-0014)")
        self.assertGreaterEqual(all(e["date"] >= as_of.strftime('%Y-%m-%d') for e in built["events"]), True)

    def test_future_bill_is_projected(self):
        """A bill inside the half-open window is projected."""
        as_of = date.today()
        future = (as_of + timedelta(days=10)).strftime('%Y-%m-%d')

        db_manager.add_payment('Future Bill', 7500, 'One-time', future)
        built = scenario.build_scenario(as_of.strftime('%Y-%m-%d'), 30, read_only=True)
        names = [e["name"] for e in built["events"]]
        self.assertIn('Future Bill', names)


if __name__ == '__main__':
    unittest.main()
