import unittest
import os
import sqlite3
from monte_carlo_ledger import db_manager, scenario
from monte_carlo_ledger.contract import event_rows, run_scenario
from datetime import date, datetime, timedelta


def _scenario_from_events(balance_cents, events, *, as_of="2026-03-15", horizon_days=90):
    """Build a canonical scenario from explicit (date, type, amount, name) tuples."""
    return {
        "scenario_id": "unit",
        "as_of": as_of,
        "horizon_days": horizon_days,
        "starting_balance_cents": balance_cents,
        "events": [
            {"date": d, "amount_cents": a, "type": t, "name": n} for (d, t, a, n) in events
        ],
    }


class TestLedgerLogic(unittest.TestCase):

    def setUp(self):
        # Use a temporary test database
        self.test_db = 'test_ledger_logic.db'
        db_manager.DB_PATH = self.test_db
        if os.path.exists(self.test_db):
            os.remove(self.test_db)
        db_manager.init_db()

    def tearDown(self):
        if os.path.exists(self.test_db):
            os.remove(self.test_db)

    def test_ledger_integrity(self):
        # Initial sum should be 0
        self.assertEqual(db_manager.get_ledger_balance(), 0)

        db_manager.add_transaction(10000, "Income", "Paycheck", t_type='Income')
        db_manager.add_transaction(-2000, "Expense", "Bills", t_type='Expense')

        # Ledger sum should be 8000
        self.assertEqual(db_manager.get_ledger_balance(), 8000)
        # Stored balance should also be 8000
        self.assertEqual(db_manager.get_stored_balance(), 8000)

        is_sync, ledger, stored = db_manager.validate_balance_consistency()
        self.assertTrue(is_sync)

    def test_transaction_sign_enforcement(self):
        # Income must be positive
        with self.assertRaises(ValueError):
            db_manager.add_transaction(-500, "Income", "Negative Income", t_type='Income')

        # Expense must be negative
        with self.assertRaises(ValueError):
            db_manager.add_transaction(500, "Expense", "Positive Expense", t_type='Expense')

        # Adjustment can be either
        db_manager.add_transaction(-500, "Adj", "Adj", t_type='Adjustment')
        db_manager.add_transaction(500, "Adj", "Adj", t_type='Adjustment')

    def test_reporting_exclusions(self):
        db_manager.add_transaction(-1000, "Food", "Dinner", t_type='Expense')
        db_manager.add_transaction(-500, "Correction", "Recon", t_type='Adjustment')

        # Category spend should ONLY include Expenses
        # Note: spend returns raw dicts for reporting
        spend = db_manager.get_spend_by_category()
        self.assertEqual(len(spend), 1)
        self.assertEqual(spend[0]['category'], "Food")
        self.assertEqual(spend[0]['total'], -1000)

    def test_versioned_migration(self):
        os.remove(self.test_db)
        # Create a v1 (implicit v0) float DB
        conn = sqlite3.connect(self.test_db)
        conn.execute("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)")
        conn.execute("INSERT INTO settings VALUES ('current_balance', '250.50')")
        conn.execute("CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount REAL, category TEXT, type TEXT, date TEXT, description TEXT)")
        conn.execute("INSERT INTO transactions (amount, type) VALUES (100.25, 'Income')")
        conn.commit()
        conn.close()

        # Init should trigger migration
        db_manager.init_db()

        # Balance should be 25050
        self.assertEqual(db_manager.get_stored_balance(), 25050)

        # Transaction should be 10025
        with db_manager.get_db_connection() as conn:
            txn = conn.execute("SELECT amount FROM transactions WHERE id=1").fetchone()
            self.assertEqual(txn['amount'], 10025)

    def test_versioned_migration_latest(self):
        """Verify migration to latest version."""
        os.remove(self.test_db)
        # Create a v3 DB
        conn = sqlite3.connect(self.test_db)
        conn.execute("PRAGMA user_version = 3")
        conn.execute("CREATE TABLE settings (key TEXT PRIMARY KEY, value ANY)")
        conn.execute("INSERT INTO settings VALUES ('current_balance', 5000)")
        conn.execute("CREATE TABLE transactions (id INTEGER PRIMARY KEY, amount REAL, category TEXT, date TEXT, description TEXT)")
        conn.commit()
        conn.close()

        # Init should trigger migration to the latest schema
        db_manager.init_db()

        with db_manager.get_db_connection() as conn:
            v = conn.execute("PRAGMA user_version").fetchone()[0]
            self.assertEqual(v, 10)

            # Verify type column exists
            res = conn.execute("PRAGMA table_info(transactions)").fetchall()
            cols = [r[1] for r in res]
            self.assertIn('type', cols)

    def test_occurrence_based_obligations(self):
        # 1. Setup payment (one-time bill due in 5 days)
        today = datetime.now()
        bill_date = (today + timedelta(days=5)).strftime('%Y-%m-%d')
        db_manager.add_payment("Rent", 100000, "One-time", bill_date)
        payments = db_manager.get_all_payments()
        p = payments[0]

        # 2. Setup income to define payday window
        next_payday = (today + timedelta(days=15)).strftime('%Y-%m-%d')
        db_manager.add_income_source("Salary", 200000, "Monthly", today.strftime('%Y-%m-%d'))
        db_manager.update_income_dates(1, today.strftime('%Y-%m-%d'), next_payday)

        today_str = today.strftime('%Y-%m-%d')

        # 3. Calculate initial obligations
        obs_initial = db_manager.get_obligations_total(today_str, next_payday)
        self.assertEqual(obs_initial, 100000)

        # 4. Find the occurrence and mark paid
        occ = db_manager.get_next_unpaid_occurrence(p.id)
        self.assertIsNotNone(occ)

        # Create a real Expense transaction to satisfy linking guards
        txn_id = db_manager.add_transaction(-100000, "Bills", "Paid Rent", t_type='Expense', date_str=occ.due_date)
        db_manager.mark_occurrence_paid(occ.id, txn_id)

        # 5. Re-calculate obligations and assert decrease
        obs_after = db_manager.get_obligations_total(today_str, next_payday)
        self.assertEqual(obs_after, 0)

        # 6. Verify get_unpaid_occurrences no longer returns it
        unpaid = db_manager.get_unpaid_occurrences(today_str, next_payday)
        self.assertNotIn(occ.id, [u.id for u in unpaid])

    def test_multi_income_obligations(self):
        # 1. Setup two income sources with different next paydays
        today = datetime.now()
        payday_early = (today + timedelta(days=5)).strftime('%Y-%m-%d')
        payday_late = (today + timedelta(days=20)).strftime('%Y-%m-%d')

        db_manager.add_income_source("Early Pay", 100000, "Monthly", (today - timedelta(days=25)).strftime('%Y-%m-%d'))
        db_manager.add_income_source("Late Pay", 50000, "Monthly", (today - timedelta(days=10)).strftime('%Y-%m-%d'))

        # Verify both exist
        sources = db_manager.get_all_income()
        self.assertEqual(len(sources), 2)

        # 2. Setup a bill that falls between the two paydays
        # If today is Day 0, bill on Day 10. Early payday Day 5. Late payday Day 20.
        bill_date = (today + timedelta(days=10)).strftime('%Y-%m-%d')
        db_manager.add_payment("Mid-Month Bill", 5000, "One-time", bill_date)

        today_str = today.strftime('%Y-%m-%d')

        # 3. Calculate obligations using the soonest payday
        sources = db_manager.get_all_income()
        soonest_payday = min(s.next_payday for s in sources)

        obs = db_manager.get_obligations_total(today_str, soonest_payday)
        self.assertEqual(obs, 0)

        # 4. If we look further to the late payday (Day 20), it should be counted
        obs_far = db_manager.get_obligations_total(today_str, payday_late)
        self.assertEqual(obs_far, 5000)


