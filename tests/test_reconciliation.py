"""Focused tests for reconciling posted (dated) cash against a bank balance.

The cached balance intentionally tracks every ledger row, including future-dated
income and bills. A real bank balance only contains cash posted through today, so
reconciliation must adjust the dated basis and leave future rows untouched.
"""

import os
import tempfile
import unittest
from unittest.mock import patch

from monte_carlo_ledger import db_manager, workflow_account

TODAY = "2026-11-25"
FUTURE = "2026-12-05"
OPENING_CENTS = 50_000          # $500 already posted
FUTURE_CREDIT_CENTS = 80_000    # $800 dated in the future
ALL_DATED_CENTS = OPENING_CENTS + FUTURE_CREDIT_CENTS
ACTUAL_CENTS = 46_000           # $460 actual bank balance


class ReconciliationTestCase(unittest.TestCase):
    def setUp(self):
        self._tmpdir = tempfile.TemporaryDirectory()
        self._previous_db_path = db_manager.DB_PATH
        db_manager.DB_PATH = os.path.join(self._tmpdir.name, "ledger.db")
        db_manager.init_db()
        db_manager.add_transaction(
            OPENING_CENTS, "Income", "Current cash", t_type="Income", date_str=TODAY
        )
        self.future_id = db_manager.add_transaction(
            FUTURE_CREDIT_CENTS,
            "Income",
            "Future credit",
            t_type="Income",
            date_str=FUTURE,
        )

    def tearDown(self):
        db_manager.DB_PATH = self._previous_db_path
        self._tmpdir.cleanup()

    def _transactions(self):
        with db_manager.get_db_connection() as conn:
            return [
                dict(row)
                for row in conn.execute(
                    "SELECT * FROM transactions ORDER BY id ASC"
                ).fetchall()
            ]

    def _run_reconcile(self, inputs):
        with patch("monte_carlo_ledger.workflow_account.clear_screen"), patch(
            "monte_carlo_ledger.workflow_account.wait_for_user"
        ), patch("builtins.input", side_effect=inputs):
            workflow_account.reconcile_flow(as_of=TODAY)

    def test_dated_basis_excludes_future_rows(self):
        self.assertEqual(
            db_manager.get_ledger_balance_through(TODAY), OPENING_CENTS
        )
        # The all-dated API and cached invariant are unchanged.
        self.assertEqual(db_manager.get_ledger_balance(), ALL_DATED_CENTS)
        self.assertEqual(db_manager.get_stored_balance(), ALL_DATED_CENTS)
        self.assertEqual(
            db_manager.validate_balance_consistency(),
            (True, ALL_DATED_CENTS, ALL_DATED_CENTS),
        )

    def test_reconcile_to_actual_adjusts_only_posted_cash(self):
        # 6 > 1 > 460 > default reason > back
        self._run_reconcile(["1", "460", "", "3"])

        rows = self._transactions()
        self.assertEqual(len(rows), 3)
        adjustment = rows[-1]
        self.assertEqual(adjustment["amount"], ACTUAL_CENTS - OPENING_CENTS)  # -$40
        self.assertEqual(adjustment["type"], "Adjustment")
        self.assertEqual(adjustment["date"], TODAY)
        self.assertEqual(
            adjustment["description"],
            "Reconciliation adjustment (-$40.00)",
        )

        future = next(row for row in rows if row["id"] == self.future_id)
        self.assertEqual(future["amount"], FUTURE_CREDIT_CENTS)
        self.assertEqual(future["date"], FUTURE)

        self.assertEqual(db_manager.get_ledger_balance_through(TODAY), ACTUAL_CENTS)
        self.assertEqual(
            db_manager.get_ledger_balance(), ACTUAL_CENTS + FUTURE_CREDIT_CENTS
        )
        self.assertEqual(
            db_manager.get_stored_balance(), ACTUAL_CENTS + FUTURE_CREDIT_CENTS
        )
        self.assertEqual(
            db_manager.validate_balance_consistency(),
            (
                True,
                ACTUAL_CENTS + FUTURE_CREDIT_CENTS,
                ACTUAL_CENTS + FUTURE_CREDIT_CENTS,
            ),
        )

    def test_repeated_reconcile_with_same_actual_is_a_noop(self):
        self._run_reconcile(["1", "460", "", "3"])
        rows_after_first = self._transactions()

        # Second pass: no reason prompt, no new row.
        self._run_reconcile(["1", "460", "3"])

        self.assertEqual(self._transactions(), rows_after_first)
        self.assertEqual(db_manager.get_ledger_balance_through(TODAY), ACTUAL_CENTS)
        self.assertEqual(
            db_manager.get_ledger_balance(), ACTUAL_CENTS + FUTURE_CREDIT_CENTS
        )

    def test_reconcile_zero_and_overdrawn_bank_balances(self):
        self._run_reconcile(["1", "0", "", "1", "-$12.34", "", "1", "-12.34", "3"])

        rows = self._transactions()
        self.assertEqual([row["amount"] for row in rows], [
            OPENING_CENTS, FUTURE_CREDIT_CENTS, -OPENING_CENTS, -1_234,
        ])
        self.assertEqual([row["date"] for row in rows[2:]], [TODAY, TODAY])
        self.assertEqual(db_manager.get_ledger_balance_through(TODAY), -1_234)
        self.assertEqual(db_manager.get_stored_balance(), FUTURE_CREDIT_CENTS - 1_234)

    def test_zero_delta_rechecks_the_ledger_before_declaring_noop(self):
        answers = iter(["1", "460", "3"])

        def input_with_another_write(_prompt):
            answer = next(answers)
            if answer == "460":
                db_manager.add_transaction(
                    -4_000, "Groceries", "Posted while the form was open", date_str=TODAY
                )
            return answer

        self._run_reconcile(input_with_another_write)

        rows = self._transactions()
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[-1]["description"], "Posted while the form was open")
        self.assertEqual(db_manager.get_ledger_balance_through(TODAY), ACTUAL_CENTS)

    def test_as_of_is_normalized_to_iso(self):
        self.assertEqual(
            db_manager.get_ledger_balance_through("11/25/2026"), OPENING_CENTS
        )

        delta = db_manager.reconcile_cash_balance(
            ACTUAL_CENTS, "11/25/2026", "Reconciliation adjustment"
        )

        self.assertEqual(delta, ACTUAL_CENTS - OPENING_CENTS)
        self.assertEqual(self._transactions()[-1]["date"], TODAY)

    def test_description_uses_exact_integer_currency(self):
        delta = db_manager.reconcile_cash_balance(
            173_456, TODAY, "Reconciliation adjustment"
        )

        self.assertEqual(delta, 123_456)
        self.assertEqual(
            self._transactions()[-1]["description"],
            "Reconciliation adjustment (+$1,234.56)",
        )

    def test_zero_delta_writes_nothing(self):
        delta = db_manager.reconcile_cash_balance(
            OPENING_CENTS, TODAY, "Reconciliation adjustment"
        )
        self.assertEqual(delta, 0)
        self.assertEqual(len(self._transactions()), 2)
        self.assertEqual(db_manager.get_stored_balance(), ALL_DATED_CENTS)

    def test_reconcile_refreshes_cached_all_dated_sum(self):
        with db_manager.get_db_connection() as conn:
            with conn:
                conn.execute(
                    "UPDATE settings SET value = 0 WHERE key = 'current_balance'"
                )

        delta = db_manager.reconcile_cash_balance(
            ACTUAL_CENTS, TODAY, "Reconciliation adjustment"
        )

        self.assertEqual(delta, ACTUAL_CENTS - OPENING_CENTS)
        self.assertEqual(
            db_manager.get_stored_balance(), ACTUAL_CENTS + FUTURE_CREDIT_CENTS
        )
        self.assertEqual(
            db_manager.validate_balance_consistency(),
            (
                True,
                ACTUAL_CENTS + FUTURE_CREDIT_CENTS,
                ACTUAL_CENTS + FUTURE_CREDIT_CENTS,
            ),
        )

    def test_option_two_still_syncs_to_all_dated_ledger_sum(self):
        with db_manager.get_db_connection() as conn:
            with conn:
                conn.execute(
                    "UPDATE settings SET value = 1 WHERE key = 'current_balance'"
                )

        self._run_reconcile(["2", "3"])

        self.assertEqual(db_manager.get_stored_balance(), ALL_DATED_CENTS)
        self.assertEqual(len(self._transactions()), 2)


if __name__ == "__main__":
    unittest.main()
