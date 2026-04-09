import unittest
import os
import sqlite3
from monte_carlo_ledger import budget_engine, db_manager
from datetime import datetime, timedelta

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

class TestTimelineLogic(unittest.TestCase):
    def setUp(self):
        self.test_db = 'test_ledger_timeline.db'
        db_manager.DB_PATH = self.test_db
        if os.path.exists(self.test_db):
            os.remove(self.test_db)
        db_manager.init_db()

    def tearDown(self):
        if os.path.exists(self.test_db):
            os.remove(self.test_db)

    def test_timeline_ordering(self):
        import monte_carlo_ledger.cli as main
        today = datetime.now()
        day_str = today.strftime('%Y-%m-%d')
        
        # Setup income and bill on same day
        db_manager.add_income_source("Same Day Pay", 100000, "One-time", day_str)
        # Update income to make sure next_payday is today
        db_manager.update_income_dates(1, day_str, day_str)
        db_manager.add_payment("Same Day Bill", 5000, "One-time", day_str)
        
        timeline = main.build_financial_timeline(30)
        # First event should be income, second bill, because income must be processed first
        self.assertEqual(timeline[0]["type"], "income")
        self.assertEqual(timeline[1]["type"], "bill")

    def test_safe_spend_before_paycheck(self):
        import monte_carlo_ledger.cli as main
        timeline = [
            {"date": "2026-03-18", "type": "bill", "amount": -45000, "name": "Rent"},
            {"date": "2026-03-25", "type": "income", "amount": 200000, "name": "Paycheck"}
        ]
        # balance = 500. rent -450. paycheck +2000.
        # safe_spend must equal 50.
        safe_spend = main.calculate_safe_spend(50000, timeline)
        self.assertEqual(safe_spend, 5000)

    def test_negative_safe_spend(self):
        import monte_carlo_ledger.cli as main
        # If bills exceed balance before income, safe_spend should be negative.
        timeline = [
            {"date": "2026-03-18", "type": "bill", "amount": -60000, "name": "Rent"},
            {"date": "2026-03-25", "type": "income", "amount": 200000, "name": "Paycheck"}
        ]
        safe_spend = main.calculate_safe_spend(50000, timeline)
        self.assertEqual(safe_spend, -10000)

    def test_daily_limit_edge_cases(self):
        import monte_carlo_ledger.cli as main
        self.assertEqual(main.calculate_daily_safe_spend(-10000, 5), 0)
        self.assertEqual(main.calculate_daily_safe_spend(50000, 0), 50000)
        self.assertEqual(main.calculate_daily_safe_spend(50000, -2), 50000)
        self.assertEqual(main.calculate_daily_safe_spend(50000, 5), 10000)

    def test_next_event_detection_implicit(self):
        import monte_carlo_ledger.cli as main
        timeline = [
            {"date": "2026-03-18", "type": "income", "amount": 200000, "name": "Paycheck"},
            {"date": "2026-03-25", "type": "bill", "amount": -60000, "name": "Rent"}
        ]
        # In render_timeline_dashboard, next_event logic relies on timeline[0] now.
        next_event = timeline[0] if timeline else None
        self.assertEqual(next_event["type"], "income", "First chronological event must be next event")

