"""MCP adapter-facing contract tests (docs/MCP_READINESS.md).

These tests execute the REAL core (decisions -> scenario -> contract engine) against a
synthetic seeded ledger and pin down what a future MCP adapter may rely on:

- deterministic, schema-valid JSON results,
- typed failures (never a fabricated number),
- strict read-only behaviour (no operation mutates the ledger).

They deliberately avoid any MCP/LLM plumbing: if these pass, the adapter can be thin.
"""

from __future__ import annotations

import json
import os
import unittest
from pathlib import Path
from unittest import mock

import monte_carlo_ledger
from monte_carlo_ledger import db_manager, decisions
from monte_carlo_ledger.contract import ContractError

REPO_ROOT = Path(__file__).resolve().parents[1]

AS_OF = "2026-11-09"


class PackagedSchemaTests(unittest.TestCase):
    def test_packaged_schemas_match_the_normative_schemas(self):
        """Runtime validation reads the packaged copy; it must never drift from the normative one."""
        packaged = Path(monte_carlo_ledger.__file__).resolve().parent / "schemas"
        for name in ("scenario.schema.json", "result.schema.json"):
            with self.subTest(schema=name):
                self.assertEqual(
                    (packaged / name).read_bytes(),
                    (REPO_ROOT / "schemas" / name).read_bytes(),
                    f"{name} inside the package is stale; copy schemas/{name} into "
                    f"monte_carlo_ledger/schemas/",
                )


