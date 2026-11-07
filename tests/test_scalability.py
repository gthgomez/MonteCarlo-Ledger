"""Bounded-query and large-ledger behaviour for the read-only surface."""

import os
import tempfile
import time
import unittest
from unittest.mock import patch

from monte_carlo_ledger import db_manager, decisions

AS_OF = "2026-11-09"


class ScalabilityTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        db_manager.DB_PATH = os.path.join(self.tmp.name, "ledger.db")
        db_manager.init_db()
        db_manager.add_income_source("Pay", 220_000, "Bi-weekly", "2026-10-30")
        db_manager.add_payment("Rent", 135_000, "Monthly", 1)

    def tearDown(self):
        self.tmp.cleanup()

    def _insert_history(self, count: int) -> int:
        # Offsetting pairs keep the ledger balance at zero, so history size is the
        # only variable in the forecast-independence test.
        rows = [
            ((1_000 if i % 2 else -1_000), "Food", "Expense", "2026-10-01", f"row {i}")
            for i in range(count)
        ]
        total = sum(row[0] for row in rows)
        with db_manager.get_db_connection() as conn:
            with conn:
                conn.executemany(
                    "INSERT INTO transactions (amount, category, type, date, description) "
                    "VALUES (?, ?, ?, ?, ?)",
                    rows,
                )
                conn.execute(
                    "INSERT OR REPLACE INTO settings (key, value) VALUES ('current_balance', ?)",
                    (total,),
                )
        return total

    def test_read_only_operations_never_materialize_transaction_history(self):
        self._insert_history(2_000)
        with patch.object(
            db_manager,
            "get_transaction_history",
            side_effect=AssertionError("full transaction history was materialized"),
        ):
            snapshot = decisions.financial_snapshot()
            forecast = decisions.forecast(AS_OF, 90)
            decisions.overdraft_risk(AS_OF, 90, {"runs": 50})
            decisions.simulate_purchase(65_000, "2026-11-10", AS_OF, 90, {"runs": 50})
        self.assertEqual(snapshot["counts"]["transactions"], 2_000)
        self.assertIn("forecast", forecast)

    def test_large_ledger_queries_complete_in_bounded_time(self):
        self._insert_history(20_000)
        started = time.monotonic()
        snapshot = decisions.financial_snapshot()
        elapsed = time.monotonic() - started
        self.assertEqual(snapshot["counts"]["transactions"], 20_000)
        # A full-history load of 20k rows is still fast, but the aggregate query is
        # effectively constant; keep a generous ceiling to catch accidental O(rows)
        # materialization without being flaky on slow CI.
        self.assertLess(elapsed, 5.0)

    def test_forecast_is_unaffected_by_history_size(self):
        small = decisions.forecast(AS_OF, 90)
        self._insert_history(20_000)
        large = decisions.forecast(AS_OF, 90)
        self.assertEqual(small["forecast"], large["forecast"])


if __name__ == "__main__":
    unittest.main()
