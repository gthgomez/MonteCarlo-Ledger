import unittest
import os
from datetime import datetime, timedelta

import db_manager  # type: ignore[import-not-found]

class TestPaymentDeletionOrphans(unittest.TestCase):
    """
    Validates that deleting a payment preserves relational integrity.
    This regression protects against the previous orphaned-occurrence bug.
    """

    def setUp(self):
        self.test_db = 'test_persistence_orphans.db'
        db_manager.DB_PATH = self.test_db
        if os.path.exists(self.test_db):
            os.remove(self.test_db)
        db_manager.init_db()

    def tearDown(self):
        if os.path.exists(self.test_db):
            os.remove(self.test_db)

    def test_deleted_payment_removes_occurrences(self):
        today = datetime.now()
        today_str = today.strftime('%Y-%m-%d')
        lookahead_str = (today + timedelta(days=60)).strftime('%Y-%m-%d')

        # 1. Create a payment constraint
        # Name: Netflix, Amount: 15.00, Recurrence: Monthly, Due Day: 1
        db_manager.add_payment("Netflix", 1500, "Monthly", 1)

        # Confirm payment creation
        payments = db_manager.get_all_payments()
        self.assertEqual(len(payments), 1)
        payment_id = payments[0].id

        # 2. Sync bill occurrences (generates occurrence records for the time window)
        db_manager.sync_bill_occurrences(today_str, lookahead_str)

        # 3. Verify occurrences are populated in the DB natively
        with db_manager.get_db_connection() as conn:
            occurrences_before = conn.execute("SELECT id FROM bill_occurrences WHERE payment_id = ?", (payment_id,)).fetchall()
            self.assertGreater(len(occurrences_before), 0, "Occurrences should have generated.")

        # Obligations should be active
        obs_before = db_manager.get_obligations_total(today_str, lookahead_str)
        self.assertGreater(obs_before, 0)

        # 4. Action: Delete the payment
        db_manager.delete_payment(payment_id)

        # Confirm payment is deleted
        self.assertEqual(len(db_manager.get_all_payments()), 0)

        # 5. Integrity Verification: occurrences must be removed with the parent payment
        with db_manager.get_db_connection() as conn:
            occurrences_after = conn.execute("SELECT id FROM bill_occurrences WHERE payment_id = ?", (payment_id,)).fetchall()
            self.assertEqual(len(occurrences_after), 0, "Deleting a payment must not leave orphaned occurrences.")

        # 6. Obligation queries should also reflect the cleanup directly
        obs_after = db_manager.get_obligations_total(today_str, lookahead_str)
        self.assertEqual(obs_after, 0, "Deleted payments should no longer contribute obligations.")

if __name__ == '__main__':
    unittest.main()