class MCPAdapterContractTests(unittest.TestCase):
    def setUp(self):
        self.test_db = "test_ledger_mcp_adapter.db"
        db_manager.DB_PATH = self.test_db
        if os.path.exists(self.test_db):
            os.remove(self.test_db)
        db_manager.init_db()
        # Synthetic 90-day household journey (no real user data, fixed dates).
        db_manager.add_transaction(500_000, "System", "Starting Balance", t_type="Adjustment")
        db_manager.add_income_source(
            "Primary Paycheck", 220_000, "Bi-weekly", "2026-10-30"
        )
        db_manager.update_income_dates(self._income_id(), "2026-10-30", "2026-11-13")
        db_manager.add_payment("Apartment Rent", 135_000, "Monthly", 1)
        db_manager.add_payment("High-Speed Internet", 7_500, "Monthly", 14)

    def tearDown(self):
        if os.path.exists(self.test_db):
            os.remove(self.test_db)

    def _income_id(self):
        return db_manager.get_all_income()[0].id

    def _txn_count(self) -> int:
        with db_manager.get_db_connection() as conn:
            return conn.execute("SELECT COUNT(*) AS n FROM transactions").fetchone()["n"]

    def _occurrence_count(self) -> int:
        with db_manager.get_db_connection() as conn:
            return conn.execute("SELECT COUNT(*) AS n FROM bill_occurrences").fetchone()["n"]

    # -- capabilities ------------------------------------------------------

    def test_engine_capabilities_shape_and_version(self):
        caps = decisions.engine_capabilities()
        self.assertEqual(caps["contract_version"], "2.0")
        for op in (
            "forecast", "risk", "overdraft_risk", "simulate_purchase",
            "simulate_paycheck_delay", "compare_debt_strategies",
            "financial_snapshot", "validate_scenario", "engine_capabilities",
        ):
            self.assertIn(op, caps["operations"])
        self.assertFalse(caps["writes"]["allowed"], "the tool surface must be read-only")
        self.assertTrue(caps["money"]["single_currency"])
        self.assertTrue(caps["money"]["overflow_is_error"])

    def test_capabilities_agree_with_contract_version_json(self):
        version_doc = json.loads((REPO_ROOT / "contracts" / "version.json").read_text())
        caps = decisions.engine_capabilities()
        self.assertEqual(caps["contract_version"], version_doc["contract_version"])
        self.assertIn(
            version_doc["contract_version"],
            caps["supported_contract_versions"],
            "the declared contract version must be one the engine actually supports",
        )

    # -- deterministic replay ---------------------------------------------

    def test_forecast_is_bit_for_bit_reproducible(self):
        first = decisions.forecast(AS_OF, 90)
        second = decisions.forecast(AS_OF, 90)
        self.assertEqual(first, second)
        # Invariant: ending balance = start + every event in the built scenario.
        from monte_carlo_ledger import scenario as scenario_mod

        built = scenario_mod.build_scenario(AS_OF, 90)
        expected_ending = built["starting_balance_cents"] + sum(e["amount_cents"] for e in built["events"])
        self.assertEqual(first["forecast"]["ending_balance_cents"], expected_ending)

    def test_default_contract_version_is_latest_released(self):
        # MCD-0027: a version-less scenario must evaluate as the latest released version on
        # every engine; the Python engine previously defaulted to 1.2 while the TS port used 2.0.
        from monte_carlo_ledger import contract

        version_doc = json.loads((REPO_ROOT / "contracts" / "version.json").read_text())
        versionless = {
            "scenario_id": "versionless-probe",
            "as_of": AS_OF,
            "starting_balance_cents": 0,
            "horizon_days": 1,
            "events": [],
        }
        result = contract.run_scenario(versionless)
        self.assertEqual(result["contract_version"], version_doc["contract_version"])

    def test_risk_is_reproducible_for_a_fixed_seed(self):
        sim = {"runs": 200, "seed": 42}
        first = decisions.risk(AS_OF, 90, sim)
        second = decisions.risk(AS_OF, 90, sim)
        self.assertEqual(first, second)
        self.assertIn("negative_balance_probability_ppm", first["risk"])
        self.assertIn("safe_to_spend_cents", first["risk"])

    # -- schema validity at the boundary ----------------------------------

    def test_simulate_purchase_result_is_schema_valid(self):
        import jsonschema

        result = decisions.simulate_purchase(65_000, "2026-11-10", AS_OF)
        schema = json.loads((REPO_ROOT / "schemas" / "result.schema.json").read_text())
        validator = jsonschema.Draft202012Validator(schema)
        for block in ("baseline", "with_purchase"):
            errors = list(validator.iter_errors(result[block]))
            self.assertEqual(errors, [], f"{block} result must validate: {errors}")
        for key in (
            "negative_balance_probability_ppm",
            "minimum_balance_p10_cents",
            "safe_to_spend_cents",
        ):
            self.assertIn(key, result["change"])

    def test_purchase_above_balance_is_reported_not_fabricated(self):
        result = decisions.simulate_purchase(999_999_00, "2026-11-10", AS_OF)
        # The engine must produce a *negative* trough under an unaffordable purchase,
        # never clamp it to a reassuring number.
        self.assertLessEqual(
            result["with_purchase"]["forecast"]["minimum_balance_cents"],
            500_000 - 999_999_00 + 220_000,
        )

    def test_invalid_purchase_date_raises_typed_error_not_zero(self):
        with self.assertRaises(ContractError) as ctx:
            decisions.simulate_purchase(65_000, "2026-13-40", AS_OF)
        self.assertEqual(ctx.exception.code, "INVALID_DATE")

    # -- validation op -----------------------------------------------------

    def test_validate_scenario_reports_structured_errors(self):
        missing_as_of = {
            "contract_version": "2.0",
            "scenario_id": "probe",
            "starting_balance_cents": 0,
            "horizon_days": 10,
            "events": [],
        }
        verdict = decisions.validate_scenario(missing_as_of)
        self.assertFalse(verdict["valid"])
        self.assertTrue(any(e["code"] == "SCHEMA_INVALID" for e in verdict["errors"]))

        # Schema-level: horizon_days has minimum 0, so the schema rejects it before the engine.
        bad_horizon = dict(missing_as_of, as_of=AS_OF, horizon_days=-5)
        verdict = decisions.validate_scenario(bad_horizon)
        self.assertFalse(verdict["valid"])
        self.assertTrue(any(e["code"] == "SCHEMA_INVALID" for e in verdict["errors"]))

        # Engine-level: jsonschema does not validate "format": "date" by default (mirroring
        # run_python.py), so a malformed date passes the schema and the engine rejects it.
        bad_date = dict(
            missing_as_of,
            as_of=AS_OF,
            events=[{"date": "2026-13-40", "amount_cents": -100, "type": "expense"}],
        )
        verdict = decisions.validate_scenario(bad_date)
        self.assertFalse(verdict["valid"])
        self.assertTrue(any(e["code"] == "INVALID_DATE" for e in verdict["errors"]))

    def test_validate_scenario_accepts_a_canonical_scenario(self):
        from monte_carlo_ledger import scenario as scenario_mod

        verdict = decisions.validate_scenario(scenario_mod.build_scenario(AS_OF, 30))
        self.assertTrue(verdict["valid"], verdict["errors"])
        self.assertEqual(verdict["errors"], [])

    # -- snapshot & read-only guarantee ------------------------------------

    def test_financial_snapshot_reports_balances_and_freshness(self):
        snap = decisions.financial_snapshot()
        self.assertEqual(snap["ledger_balance_cents"], 500_000)
        self.assertEqual(snap["stored_balance_cents"], 500_000)
        self.assertTrue(snap["balance_consistent"])
        self.assertEqual(snap["counts"]["transactions"], 1)
        self.assertEqual(snap["counts"]["income_sources"], 1)
        self.assertEqual(snap["counts"]["payments"], 2)
        self.assertIn("data_source", snap)

    def test_all_operations_are_read_only(self):
        before = self._txn_count()
        before_occurrences = self._occurrence_count()
        decisions.forecast(AS_OF, 30)
        decisions.risk(AS_OF, 30)
        decisions.simulate_purchase(65_000, "2026-11-10", AS_OF)
        decisions.simulate_paycheck_delay(3, AS_OF)
        decisions.compare_debt_strategies(
            [{"id": "c", "balance_cents": 100_000, "apr_basis_points": 0, "min_payment_cents": 5_000}],
            AS_OF,
        )
        decisions.financial_snapshot()
        self.assertEqual(before, self._txn_count(), "decision ops must never write the ledger")
        self.assertEqual(
            before_occurrences,
            self._occurrence_count(),
            "decision ops must not generate or mutate bill occurrences either",
        )

    # -- debt comparison ---------------------------------------------------

    def test_compare_debt_strategies_deterministic_with_caveat(self):
        liabilities = [
            {
                "id": "card",
                "name": "Credit Card",
                "balance_cents": 240_000,
                "apr_basis_points": 2199,
                "min_payment_cents": 6_500,
                "kind": "revolving",
            },
            {
                "id": "auto",
                "name": "Auto Loan",
                "balance_cents": 850_000,
                "apr_basis_points": 599,
                "min_payment_cents": 24_500,
                "kind": "installment",
            },
        ]
        first = decisions.compare_debt_strategies(liabilities, AS_OF)
        second = decisions.compare_debt_strategies(liabilities, AS_OF)
        self.assertEqual(first, second)
        self.assertIn("cash_flow_note", first)
        for strategy in ("snowball", "avalanche"):
            self.assertIn("months_to_payoff", first["strategies"][strategy])
            self.assertIn("total_interest_cents", first["strategies"][strategy])

    def test_compare_debt_strategies_rejects_empty_liabilities(self):
        with self.assertRaises(ContractError) as ctx:
            decisions.compare_debt_strategies([], AS_OF)
        self.assertEqual(ctx.exception.code, "SCHEMA_INVALID")

    def test_compare_debt_strategies_rejects_negative_extra_payment(self):
        liabilities = [{
            "id": "card",
            "balance_cents": 100_000,
            "apr_basis_points": 1999,
            "min_payment_cents": 3_000,
        }]
        with self.assertRaises(ContractError) as ctx:
            decisions.compare_debt_strategies(liabilities, AS_OF, extra_monthly_payment_cents=-1)
        self.assertEqual(ctx.exception.code, "INVALID_AMOUNT")

    def test_compare_debt_strategies_rejects_invalid_date(self):
        with self.assertRaises(ContractError) as ctx:
            decisions.compare_debt_strategies(
                [{"id": "card", "balance_cents": 1, "apr_basis_points": 0, "min_payment_cents": 1}],
                "2026-13-40",
            )
        self.assertEqual(ctx.exception.code, "INVALID_DATE")

    def test_simulate_purchase_rejects_non_positive_amount(self):
        for amount in (0, -5_000):
            with self.assertRaises(ContractError) as ctx:
                decisions.simulate_purchase(amount, "2026-11-10", AS_OF)
            self.assertEqual(ctx.exception.code, "INVALID_AMOUNT")

    def test_financial_snapshot_never_materializes_the_ledger(self):
        # Bounded-query guarantee: the snapshot must never call the full-history loader.
        with mock.patch.object(
            db_manager,
            "get_transaction_history",
            side_effect=AssertionError("snapshot must not materialize the ledger"),
        ):
            snap = decisions.financial_snapshot()
        self.assertEqual(snap["counts"]["transactions"], 1)

    def test_financial_snapshot_scales_to_a_large_ledger(self):
        rows = [(100, "Income", "2026-01-01", "bulk")] * 5_000
        with db_manager.get_db_connection() as conn:
            conn.executemany(
                "INSERT INTO transactions (amount, type, date, description) VALUES (?, ?, ?, ?)",
                rows,
            )
            conn.commit()
        with db_manager.get_db_connection() as conn:
            expected_newest = conn.execute("SELECT MAX(date) FROM transactions").fetchone()[0]
        snap = decisions.financial_snapshot()
        self.assertEqual(snap["counts"]["transactions"], 5_001)
        self.assertEqual(snap["newest_transaction_date"], expected_newest)