class TestCanonicalTimeline(unittest.TestCase):
    """The interactive timeline is the canonical scenario, not a second expansion."""

    def setUp(self):
        self.test_db = 'test_ledger_timeline.db'
        db_manager.DB_PATH = self.test_db
        if os.path.exists(self.test_db):
            os.remove(self.test_db)
        db_manager.init_db()

    def tearDown(self):
        if os.path.exists(self.test_db):
            os.remove(self.test_db)

    def test_same_day_income_orders_before_expense(self):
        today = datetime.now().strftime('%Y-%m-%d')
        db_manager.add_income_source("Same Day Pay", 100000, "One-time", today)
        db_manager.update_income_dates(1, today, today)
        db_manager.add_payment("Same Day Bill", 5000, "One-time", today)

        built = scenario.build_scenario(today, 30, read_only=False)
        rows = event_rows(built)
        self.assertGreaterEqual(len(rows), 2)
        self.assertEqual(rows[0]["type"], "income")
        self.assertEqual(rows[1]["type"], "expense")


class TestCanonicalForecast(unittest.TestCase):
    def test_forecast_row_generation(self):
        scenario_doc = _scenario_from_events(100000, [
            ("2026-03-20", "income", 50000, "Income 1"),
            ("2026-03-21", "expense", -75000, "Bill 1"),
            ("2026-03-22", "expense", -80000, "Bill 2"),
        ])
        rows = event_rows(scenario_doc)
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0]['balance_after'], 150000)
        self.assertEqual(rows[1]['balance_after'], 75000)
        self.assertEqual(rows[2]['balance_after'], -5000)

    def test_forecast_summary_metrics(self):
        scenario_doc = _scenario_from_events(100000, [
            ("2026-03-20", "income", 50000, "Income 1"),
            ("2026-03-21", "expense", -75000, "Bill 1"),
            ("2026-03-22", "expense", -80000, "Bill 2"),
            ("2026-03-25", "income", 20000, "Income 2"),
        ])
        forecast = run_scenario(scenario_doc)["forecast"]
        self.assertEqual(forecast['minimum_balance_cents'], -5000)
        self.assertEqual(forecast['minimum_balance_date'], "2026-03-22")
        self.assertEqual(forecast['ending_balance_cents'], 15000)
        self.assertEqual(forecast['first_negative_date'], "2026-03-22")

    def test_no_negative_scenario(self):
        scenario_doc = _scenario_from_events(50000, [
            ("2026-03-20", "expense", -20000, "Bill 1"),
            ("2026-03-25", "income", 50000, "Income 1"),
        ])
        forecast = run_scenario(scenario_doc)["forecast"]
        self.assertEqual(forecast['minimum_balance_cents'], 30000)
        self.assertIsNone(forecast['first_negative_date'])

    def test_forecast_ordering(self):
        scenario_doc = _scenario_from_events(0, [
            ("2026-03-20", "income", 100000, "Income 1"),
            ("2026-03-20", "expense", -100000, "Bill 1"),
        ])
        rows = event_rows(scenario_doc)
        forecast = run_scenario(scenario_doc)["forecast"]
        self.assertEqual(rows[0]['type'], 'income')
        self.assertEqual(forecast['minimum_balance_cents'], 0)
        self.assertIsNone(forecast['first_negative_date'])


