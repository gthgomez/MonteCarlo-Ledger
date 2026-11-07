"""Snapshot fidelity: every supported field must survive export -> restore -> DB.

The confirmed defect was that ``income.expected_amount`` was omitted from both the
export and the restore, so a backup round trip silently reset an adjusted paycheck.
These tests compare the *persisted database* before and after a round trip, which
would have caught the omission that a snapshot-to-snapshot comparison missed.
"""

import json
import os
import sqlite3
import tempfile
import unittest

from monte_carlo_ledger import db_manager, sync


def _db_state():
    """Read every column that influences financial state directly from SQLite."""
    with db_manager.get_db_connection() as conn:
        state = {}
        for table, columns in {
            "income": "id, name, amount, frequency, last_payday, next_payday, expected_amount",
            "payments": "id, name, amount, due_day, recurrence, due_date, is_auto_withdraw",
            "transactions": "id, amount, category, type, date, description",
            "bill_occurrences": "id, payment_id, due_date, paid, transaction_id",
        }.items():
            rows = conn.execute(f"SELECT {columns} FROM {table} ORDER BY id").fetchall()
            state[table] = [dict(row) for row in rows]
        state["balance"] = db_manager.get_ledger_balance()
    return state


class SnapshotFidelityTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        db_manager.DB_PATH = os.path.join(self.tmp.name, "ledger.db")
        db_manager.init_db()

    def tearDown(self):
        self.tmp.cleanup()

    def _seed_full_ledger(self):
        db_manager.add_transaction(500_000, "System", "Opening", t_type="Adjustment", date_str="2026-10-01")
        db_manager.add_income_source("Pay", 220_000, "Monthly", "2026-01-31")
        db_manager.update_income_source(
            1, "Pay", 220_000, "Monthly", "2026-01-31", "2026-02-28", expected_amount=235_000
        )
        db_manager.add_payment("Rent", 135_000, "Monthly", 1)
        db_manager.add_payment("One-off", 9_900, "One-time", "2026-12-24")
        with db_manager.get_db_connection() as conn:
            with conn:
                conn.execute(
                    "INSERT INTO bill_occurrences (payment_id, due_date, paid, transaction_id) "
                    "VALUES (1, '2026-12-01', 1, 1)"
                )
                conn.execute(
                    "INSERT INTO bill_occurrences (payment_id, due_date, paid, transaction_id) "
                    "VALUES (2, '2026-12-20', 0, NULL)"
                )

    def test_expected_amount_survives_a_real_round_trip(self):
        self._seed_full_ledger()
        before = _db_state()
        self.assertEqual(before["income"][0]["expected_amount"], 235_000)

        exported = sync.export_ledger_snapshot()
        self.assertEqual(exported["version"], "2.1")
        self.assertEqual(exported["incomes"][0]["expected_amount"], 235_000)

        sync.restore_ledger_snapshot(json.loads(json.dumps(exported)))
        after = _db_state()
        self.assertEqual(after["income"][0]["expected_amount"], 235_000)
        for table in ("income", "payments", "transactions", "bill_occurrences"):
            self.assertEqual(after[table], before[table], table)
        self.assertEqual(after["balance"], before["balance"])

    def test_paid_and_moved_occurrences_survive(self):
        self._seed_full_ledger()
        with db_manager.get_db_connection() as conn:
            with conn:
                conn.execute(
                    "UPDATE bill_occurrences SET due_date = '2026-12-03' WHERE payment_id = 1"
                )
        before = _db_state()
        sync.restore_ledger_snapshot(sync.export_ledger_snapshot())
        self.assertEqual(_db_state()["bill_occurrences"], before["bill_occurrences"])

    def test_zero_and_negative_balances_round_trip(self):
        for amount in (0, -123_456):
            with self.subTest(amount=amount):
                with db_manager.get_db_connection() as conn:
                    with conn:
                        conn.execute("DELETE FROM bill_occurrences")
                        conn.execute("DELETE FROM transactions")
                        conn.execute("DELETE FROM payments")
                        conn.execute("DELETE FROM income")
                        if amount:
                            conn.execute(
                                "INSERT INTO transactions (amount, category, type, date, description) "
                                "VALUES (?, 'System', 'Adjustment', '2026-10-01', 'x')",
                                (amount,),
                            )
                        conn.execute(
                            "INSERT OR REPLACE INTO settings (key, value) VALUES ('current_balance', ?)",
                            (amount,),
                        )
                sync.restore_ledger_snapshot(sync.export_ledger_snapshot())
                self.assertEqual(_db_state()["balance"], amount)

    def test_string_identifiers_are_remapped_not_lost(self):
        snapshot = {
            "version": "2.0",
            "updated_at": "2026-11-07T00:00:00+00:00",
            "current_balance_cents": -500,
            "incomes": [
                {"id": "inc-1", "name": "Pay", "amount_cents": 1000, "frequency": "Monthly",
                 "last_payday": "2026-01-31", "next_payday": "2026-02-28"},
            ],
            "payments": [
                {"id": "pmt-1", "name": "Rent", "amount_cents": 1500, "due_day": 1,
                 "recurrence": "Monthly", "due_date": None, "is_auto_withdraw": True},
            ],
            "transactions": [
                {"id": "tx-1", "amount_cents": -1500, "category": "Rent", "type": "Expense",
                 "date": "2026-10-01", "description": "Rent"},
                {"id": "tx-2", "amount_cents": 1000, "category": "Pay", "type": "Income",
                 "date": "2026-10-05", "description": "Pay"},
            ],
            "bill_occurrences": [
                {"id": "occ-1", "payment_id": "pmt-1", "due_date": "2026-10-01",
                 "paid": True, "transaction_id": "tx-1"},
            ],
            "liabilities": [],
        }
        sync.restore_ledger_snapshot(snapshot)
        state = _db_state()
        self.assertEqual(len(state["payments"]), 1)
        self.assertEqual(len(state["transactions"]), 2)
        payment_id = state["payments"][0]["id"]
        tx_ids = {t["id"] for t in state["transactions"]}
        occ = state["bill_occurrences"][0]
        self.assertIn(occ["payment_id"], {payment_id})
        self.assertIn(occ["transaction_id"], tx_ids)
        self.assertEqual(state["balance"], -500)

    def test_liabilities_are_rejected_not_silently_dropped(self):
        self._seed_full_ledger()
        before = _db_state()
        snapshot = sync.export_ledger_snapshot()
        snapshot["liabilities"] = [
            {"id": "l1", "name": "Card", "balance_cents": 1000, "apr_basis_points": 1999,
             "min_payment_cents": 100}
        ]
        with self.assertRaises(ValueError) as ctx:
            sync.restore_ledger_snapshot(snapshot)
        self.assertIn("cannot persist", str(ctx.exception))
        self.assertEqual(_db_state(), before)

    def test_unknown_top_level_fields_are_rejected(self):
        self._seed_full_ledger()
        before = _db_state()
        snapshot = sync.export_ledger_snapshot()
        snapshot["mystery_financial_records"] = [{"amount_cents": 1}]
        with self.assertRaises(ValueError) as ctx:
            sync.restore_ledger_snapshot(snapshot)
        self.assertIn("unsupported fields", str(ctx.exception))
        self.assertEqual(_db_state(), before)

    def test_invalid_amount_types_are_rejected_without_touching_the_ledger(self):
        self._seed_full_ledger()
        before = _db_state()
        snapshot = sync.export_ledger_snapshot()
        snapshot["transactions"][0]["amount_cents"] = "500000"
        snapshot["current_balance_cents"] = 500_000
        with self.assertRaises(ValueError):
            sync.restore_ledger_snapshot(snapshot)
        self.assertEqual(_db_state(), before)

    def test_duplicate_identifiers_roll_back(self):
        self._seed_full_ledger()
        before = _db_state()
        snapshot = sync.export_ledger_snapshot()
        snapshot["transactions"].append(json.loads(json.dumps(snapshot["transactions"][0])))
        snapshot["current_balance_cents"] += snapshot["transactions"][0]["amount_cents"]
        with self.assertRaises(sqlite3.IntegrityError):
            sync.restore_ledger_snapshot(snapshot)
        self.assertEqual(_db_state(), before)

    def test_version_2_0_snapshot_restores_without_expected_amount(self):
        snapshot = {
            "version": "2.0",
            "updated_at": "2026-11-07T00:00:00+00:00",
            "current_balance_cents": 1000,
            "incomes": [
                {"id": 1, "name": "Pay", "amount_cents": 1000, "frequency": "Monthly",
                 "last_payday": "2026-01-31", "next_payday": "2026-02-28"},
            ],
            "payments": [],
            "transactions": [
                {"id": 1, "amount_cents": 1000, "category": "Pay", "type": "Income",
                 "date": "2026-10-01", "description": "Pay"},
            ],
            "bill_occurrences": [],
            "liabilities": [],
        }
        sync.restore_ledger_snapshot(snapshot)
        self.assertIsNone(_db_state()["income"][0]["expected_amount"])

    def test_repeated_restore_is_idempotent(self):
        self._seed_full_ledger()
        snapshot = sync.export_ledger_snapshot()
        sync.restore_ledger_snapshot(snapshot)
        first = _db_state()
        sync.restore_ledger_snapshot(snapshot)
        self.assertEqual(_db_state(), first)

    def test_recovery_copy_is_a_consistent_sqlite_database(self):
        self._seed_full_ledger()
        sync.restore_ledger_snapshot(sync.export_ledger_snapshot())
        backup = f"{db_manager.DB_PATH}.bak"
        self.assertTrue(os.path.exists(backup))
        probe = sqlite3.connect(backup)
        try:
            self.assertEqual(
                probe.execute("SELECT COUNT(*) FROM transactions").fetchone()[0], 1
            )
            self.assertEqual(probe.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        finally:
            probe.close()


if __name__ == "__main__":
    unittest.main()
