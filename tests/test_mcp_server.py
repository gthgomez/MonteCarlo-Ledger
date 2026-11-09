"""Exercise the shipped MCP adapter tools via the in-process server registry."""

from __future__ import annotations

import json
import os
import unittest

import anyio
from mcp.server.mcpserver.exceptions import ToolError

from monte_carlo_ledger import db_manager, mcp_server


class MCPServerToolTests(unittest.TestCase):
    def setUp(self):
        self.tmp_db = "test_mcp_server.db"
        db_manager.DB_PATH = self.tmp_db
        if os.path.exists(self.tmp_db):
            os.remove(self.tmp_db)
        db_manager.init_db()
        db_manager.add_transaction(500_000, "System", "Opening", t_type="Adjustment", date_str="2026-10-01")
        db_manager.add_income_source("Pay", 220_000, "Monthly", "2026-01-31")

    def tearDown(self):
        if os.path.exists(self.tmp_db):
            os.remove(self.tmp_db)

    def _call(self, name: str, arguments: dict):
        return anyio.run(mcp_server.server.call_tool, name, arguments, None)

    @staticmethod
    def _body(result) -> dict:
        if result.structured_content is not None:
            structured = result.structured_content
            if isinstance(structured, dict) and "result" in structured:
                return structured["result"]
            return structured
        return json.loads(result.content[0].text)

    def test_capabilities_and_forecast(self):
        caps = self._call("get_engine_capabilities", {})
        self.assertFalse(caps.is_error)
        body = self._body(caps)
        self.assertEqual(body["writes"]["allowed"], False)
        op_names = {t.name for t in anyio.run(mcp_server.server.list_tools)}
        self.assertIn("forecast_cash_flow", op_names)

        forecast = self._call("forecast_cash_flow", {"as_of": "2026-11-09", "horizon_days": 30})
        self.assertFalse(forecast.is_error)
        data = self._body(forecast)
        self.assertIn("forecast", data)
        self.assertTrue(data["ledger"]["read_only"])

    def test_invalid_date_is_tool_error_not_silent_success(self):
        with self.assertRaises(ToolError) as ctx:
            self._call("forecast_cash_flow", {"as_of": "not-a-date", "horizon_days": 30})
        self.assertIn("INVALID_DATE", str(ctx.exception))

    def test_simulate_purchase_reproducible(self):
        args = {
            "amount_cents": 50_000,
            "purchase_date": "2026-11-10",
            "as_of": "2026-11-09",
            "runs": 100,
            "seed": 42,
        }
        first = self._call("simulate_purchase", args)
        second = self._call("simulate_purchase", args)
        self.assertFalse(first.is_error)
        self.assertEqual(self._body(first), self._body(second))


if __name__ == "__main__":
    unittest.main()