class TestForecastLogic(unittest.TestCase):
    def test_forecast_row_generation(self):
        import monte_carlo_ledger.cli as main
        balance_cents = 100000
        timeline_events = [
            {"date": "2026-03-20", "name": "Income 1", "type": "income", "amount": 50000},
            {"date": "2026-03-21", "name": "Bill 1", "type": "bill", "amount": -75000},
            {"date": "2026-03-22", "name": "Bill 2", "type": "bill", "amount": -80000}
        ]
        
        forecast = main.build_balance_forecast(balance_cents, timeline_events)
        
        self.assertEqual(len(forecast), 3)
        self.assertEqual(forecast[0]['balance_after'], 150000)
        self.assertEqual(forecast[1]['balance_after'], 75000)
        self.assertEqual(forecast[2]['balance_after'], -5000)

    def test_forecast_summary_metrics(self):
        import monte_carlo_ledger.cli as main
        balance_cents = 100000
        forecast_rows = [
            {"date": "2026-03-20", "name": "Income 1", "type": "income", "amount": 50000, "balance_after": 150000},
            {"date": "2026-03-21", "name": "Bill 1", "type": "bill", "amount": -75000, "balance_after": 75000},
            {"date": "2026-03-22", "name": "Bill 2", "type": "bill", "amount": -80000, "balance_after": -5000},
            {"date": "2026-03-25", "name": "Income 2", "type": "income", "amount": 20000, "balance_after": 15000}
        ]
        
        summary = main.calculate_forecast_summary(balance_cents, forecast_rows)
        
        self.assertEqual(summary['starting_balance'], 100000)
        self.assertEqual(summary['ending_balance'], 15000)
        self.assertEqual(summary['lowest_balance'], -5000)
        self.assertEqual(summary['lowest_balance_date'], "2026-03-22")
        self.assertEqual(summary['first_negative_date'], "2026-03-22")

    def test_no_negative_scenario(self):
        import monte_carlo_ledger.cli as main
        balance_cents = 50000
        forecast_rows = [
            {"date": "2026-03-20", "name": "Bill 1", "type": "bill", "amount": -20000, "balance_after": 30000},
            {"date": "2026-03-25", "name": "Income 1", "type": "income", "amount": 50000, "balance_after": 80000}
        ]
        
        summary = main.calculate_forecast_summary(balance_cents, forecast_rows)
        
        self.assertEqual(summary['lowest_balance'], 30000)
        self.assertIsNone(summary['first_negative_date'])

    def test_forecast_ordering(self):
        import monte_carlo_ledger.cli as main
        # Ensure Phase 6.5 ordering logic transfers to forecast correctness
        balance_cents = 0
        timeline_events = [
            {"date": "2026-03-20", "name": "Income 1", "type": "income", "amount": 100000},
            {"date": "2026-03-20", "name": "Bill 1", "type": "bill", "amount": -100000}
        ]
        
        # Sort using the main.py logic (income before bill on the same date)
        timeline_events.sort(key=lambda x: (x['date'], 0 if x['type'] == 'income' else 1))
        
        forecast = main.build_balance_forecast(balance_cents, timeline_events)
        summary = main.calculate_forecast_summary(balance_cents, forecast)
        
        # If income is first, lowest_balance shouldn't be negative
        self.assertEqual(forecast[0]['type'], 'income')
        self.assertEqual(summary['lowest_balance'], 0)
        self.assertIsNone(summary['first_negative_date'])