class TestCanonicalRisk(unittest.TestCase):
    """Monte Carlo is the canonical engine: deterministic, ppm, quantified."""

    def _scenario(self, *, runs=50, seed=42):
        return {
            "scenario_id": "risk",
            "as_of": "2026-03-15",
            "horizon_days": 90,
            "starting_balance_cents": 50000,
            "events": [
                {"date": "2026-03-20", "amount_cents": 100000, "type": "income", "name": "Salary"},
                {"date": "2026-04-01", "amount_cents": -80000, "type": "expense", "name": "Rent"},
            ],
            "simulation": {"runs": runs, "seed": seed},
        }

    def test_determinism(self):
        self.assertEqual(run_scenario(self._scenario()), run_scenario(self._scenario()))

    def test_probability_is_ppm_and_percentiles_ordered(self):
        risk = run_scenario(self._scenario())["risk"]
        self.assertGreaterEqual(risk["negative_balance_probability_ppm"], 0)
        self.assertLessEqual(risk["negative_balance_probability_ppm"], 1_000_000)
        self.assertLessEqual(risk["minimum_balance_p10_cents"], risk["minimum_balance_p50_cents"])
        self.assertLessEqual(risk["minimum_balance_p50_cents"], risk["minimum_balance_p90_cents"])

    def test_safe_to_spend_is_the_p10_trough_minus_reserve(self):
        risk = run_scenario(self._scenario())["risk"]
        self.assertEqual(risk["safe_to_spend_cents"], risk["minimum_balance_p10_cents"])


class TestProjectionBleed(unittest.TestCase):
    """Regression: expected_amount must apply ONLY to the next projected paycheck."""

    def setUp(self):
        self.test_db = 'test_budget_projection.db'
        db_manager.DB_PATH = self.test_db
        if os.path.exists(self.test_db):
            os.remove(self.test_db)
        db_manager.init_db()

    def tearDown(self):
        if os.path.exists(self.test_db):
            os.remove(self.test_db)

    def test_expected_amount_only_first_payday(self):
        today = datetime.now()
        last_payday = (today - timedelta(days=14)).strftime('%Y-%m-%d')
        db_manager.add_income_source("TestJob", 100000, "Bi-weekly", last_payday)
        s = db_manager.get_all_income()[0]
        db_manager.update_income_source(s.id, s.name, s.amount, s.frequency,
                                        s.last_payday, s.next_payday, 80000)

        as_of = today.strftime('%Y-%m-%d')
        built = scenario.build_scenario(as_of, 45, read_only=True)
        income_amounts = [e["amount_cents"] for e in built["events"] if e["type"] == "income" and e["name"] == "TestJob"]

        self.assertGreaterEqual(len(income_amounts), 2, "Need at least 2 paydays in the window")
        self.assertEqual(income_amounts[0], 80000)
        self.assertEqual(income_amounts[1], 100000)
        self.assertEqual(sum(1 for a in income_amounts if a == 80000), 1)


