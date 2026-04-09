import sqlite3
import os
import unittest
from datetime import datetime, date, timedelta
from monte_carlo_ledger import budget_engine, db_manager, timeline_service

DB_PATH = 'test_regressions.db'

class TestRegressions(unittest.TestCase):
    def setUp(self):
        if os.path.exists(DB_PATH):
            os.remove(DB_PATH)
        db_manager.DB_PATH = DB_PATH
        db_manager.init_db()

    def tearDown(self):
        if os.path.exists(DB_PATH):
            os.remove(DB_PATH)

    def test_regression_A_migration_data_loss(self):
        """
        Verify that v9 migration prioritizes paid=1 records.
        """
        # Manual setup: downgrade to v8 and insert duplicates
        with db_manager.get_db_connection() as conn:
            with conn:
                # IMPORTANT: Since schema.sql now has the UNIQUE index, 
                # we must DROP it to allow inserting duplicates for the test.
                conn.execute("DROP INDEX IF EXISTS idx_occurrences_unique")
                conn.execute("PRAGMA user_version = 8")
                
                conn.execute("INSERT INTO payments (name, amount, recurrence, due_day, due_date) VALUES ('Rent', 100000, 'Monthly', 1, '2024-01-01')")
                cursor = conn.execute("SELECT id FROM payments WHERE name = 'Rent'")
                p_id = cursor.fetchone()[0]
                
                # Insert two occurrences for the same date
                # 1. Unpaid (id 1)
                # 2. Paid (id 2)
                conn.execute("INSERT INTO bill_occurrences (payment_id, due_date, paid) VALUES (?, '2024-01-01', 0)", (p_id,))
                conn.execute("INSERT INTO bill_occurrences (payment_id, due_date, paid, transaction_id) VALUES (?, '2024-01-01', 1, 999)", (p_id,))
        
        # Run migration by calling internal migration directly
        with db_manager.get_db_connection() as conn:
            db_manager._migrate_v8_to_v9(conn)
        
        # Verify result
        with db_manager.get_db_connection() as conn:
            all_rows = conn.execute("SELECT * FROM bill_occurrences").fetchall()
            print(f"DEBUG: bill_occurrences after migration: {len(all_rows)} rows")
            for r in all_rows:
                print(f"  id={r['id']}, p_id={r['payment_id']}, due={r['due_date']}, paid={r['paid']}")
            
            rows = conn.execute("SELECT * FROM bill_occurrences WHERE payment_id = ?", (p_id,)).fetchall()
            self.assertEqual(len(rows), 1, "Should have deduplicated to 1 row")
            self.assertEqual(rows[0]['paid'], 1, "Should have KEPT the paid=1 record")
            self.assertEqual(rows[0]['transaction_id'], 999, "Should have KEPT the transaction link")

    def test_regression_B_asymmetrical_boundary(self):
        """
        Verify that a bill on the end_date is included in the timeline.
        """
        # Setup: Income and Bill on the same day (end of 30-day window)
        # Use a fixed date to avoid today+30 boundary issues
        fixed_today = date(2024, 1, 1)
        end_date = fixed_today + timedelta(days=30) # 2024-01-31
        end_date_str = end_date.strftime('%Y-%m-%d')
        
        print(f"\nDEBUG: Testing boundary at {end_date_str}")
        
        with db_manager.get_db_connection() as conn:
            with conn:
                # Set initial balance
                conn.execute("UPDATE settings SET value = '100000' WHERE key = 'current_balance'")
                
                # Add Income on end_date
                # frequency, last_payday, next_payday
                conn.execute("INSERT INTO income (name, amount, frequency, last_payday, next_payday) VALUES ('Paycheck', 200000, 'One-time', ?, ?)", (end_date_str, end_date_str))
                
                # Add Bill on end_date (stored as POSITIVE)
                conn.execute("INSERT INTO payments (name, amount, recurrence, due_date) VALUES ('Rent', 150000, 'One-time', ?)", (end_date_str,))
            
            # Verify they are in DB
            inc_rows = conn.execute("SELECT * FROM income").fetchall()
            print(f"DEBUG: Income in DB: {len(inc_rows)}")
            pmt_rows = conn.execute("SELECT * FROM payments").fetchall()
            print(f"DEBUG: Payments in DB: {len(pmt_rows)}")
        
        # Build timeline manually to avoid datetime.now() issues
        start_date_str = fixed_today.strftime('%Y-%m-%d')
        bill_events = timeline_service.get_unpaid_bill_events(start_date_str, end_date_str)
        income_events = timeline_service.generate_income_events(start_date_str, end_date_str)
        timeline = timeline_service.merge_and_sort_events(bill_events, income_events)
        
        print(f"DEBUG: Bill events: {len(bill_events)}")
        print(f"DEBUG: Income events: {len(income_events)}")
        
        # Final balance simulation
        # Start: 1000.00
        balance = 100000
        for event in timeline:
            print(f"  Event: {event['date']} {event['name']} {event['amount']}")
            if event['type'] == 'income':
                balance += event['amount']
            else:
                balance += event['amount'] # event['amount'] for bills is already negative in timeline
        
        # Expected: 1000 + 2000 - 1500 = 1500
        # If income <= but bill <, bill will be missing -> 3000
        self.assertEqual(balance, 150000, f"Expected 1500.00, got {balance/100:.2f}. Boundary is likely asymmetrical.")

if __name__ == '__main__':
    unittest.main()