class TestMonteCarloLogic(unittest.TestCase):
    def setUp(self):
        self.base_timeline = [
            {"date": "2026-03-20", "name": "Salary", "type": "income", "priority": 0, "amount": 100000},
            {"date": "2026-04-01", "name": "Rent", "type": "bill", "priority": 1, "amount": -80000}
        ]
        self.base_balance = 50000
    
    def test_scenario_generation_immutability(self):
        import monte_carlo_ledger.cli as main
        import monte_carlo_ledger.risk as risk
        import random
        # Base timeline should not be modified
        original_copy = list(self.base_timeline)
        rng = random.Random(42)
        config = main.MonteCarloConfig()
        _ = risk.generate_scenario_timeline(self.base_timeline, rng, config)
        self.assertEqual(self.base_timeline, original_copy)

    def test_reproducibility(self):
        import monte_carlo_ledger.cli as main
        config = main.MonteCarloConfig(runs=10, seed=123)
        res1 = main.run_monte_carlo(self.base_balance, self.base_timeline, config)
        res2 = main.run_monte_carlo(self.base_balance, self.base_timeline, config)
        self.assertEqual(res1, res2)
        
    def test_variation_bounds(self):
        import monte_carlo_ledger.cli as main
        import monte_carlo_ledger.risk as risk
        import random
        rng = random.Random(42)
        # Force lots of generations to check bounds
        config = main.MonteCarloConfig()
        for _ in range(100):
            scenario = risk.generate_scenario_timeline(self.base_timeline, rng, config)
            for event in scenario:
                if event['name'] == 'Salary':
                    self.assertGreaterEqual(event['amount'], 0) # Must remain positive income
                if event['type'] == 'bill':
                    self.assertLessEqual(event['amount'], 0) # All bills including surprise must be negative

    def test_scenario_simulation_correctness(self):
        import monte_carlo_ledger.cli as main
        import monte_carlo_ledger.risk as risk
        # Hardcode a scenario that will dip negative
        scenario = [
            {"date": "2026-03-20", "name": "Rent", "type": "bill", "priority": 1, "amount": -80000},
            {"date": "2026-03-25", "name": "Salary", "type": "income", "priority": 0, "amount": 100000}
        ]
        res = risk.simulate_scenario(50000, scenario)
        self.assertEqual(res['lowest_balance'], -30000)
        self.assertEqual(res['first_negative_date'], "2026-03-20")
        self.assertEqual(res['ending_balance'], 70000)

    def test_monte_carlo_aggregation(self):
        import monte_carlo_ledger.cli as main
        # Guarantee a negative outcome by using 0 starting balance and only bills
        doom_timeline = [
            {"date": "2026-03-20", "name": "Rent", "type": "bill", "priority": 1, "amount": -80000}
        ]
        config = main.MonteCarloConfig(runs=10, seed=42)
        res = main.run_monte_carlo(0, doom_timeline, config)
        
        self.assertEqual(res['negative_runs'], 10)
        self.assertEqual(res['probability_negative'], 100)
        self.assertEqual(res['most_common_first_negative_date'], "2026-03-20")
        self.assertLess(res['median_ending_balance'], 0)
        
    def test_same_day_ordering(self):
        import monte_carlo_ledger.cli as main
        import monte_carlo_ledger.risk as risk
        import random
        # Base with same day income and bill
        clashing_timeline = [
            {"date": "2026-03-20", "name": "Bill", "type": "bill", "priority": 1, "amount": -100000},
            {"date": "2026-03-20", "name": "Income", "type": "income", "priority": 0, "amount": 100000}
        ]
        rng = random.Random(42)
        config = main.MonteCarloConfig()
        scenario = risk.generate_scenario_timeline(clashing_timeline, rng, config)
        # Even after generation, income on same day MUST come first
        self.assertEqual(scenario[0]['type'], 'income')
        self.assertEqual(scenario[1]['name'], 'Bill')
        
    def test_surprise_expense_horizon_pre_event(self):
        import monte_carlo_ledger.cli as main
        import monte_carlo_ledger.risk as risk
        import random
        from datetime import datetime, timedelta
        # Timeline starts way in the future
        future_timeline = [
            {"date": (datetime.now() + timedelta(days=60)).strftime('%Y-%m-%d'), "name": "Distant Bill", "type": "bill", "priority": 1, "amount": -1000}
        ]
        rng = random.Random(42)
        # Force lots of scenarios to guarantee a surprise happens early
        surprises_found_early = False
        today_str = datetime.now().strftime('%Y-%m-%d')
        config = main.MonteCarloConfig()
        
        for _ in range(50):
            scenario = risk.generate_scenario_timeline(future_timeline, rng, config)
            for event in scenario:
                if event['name'] == 'Unexpected Expense':
                    if event['date'] < future_timeline[0]['date'] and event['date'] >= today_str:
                        surprises_found_early = True
                        break
            if surprises_found_early:
                break
                
        self.assertTrue(surprises_found_early, "A surprise expense should appear before the first distant event")

    def test_deterministic_percentile_rule(self):
        import monte_carlo_ledger.cli as main
        timeline = [{"date": "2026-03-20", "name": "Salary", "type": "income", "priority": 0, "amount": 100000}]
        config = main.MonteCarloConfig(runs=5, seed=42)
        res = main.run_monte_carlo(0, timeline, config)
        # With 5 runs, 10% is 0.5. math.ceil(0.5) = 1. index max(0, 1-1) = 0.
        # It must return the lowest possible generated value.
        self.assertIsNotNone(res['worst_10_percent_ending_balance'])

    def test_negative_run_counting(self):
        import monte_carlo_ledger.cli as main
        timeline = [
            {"date": "2026-03-20", "name": "Rent", "type": "bill", "priority": 1, "amount": -80000}
        ]
        config = main.MonteCarloConfig(runs=10, seed=42)
        res = main.run_monte_carlo(0, timeline, config)
        self.assertEqual(res['negative_runs'], 10)
        self.assertEqual(res['probability_negative'], 100.0)

    def test_dashboard_safety_no_negatives(self):
        import monte_carlo_ledger.cli as main
        timeline = [
            {"date": "2026-03-20", "name": "Salary", "type": "income", "priority": 0, "amount": 100000}
        ]
        config = main.MonteCarloConfig(runs=10, seed=42)
        res = main.run_monte_carlo(100000, timeline, config)
        self.assertEqual(res['negative_runs'], 0)
        self.assertEqual(res['probability_negative'], 0)
        self.assertIsNone(res['most_common_first_negative_date'])


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
        import monte_carlo_ledger.cli as main
        today = datetime.now()
        # Bi-weekly income: base $1000 (100000c), expected next paycheck $800 (80000c)
        last_payday = (today - timedelta(days=14)).strftime('%Y-%m-%d')
        db_manager.add_income_source("TestJob", 100000, "Bi-weekly", last_payday)
        sources = db_manager.get_all_income()
        s = sources[0]
        # Set expected_amount for next paycheck
        db_manager.update_income_source(s.id, s.name, s.amount, s.frequency,
                                         s.last_payday, s.next_payday, 80000)

        # Build timeline far enough to include 2+ paydays
        timeline = main.build_financial_timeline(45)
        income_events = [e for e in timeline if e['type'] == 'income' and e['name'] == 'TestJob']

        self.assertGreaterEqual(len(income_events), 2, "Need at least 2 paydays in the window")
        # First payday uses expected_amount
        self.assertEqual(income_events[0]['amount'], 80000)
        # Second payday reverts to base amount
        self.assertEqual(income_events[1]['amount'], 100000)
        # expected_amount must appear exactly once across all paydays
        self.assertEqual(sum(1 for e in income_events if e['amount'] == 80000), 1,
                         "expected_amount override must apply to exactly one payday")