class TestPaidStatusPhantom(unittest.TestCase):
    """Regression: bills marked paid=1 must NOT appear in the canonical scenario."""

    def setUp(self):
        self.test_db = 'test_budget_phantom.db'
        db_manager.DB_PATH = self.test_db
        if os.path.exists(self.test_db):
            os.remove(self.test_db)
        db_manager.init_db()

    def tearDown(self):
        if os.path.exists(self.test_db):
            os.remove(self.test_db)

    def test_paid_bill_excluded_from_scenario(self):
        today = datetime.now()
        bill_date = (today + timedelta(days=5)).strftime('%Y-%m-%d')
        db_manager.add_payment("TestBill", 5000, "One-time", bill_date)
        p = db_manager.get_all_payments()[0]
        as_of = today.strftime('%Y-%m-%d')

        names_before = [e['name'] for e in scenario.build_scenario(as_of, 30).get('events', [])]
        self.assertIn("TestBill", names_before)

        occ = db_manager.get_next_unpaid_occurrence(p.id)
        self.assertIsNotNone(occ)
        txn_id = db_manager.add_transaction(-5000, "Bills", "Paid TestBill",
                                            t_type='Expense', date_str=occ.due_date)
        db_manager.mark_occurrence_paid(occ.id, txn_id)

        names_after = [e['name'] for e in scenario.build_scenario(as_of, 30).get('events', [])]
        self.assertNotIn("TestBill", names_after)


class TestOccurrenceLinkingIntegrity(unittest.TestCase):
    """Regression: mark_occurrence_paid must enforce txn exists, type=Expense, and amount match."""

    def setUp(self):
        self.test_db = 'test_budget_linking.db'
        db_manager.DB_PATH = self.test_db
        if os.path.exists(self.test_db):
            os.remove(self.test_db)
        db_manager.init_db()

    def tearDown(self):
        if os.path.exists(self.test_db):
            os.remove(self.test_db)

    def _setup_occurrence(self):
        today = datetime.now()
        bill_date = (today + timedelta(days=5)).strftime('%Y-%m-%d')
        db_manager.add_payment("LinkTest", 5000, "One-time", bill_date)
        today_str = today.strftime('%Y-%m-%d')
        end_str = (today + timedelta(days=30)).strftime('%Y-%m-%d')
        db_manager.sync_bill_occurrences(today_str, end_str)
        payments = db_manager.get_all_payments()
        occ = db_manager.get_next_unpaid_occurrence(payments[0].id)
        return occ

    def test_reject_nonexistent_transaction(self):
        occ = self._setup_occurrence()
        with self.assertRaisesRegex(ValueError, "Transaction not found"):
            db_manager.mark_occurrence_paid(occ.id, 99999)

    def test_reject_income_transaction_type(self):
        occ = self._setup_occurrence()
        txn_id = db_manager.add_transaction(5000, "Income", "Paycheck", t_type='Income')
        with self.assertRaisesRegex(ValueError, "Transaction must be an Expense"):
            db_manager.mark_occurrence_paid(occ.id, txn_id)

    def test_reject_amount_mismatch(self):
        occ = self._setup_occurrence()
        # Bill is 5000 but transaction is 9999
        txn_id = db_manager.add_transaction(-9999, "Bills", "Wrong amount", t_type='Expense')
        with self.assertRaisesRegex(ValueError, "Transaction amount does not match"):
            db_manager.mark_occurrence_paid(occ.id, txn_id)

    def test_valid_linking_success_path(self):
        """Success path: valid Expense with correct amount must link and mark paid."""
        occ = self._setup_occurrence()
        txn_id = db_manager.add_transaction(-5000, "Bills", "Paid LinkTest", t_type='Expense')
        db_manager.mark_occurrence_paid(occ.id, txn_id)
        # Occurrence should now be paid
        payments = db_manager.get_all_payments()
        remaining = db_manager.get_next_unpaid_occurrence(payments[0].id)
        self.assertIsNone(remaining, "Occurrence should be marked paid after valid linking")


class TestSafeSpendGlobalMinimum(unittest.TestCase):
    """The canonical minimum must be the true minimum across the entire horizon."""

    def test_minimum_after_income_event(self):
        scenario_doc = _scenario_from_events(10000, [
            ("2026-03-20", "income", 50000, "Pay"),
            ("2026-03-22", "expense", -45000, "Rent"),
            ("2026-03-25", "expense", -20000, "Utils"),
        ])
        forecast = run_scenario(scenario_doc)["forecast"]
        self.assertEqual(forecast["minimum_balance_cents"], -5000)

    def test_minimum_between_incomes(self):
        scenario_doc = _scenario_from_events(50000, [
            ("2026-03-15", "income", 100000, "Pay1"),
            ("2026-03-20", "expense", -180000, "BigBill"),
            ("2026-03-28", "income", 100000, "Pay2"),
        ])
        forecast = run_scenario(scenario_doc)["forecast"]
        self.assertEqual(forecast["minimum_balance_cents"], -30000)


if __name__ == '__main__':
    unittest.main()