class MCPValidationFailClosedTests(unittest.TestCase):
    """A future adapter must never read an incomplete validation as success."""

    def _valid(self):
        return {
            "contract_version": "2.0",
            "scenario_id": "probe",
            "as_of": AS_OF,
            "starting_balance_cents": 0,
            "horizon_days": 10,
            "events": [],
        }

    def _codes(self, verdict):
        return [e["code"] for e in verdict["errors"]]

    def test_valid_scenario_reports_every_stage(self):
        verdict = decisions.validate_scenario(self._valid())
        self.assertTrue(verdict["valid"], verdict["errors"])
        self.assertTrue(verdict["schema_checked"])
        self.assertTrue(verdict["schema_valid"])
        self.assertTrue(verdict["engine_evaluated"])
        self.assertEqual(verdict["errors"], [])

    def test_missing_validation_dependency_is_not_success(self):
        import sys as _sys

        with mock.patch.dict(_sys.modules, {"jsonschema": None}):
            verdict = decisions.validate_scenario(self._valid())
        self.assertFalse(verdict["valid"], "a skipped schema check must never report valid")
        self.assertFalse(verdict["schema_checked"])
        self.assertFalse(verdict["schema_valid"])
        self.assertFalse(verdict["engine_evaluated"])
        self.assertEqual(self._codes(verdict), ["VALIDATION_UNAVAILABLE"])

    def test_non_object_scenario_is_rejected(self):
        verdict = decisions.validate_scenario(["not", "an", "object"])
        self.assertFalse(verdict["valid"])
        self.assertEqual(self._codes(verdict), ["SCHEMA_INVALID"])

    def test_schema_invalid_document_does_not_reach_the_engine(self):
        bad = dict(self._valid(), surprise_field=1)
        verdict = decisions.validate_scenario(bad)
        self.assertFalse(verdict["valid"])
        self.assertTrue(verdict["schema_checked"])
        self.assertFalse(verdict["schema_valid"])
        self.assertFalse(verdict["engine_evaluated"])
        self.assertIn("SCHEMA_INVALID", self._codes(verdict))

    def test_contract_version_boundaries(self):
        cases = {
            None: "SCHEMA_INVALID",
            2.0: "SCHEMA_INVALID",
            "3.0": "SCHEMA_INVALID",
            "not-a-version": "SCHEMA_INVALID",
            "1.0": None,
            "1.1": None,
            "1.2": None,
            "2.0": None,
        }
        for value, expected in cases.items():
            with self.subTest(contract_version=value):
                doc = dict(self._valid())
                doc["contract_version"] = value
                verdict = decisions.validate_scenario(doc)
                if expected is None:
                    self.assertTrue(verdict["valid"], verdict["errors"])
                else:
                    self.assertFalse(verdict["valid"])
                    self.assertIn(expected, self._codes(verdict))

    def test_omitted_contract_version_is_rejected_by_canonical_validation(self):
        # Two-tier policy: canonical public inputs must declare a version (the schema requires
        # it), while the engine still tolerates omission for legacy/hand-written scenarios by
        # evaluating them as the latest released version.
        doc = self._valid()
        del doc["contract_version"]
        verdict = decisions.validate_scenario(doc)
        self.assertFalse(verdict["valid"])
        self.assertIn("SCHEMA_INVALID", self._codes(verdict))

        from monte_carlo_ledger import contract

        result = contract.run_scenario(dict(doc, as_of=AS_OF))
        self.assertEqual(result["contract_version"], "2.0")

    def test_invalid_date_is_reported_by_the_engine(self):
        doc = dict(
            self._valid(),
            events=[{"date": "2026-13-40", "amount_cents": -100, "type": "expense"}],
        )
        verdict = decisions.validate_scenario(doc)
        self.assertFalse(verdict["valid"])
        self.assertTrue(verdict["engine_evaluated"])
        self.assertIn("INVALID_DATE", self._codes(verdict))

    def test_invalid_amount_is_reported_by_the_engine(self):
        doc = dict(
            self._valid(),
            events=[{"date": AS_OF, "amount_cents": 500, "type": "expense"}],
        )
        verdict = decisions.validate_scenario(doc)
        self.assertFalse(verdict["valid"])
        self.assertIn("INVALID_AMOUNT", self._codes(verdict))

    def test_overflow_is_reported_by_the_engine(self):
        doc = dict(
            self._valid(),
            starting_balance_cents=9223372036854775807,
            events=[{"date": AS_OF, "amount_cents": 1, "type": "income"}],
        )
        verdict = decisions.validate_scenario(doc)
        self.assertFalse(verdict["valid"])
        self.assertIn("MONEY_OVERFLOW", self._codes(verdict))


if __name__ == "__main__":
    unittest.main()