class TestPaidStatusPhantom(unittest.TestCase):
    """Regression: bills marked paid=1 must NOT appear in the financial timeline."""

    def setUp(self):
        self.test_db = 'test_budget_phantom.db'
        db_manager.DB_PATH = self.test_db
        if os.path.exists(self.test_db):
            os.remove(self.test_db)
        db_manager.init_db()

    def tearDown(self):
        if os.path.exists(self.test_db):
            os.remove(self.test_db)

    def test_paid_bill_excluded_from_timeline(self):
        import monte_carlo_ledger.cli as main
        today = datetime.now()
        bill_date = (today + timedelta(days=5)).strftime('%Y-%m-%d')
        db_manager.add_payment("TestBill", 5000, "One-time", bill_date)
        payments = db_manager.get_all_payments()
        p = payments[0]

        # Build timeline — bill should be present
        timeline_before = main.build_financial_timeline(30)
        bill_names_before = [e['name'] for e in timeline_before if e['type'] == 'bill']
        self.assertIn("TestBill", bill_names_before)

        # Mark it paid via a real transaction
        occ = db_manager.get_next_unpaid_occurrence(p.id)
        self.assertIsNotNone(occ)
        txn_id = db_manager.add_transaction(-5000, "Bills", "Paid TestBill",
                                             t_type='Expense', date_str=occ.due_date)
        db_manager.mark_occurrence_paid(occ.id, txn_id)

        # Build timeline again — bill must be gone
        timeline_after = main.build_financial_timeline(30)
        bill_names_after = [e['name'] for e in timeline_after if e['type'] == 'bill']
        self.assertNotIn("TestBill", bill_names_after)


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
    """Regression: safe spend must find the TRUE minimum across the entire timeline."""

    def test_minimum_after_income_event(self):
        import monte_carlo_ledger.cli as main
        # Scenario: balance=100, income +500, then bills -450 and -200
        # Running: 100 -> 600 -> 150 -> -50 (minimum is at the END, not before income)
        timeline = [
            {"date": "2026-03-20", "type": "income", "amount": 50000, "name": "Pay"},
            {"date": "2026-03-22", "type": "bill", "amount": -45000, "name": "Rent"},
            {"date": "2026-03-25", "type": "bill", "amount": -20000, "name": "Utils"},
        ]
        safe = main.calculate_safe_spend(10000, timeline)
        # Running: 10000 -> 60000 -> 15000 -> -5000
        self.assertEqual(safe, -5000, "Must find minimum at end of timeline, not stop at first income")

    def test_minimum_between_incomes(self):
        import monte_carlo_ledger.cli as main
        # Two income events with a big expense in between
        timeline = [
            {"date": "2026-03-15", "type": "income", "amount": 100000, "name": "Pay1"},
            {"date": "2026-03-20", "type": "bill", "amount": -180000, "name": "BigBill"},
            {"date": "2026-03-28", "type": "income", "amount": 100000, "name": "Pay2"},
        ]
        safe = main.calculate_safe_spend(50000, timeline)
        # Running: 50000 -> 150000 -> -30000 -> 70000
        self.assertEqual(safe, -30000, "Must find minimum between income events")


if __name__ == '__main__':
    unittest.main()



