"""Cross-surface household journey: one synthetic ledger, one Contract 2.0 oracle.

Traces income, bills, liabilities and opening balances through the Python
restore → scenario → evaluate path that must match the Web companion's shared
evaluation (Home / Money / Budget / Bills / Plan / Future). Stochastic fields are
seed-bound to the fixture's simulation block; they are model estimates, not
promised financial outcomes.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from copy import deepcopy
from pathlib import Path

import pytest

from monte_carlo_ledger import db_manager, decisions, sync
from monte_carlo_ledger import scenario as scenario_mod
from monte_carlo_ledger.contract import event_rows, run_scenario

REPO_ROOT = Path(__file__).resolve().parents[1]
FIXTURE = REPO_ROOT / "testdata" / "household" / "cross-surface-household.json"
TIMING_FIXTURE = REPO_ROOT / "testdata" / "household" / "mcl-timing.json"
QUALIFICATION_FIXTURE = REPO_ROOT / "testdata" / "household" / "qualification-household.json"


@pytest.fixture(scope="module")
def household():
    return json.loads(FIXTURE.read_text())


@pytest.fixture
def restored_db(tmp_path, household, monkeypatch):
    db_path = tmp_path / "household.db"
    monkeypatch.setattr(db_manager, "DB_PATH", str(db_path))
    db_manager.init_db()
    sync.restore_ledger_snapshot(household["ledger"])
    return str(db_path)


def _web_scenario_and_result(household: dict) -> tuple[dict, dict]:
    """Build the scenario with the TypeScript adapter and evaluate in Node."""
    script = r"""
import { buildScenarioFromLedger } from "./web/dist-test/lib/scenario-builder.js";
import { runScenario } from "./web/dist-test/contract/engine.js";
import { parseLedgerState } from "./web/dist-test/lib/validate.js";
import { cashMinusEnteredDebt } from "./web/dist-test/lib/present.js";
import { spendingThisMonth } from "./web/dist-test/lib/present.js";
import { slicePlan } from "./web/dist-test/lib/present.js";
import { timelineRows } from "./web/dist-test/contract/engine.js";
import { safeSpendTechnicalName } from "./web/dist-test/lib/assumptions.js";
import fs from "fs";

const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const parsed = parseLedgerState(doc.ledger);
if (!parsed.ok) {
  console.error(parsed.error);
  process.exit(2);
}
const scenario = buildScenarioFromLedger(
  parsed.state,
  doc.as_of,
  doc.horizon_days,
  doc.simulation
);
const result = runScenario(scenario);
const rows = timelineRows(scenario);
const slice = slicePlan(rows, doc.as_of, doc.horizon_days, scenario.starting_balance_cents);
const spend = spendingThisMonth(parsed.state.transactions, doc.as_of);
const net = cashMinusEnteredDebt(parsed.state.current_balance_cents, parsed.state.liabilities);
const label = safeSpendTechnicalName(doc.simulation.quantile_num, doc.simulation.quantile_den);
console.log(JSON.stringify({
  scenario,
  result,
  rows,
  surfaces: {
    safe_to_spend_cents: result.risk.safe_to_spend_cents,
    overdraft_ppm: result.risk.negative_balance_probability_ppm,
    minimum_balance_p10_cents: result.risk.minimum_balance_p10_cents,
    minimum_balance_p50_cents: result.risk.minimum_balance_p50_cents,
    projected_low_cents: result.forecast.minimum_balance_cents,
    projected_low_date: result.forecast.minimum_balance_date,
    ending_balance_cents: result.forecast.ending_balance_cents,
    debt_months_to_payoff: result.debt?.months_to_payoff ?? null,
    debt_total_interest_cents: result.debt?.total_interest_cents ?? null,
    starting_balance_cents: scenario.starting_balance_cents,
    cash_minus_entered_debt_cents: net,
    recorded_spend_this_month_cents: spend.totalCents,
    scheduled_outflow_in_horizon_cents: slice.scheduledOutflowCents,
    p10_label: label,
    event_count: scenario.events.length,
  },
}));
"""
    dist = REPO_ROOT / "web" / "dist-test" / "lib" / "scenario-builder.js"
    if not dist.exists():
        compile = subprocess.run(
            [str(REPO_ROOT / "web" / "node_modules" / ".bin" / "tsc"), "-p", "tsconfig.test.json"],
            cwd=REPO_ROOT / "web",
            capture_output=True,
            text=True,
        )
        assert compile.returncode == 0, compile.stderr
    with tempfile.TemporaryDirectory() as directory:
        scenario_path = Path(directory) / "household.json"
        scenario_path.write_text(json.dumps(household), encoding="utf-8")
        proc = subprocess.run(
            ["node", "--input-type=module", "-e", script, str(scenario_path)],
            cwd=str(REPO_ROOT),
            capture_output=True,
            text=True,
        )
        assert proc.returncode == 0, proc.stderr
        payload = json.loads(proc.stdout)
    return payload["scenario"], payload


def test_python_bridge_matches_oracle_including_debt(restored_db, household):
    built = scenario_mod.build_scenario(
        household["as_of"],
        household["horizon_days"],
        include_simulation=household["simulation"],
        read_only=True,
    )
    assert "liabilities" in built
    assert len(built["liabilities"]) == 2
    assert built["debt_strategy"] == "snowball"
    assert any(event["name"] == "Auto Loan" and event["amount_cents"] < 0 for event in built["events"])
    assert any(event["name"] == "Credit Card" and event["amount_cents"] < 0 for event in built["events"])

    result = run_scenario(built)
    oracle = household["oracle"]
    assert result["risk"]["safe_to_spend_cents"] == oracle["safe_to_spend_cents"]
    assert result["risk"]["negative_balance_probability_ppm"] == oracle["overdraft_ppm"]
    assert result["risk"]["minimum_balance_p10_cents"] == oracle["minimum_balance_p10_cents"]
    assert result["forecast"]["minimum_balance_cents"] == oracle["projected_low_cents"]
    assert result["forecast"]["minimum_balance_date"] == oracle["projected_low_date"]
    assert result["forecast"]["ending_balance_cents"] == oracle["ending_balance_cents"]
    assert result["debt"]["months_to_payoff"] == oracle["debt_months_to_payoff"]
    assert result["debt"]["total_interest_cents"] == oracle["debt_total_interest_cents"]
    assert len(built["events"]) == oracle["event_count"]


def test_month_end_and_future_receipt_fixture_is_chronological(tmp_path, monkeypatch):
    doc = json.loads(TIMING_FIXTURE.read_text())
    monkeypatch.setattr(db_manager, "DB_PATH", str(tmp_path / "timing.db"))
    db_manager.init_db()
    sync.restore_ledger_snapshot(doc["ledger"])
    built = scenario_mod.build_scenario(doc["as_of"], doc["horizon_days"], read_only=True)
    actual = sorted(
        ((event["date"], event["amount_cents"]) for event in built["events"]),
        key=lambda item: (item[0], 0 if item[1] >= 0 else 1),
    )
    expected = [(date, cents) for date, cents in doc["expected"]["event_dates_and_cents"]]
    assert built["starting_balance_cents"] == doc["expected"]["opening_cents"]
    assert actual == expected
    assert min((event["amount_cents"] for event in built["events"]), default=0) == -20_000
    assert max((event["date"] for event in built["events"]), default="") == "2027-03-31"
    result = run_scenario(built)
    assert result["forecast"]["minimum_balance_cents"] == doc["expected"]["minimum_cents"]
    assert result["forecast"]["minimum_balance_date"] == doc["expected"]["minimum_date"]
    assert result["forecast"]["ending_balance_cents"] == doc["expected"]["ending_cents"]


@pytest.mark.parametrize(("anchor", "expected_dates"), [
    ("2026-11-15", ["2026-11-15", "2026-12-15"]),
    (None, ["2026-10-15", "2026-11-15", "2026-12-15"]),
])
def test_monthly_bill_anchor_survives_python_edit_export_and_web_restore(
    tmp_path, monkeypatch, household, anchor, expected_dates,
):
    monkeypatch.setattr(db_manager, "DB_PATH", str(tmp_path / "anchored.db"))
    db_manager.init_db()
    snapshot = {
        "version": "2.1",
        "current_balance_cents": 50_000,
        "incomes": [],
        "payments": [{
            "id": "insurance", "name": "Insurance", "amount_cents": 20_000,
            "recurrence": "Monthly", "due_day": 15,
        }],
        "transactions": [{
            "id": 1, "amount_cents": 50_000, "date": "2026-10-01", "type": "Adjustment",
        }],
        "bill_occurrences": [],
    }
    if anchor is not None:
        snapshot["payments"][0]["due_date"] = anchor
    sync.restore_ledger_snapshot(snapshot)
    options = {"as_of": "2026-10-10", "horizon_days": 67}
    original = scenario_mod.build_scenario(**options, read_only=True)
    assert [event["date"] for event in original["events"]] == expected_dates

    payment_id = db_manager.get_all_payments()[0].id
    db_manager.update_payment(payment_id, "Renamed insurance", 18_000, "Monthly", 15)
    exported = sync.export_ledger_snapshot()
    assert exported["payments"][0]["due_date"] == anchor
    sync.restore_ledger_snapshot(exported)
    simulation = dict(household["simulation"], runs=10, surprise_probability_ppm=0)

    python_scenario = scenario_mod.build_scenario(**options, include_simulation=simulation)
    web_scenario, web_payload = _web_scenario_and_result({
        **options, "ledger": exported, "simulation": simulation,
    })
    assert python_scenario["events"] == web_scenario["events"] == [
        {"date": due, "type": "expense", "name": "Renamed insurance", "amount_cents": -18_000}
        for due in expected_dates
    ]
    python_forecast = run_scenario(python_scenario)["forecast"]
    assert python_forecast == web_payload["result"]["forecast"]
    assert python_forecast["ending_balance_cents"] == 50_000 - 18_000 * len(expected_dates)
    assert [row["due_date"] for row in sync.export_ledger_snapshot()["bill_occurrences"]] == expected_dates


def test_debt_uses_its_own_due_day_until_the_linked_bill_starts(tmp_path, monkeypatch, household):
    monkeypatch.setattr(db_manager, "DB_PATH", str(tmp_path / "future-linked-bill.db"))
    db_manager.init_db()
    sync.restore_ledger_snapshot({
        "version": "2.2",
        "current_balance_cents": 50_000,
        "incomes": [],
        "payments": [{
            "id": "bill", "name": "Loan bill", "amount_cents": 3_000,
            "recurrence": "Monthly", "due_day": 15, "due_date": "2027-02-15",
        }],
        "liabilities": [{
            "id": "loan", "name": "Loan", "balance_cents": 30_000,
            "min_payment_cents": 3_000, "apr_basis_points": 0, "due_day_of_month": 5,
            "linked_payment_id": "bill",
        }],
        "transactions": [{
            "id": 1, "amount_cents": 50_000, "date": "2026-12-31", "type": "Adjustment",
        }],
        "bill_occurrences": [],
    })
    simulation = dict(household["simulation"], runs=10, surprise_probability_ppm=0)
    exported = sync.export_ledger_snapshot()
    for horizon, expected, ending in [
        (10, [("2027-01-05", "Loan")], 47_000),
        (50, [("2027-01-05", "Loan"), ("2027-02-15", "Loan bill")], 44_000),
    ]:
        options = {"as_of": "2027-01-01", "horizon_days": horizon}
        python_scenario = scenario_mod.build_scenario(
            **options, read_only=True, include_simulation=simulation,
        )
        web_scenario, web_payload = _web_scenario_and_result({
            **options, "ledger": exported, "simulation": simulation,
        })
        assert [(row["date"], row["name"]) for row in python_scenario["events"]] == expected
        assert python_scenario["events"] == web_scenario["events"]
        assert run_scenario(python_scenario)["forecast"]["ending_balance_cents"] == ending
        assert web_payload["result"]["forecast"]["ending_balance_cents"] == ending


def test_web_and_python_match_the_settled_browser_household_oracle(tmp_path, monkeypatch):
    doc = json.loads(QUALIFICATION_FIXTURE.read_text(encoding="utf-8"))
    household = doc["household"]
    saved = doc["expected_saved_ledger"]
    paid = doc["oracles"]["after_marking_moved_rent_paid"]
    assumptions = doc["assumptions"]
    quantile_num, quantile_den = map(int, assumptions["quantile"].split("/"))
    simulation = {
        "runs": assumptions["runs"],
        "seed": assumptions["seed"],
        "quantile_num": quantile_num,
        "quantile_den": quantile_den,
        "income_variation_min": assumptions["incomeVariationMin"],
        "income_variation_max": assumptions["incomeVariationMax"],
        "expense_variation_min": assumptions["expenseVariationMin"],
        "expense_variation_max": assumptions["expenseVariationMax"],
        "surprise_probability_ppm": assumptions["surpriseProbabilityPpm"],
        "surprise_amount_min": assumptions["surpriseAmountMinCents"],
        "surprise_amount_max": assumptions["surpriseAmountMaxCents"],
        "surprise_check_interval_days": assumptions["surpriseIntervalDays"],
        "reserve_cents": assumptions["reserveCents"],
    }
    rent_id = saved["rent_payment_id"]
    snapshot = {
        "version": saved["version"],
        "updated_at": doc["clock_iso"],
        "current_balance_cents": saved["current_balance_cents"],
        "incomes": [{"id": "pay", "last_payday": household["income"]["next_payday"], **household["income"]}],
        "payments": [
            {"id": rent_id, **household["rent"]},
            {"id": saved["car_payment_id"], **household["car_payment"]},
        ],
        "transactions": [
            {
                "id": "opening",
                "type": "Adjustment",
                "date": doc["as_of"],
                "amount_cents": household["opening_cash_cents"],
            },
            {"id": "rent-paid", **paid["transaction"]},
        ],
        "bill_occurrences": [
            {
                "id": "rent-slot",
                "payment_id": rent_id,
                "transaction_id": "rent-paid",
                "is_user_modified": True,
                **paid["occurrence"],
            },
        ],
        "liabilities": [{
            "id": "car-debt", "kind": "installment", "apr_basis_points": 0, **saved["linked_liability"],
        }],
    }
    monkeypatch.setattr(db_manager, "DB_PATH", str(tmp_path / "settled.db"))
    db_manager.init_db()
    sync.restore_ledger_snapshot(snapshot)
    py = scenario_mod.build_scenario(
        doc["as_of"], doc["horizon_days"], include_simulation=simulation, read_only=True
    )
    browser, payload = _web_scenario_and_result({**doc, "ledger": snapshot, "simulation": simulation})

    assert browser["starting_balance_cents"] == py["starting_balance_cents"] == paid["recorded_balance_cents"]
    expected_rows = [
        (r["date"], r["name"], r["amount_cents"], r["running_balance_cents"])
        for r in paid["events"]
    ]
    assert [(r["date"], r["name"], r["amount"], r["balance_after"]) for r in event_rows(py)] == expected_rows
    assert [(r["date"], r["name"], r["amount_cents"], r["balance_after_cents"]) for r in payload["rows"]] == expected_rows
    for result in (run_scenario(py), payload["result"]):
        assert result["forecast"] == {
            "minimum_balance_cents": paid["low_cents"],
            "minimum_balance_date": paid["low_date"],
            "ending_balance_cents": paid["ending_balance_cents"],
            "first_negative_date": None,
        }
        assert result["risk"]["safe_to_spend_cents"] == paid["cautious_amount_cents"]
        assert result["risk"]["negative_balance_probability_ppm"] == 0


def test_web_and_python_share_seed_bound_evaluation(restored_db, household):
    web_scenario, web_payload = _web_scenario_and_result(household)
    py_scenario = scenario_mod.build_scenario(
        household["as_of"],
        household["horizon_days"],
        include_simulation=household["simulation"],
        read_only=True,
    )

    def event_key(event: dict) -> tuple:
        return (event["date"], event["name"], event["amount_cents"], event["type"])

    assert sorted(web_scenario["events"], key=event_key) == sorted(
        py_scenario["events"], key=event_key
    )
    assert web_scenario["starting_balance_cents"] == py_scenario["starting_balance_cents"]
    assert len(web_scenario["liabilities"]) == len(py_scenario["liabilities"])

    py_result = run_scenario(py_scenario)
    web_result = web_payload["result"]
    assert web_result["forecast"] == py_result["forecast"]
    assert web_result["risk"] == py_result["risk"]
    assert web_result["debt"]["months_to_payoff"] == py_result["debt"]["months_to_payoff"]
    assert web_result["debt"]["total_interest_cents"] == py_result["debt"]["total_interest_cents"]

    surfaces = web_payload["surfaces"]
    oracle = household["oracle"]
    for key in (
        "safe_to_spend_cents",
        "overdraft_ppm",
        "minimum_balance_p10_cents",
        "projected_low_cents",
        "ending_balance_cents",
        "debt_months_to_payoff",
        "cash_minus_entered_debt_cents",
        "recorded_spend_this_month_cents",
        "scheduled_outflow_in_horizon_cents",
        "p10_label",
    ):
        assert surfaces[key] == oracle[key], key


def test_same_day_debt_order_is_stable_across_web_and_python(tmp_path, monkeypatch, household):
    doc = deepcopy(household)
    doc["as_of"] = "2026-11-01"
    doc["horizon_days"] = 30
    doc["simulation"] = {
        "runs": 100,
        "seed": 7,
        "quantile_num": 1,
        "quantile_den": 10,
        "income_variation_min": 0,
        "income_variation_max": 0,
        "expense_variation_min": -20,
        "expense_variation_max": 20,
        "surprise_probability_ppm": 0,
        "surprise_amount_min": 0,
        "surprise_amount_max": 0,
        "surprise_check_interval_days": 14,
        "reserve_cents": 0,
    }
    doc["ledger"] = {
        "version": "2.1",
        "updated_at": "2026-11-01T00:00:00+00:00",
        "current_balance_cents": 500_000,
        "incomes": [],
        "payments": [],
        "transactions": [
            {
                "id": "opening",
                "amount_cents": 500_000,
                "category": "System",
                "type": "Adjustment",
                "date": "2026-10-01",
                "description": "Opening balance",
            }
        ],
        "bill_occurrences": [],
        "liabilities": [
            {
                "id": "debt-z",
                "name": "Z Loan",
                "balance_cents": 100_000,
                "apr_basis_points": 0,
                "min_payment_cents": 12_000,
                "kind": "installment",
                "due_day_of_month": 15,
            },
            {
                "id": "debt-a",
                "name": "A Loan",
                "balance_cents": 100_000,
                "apr_basis_points": 0,
                "min_payment_cents": 8_000,
                "kind": "installment",
                "due_day_of_month": 15,
            },
        ],
    }

    database = tmp_path / "same-day-debts.db"
    monkeypatch.setattr(db_manager, "DB_PATH", str(database))
    db_manager.init_db()
    sync.restore_ledger_snapshot(doc["ledger"])
    python_scenario = scenario_mod.build_scenario(
        doc["as_of"], doc["horizon_days"], include_simulation=doc["simulation"], read_only=True
    )
    web_scenario, web_payload = _web_scenario_and_result(doc)

    assert [event["name"] for event in python_scenario["events"]] == ["A Loan", "Z Loan"]
    assert web_scenario["events"] == python_scenario["events"]
    assert web_payload["result"]["risk"] == run_scenario(python_scenario)["risk"]


def test_legacy_snapshot_without_liabilities_keeps_cash_path(tmp_path, household, monkeypatch):
    db_path = tmp_path / "legacy.db"
    monkeypatch.setattr(db_manager, "DB_PATH", str(db_path))
    db_manager.init_db()
    sync.restore_ledger_snapshot(household["legacy_snapshot_without_liabilities"])
    built = scenario_mod.build_scenario(
        household["as_of"],
        household["horizon_days"],
        include_simulation=household["simulation"],
        read_only=True,
    )
    assert "liabilities" not in built
    assert not any(event["name"] in {"Credit Card", "Auto Loan"} for event in built["events"])
    result = run_scenario(built)
    assert "debt" not in result
    oracle = household["oracle"]
    # Without debt mins, cautious spend must be strictly higher than the with-debt oracle.
    assert result["risk"]["safe_to_spend_cents"] > oracle["safe_to_spend_cents"]
    assert result["forecast"]["ending_balance_cents"] > oracle["ending_balance_cents"]


def test_export_import_restart_preserves_liabilities_and_oracle(restored_db, household, tmp_path, monkeypatch):
    exported = sync.export_ledger_snapshot()
    assert len(exported["liabilities"]) == 2

    restart = tmp_path / "restart.db"
    monkeypatch.setattr(db_manager, "DB_PATH", str(restart))
    db_manager.init_db()
    sync.restore_ledger_snapshot(exported)

    built = scenario_mod.build_scenario(
        household["as_of"],
        household["horizon_days"],
        include_simulation=household["simulation"],
        read_only=True,
    )
    result = run_scenario(built)
    oracle = household["oracle"]
    assert result["debt"]["months_to_payoff"] == oracle["debt_months_to_payoff"]
    assert result["risk"]["minimum_balance_p10_cents"] == oracle["minimum_balance_p10_cents"]


def test_cli_forecast_exposes_debt_after_restore(restored_db, household):
    env = os.environ.copy()
    env["MC_LEDGER_DB"] = restored_db
    proc = subprocess.run(
        [
            sys.executable,
            "-m",
            "monte_carlo_ledger",
            "forecast",
            "--as-of",
            household["as_of"],
            "--horizon",
            str(household["horizon_days"]),
            "--json",
        ],
        cwd=str(REPO_ROOT),
        env=env,
        capture_output=True,
        text=True,
    )
    assert proc.returncode == 0, proc.stderr
    payload = json.loads(proc.stdout)
    assert payload["forecast"]["ending_balance_cents"] == household["oracle"]["ending_balance_cents"]
    # forecast CLI is deterministic-only (no simulation block); debt must still appear.
    assert "debt" in payload
    assert payload["debt"]["months_to_payoff"] == household["oracle"]["debt_months_to_payoff"]


def test_seed_bound_risk_is_stable_and_not_a_guarantee(restored_db, household):
    first = decisions.overdraft_risk(
        household["as_of"],
        household["horizon_days"],
        dict(household["simulation"]),
    )
    second = decisions.overdraft_risk(
        household["as_of"],
        household["horizon_days"],
        dict(household["simulation"]),
    )
    assert first["negative_balance_probability_ppm"] == second["negative_balance_probability_ppm"]
    assert first["negative_balance_probability_ppm"] == household["oracle"]["overdraft_ppm"]
    assert first["minimum_balance_p10_cents"] == household["oracle"]["minimum_balance_p10_cents"]
    assumptions = first["ledger"]["model"]["assumptions"].lower()
    assert "estimate" in assumptions


@pytest.mark.parametrize("linked", [False, True])
def test_identical_bills_and_debt_across_persisted_adapters(tmp_path, monkeypatch, household, linked):
    database = tmp_path / "identity.db"
    monkeypatch.setattr(db_manager, "DB_PATH", str(database))
    db_manager.init_db()
    doc = json.loads((FIXTURE.parent / "vault-payment-identity.json").read_text())
    if not linked:
        doc["ledger"]["version"] = "2.1"
        debt = doc["ledger"]["liabilities"][0]
        del debt["linked_payment_id"]
        doc["ledger"]["liabilities"] = [debt]
    doc["simulation"] = dict(
        household["simulation"],
        surprise_probability_ppm=0,
        reserve_cents=doc["reserve_cents"],
    )
    sync.restore_ledger_snapshot(doc["ledger"])
    doc["ledger"] = sync.export_ledger_snapshot()
    assert doc["ledger"]["payments"][0]["id"] == "payment-car"
    assert doc["ledger"]["transactions"][0]["id"] == "opening"
    sync.restore_ledger_snapshot(doc["ledger"])
    python_scenario = scenario_mod.build_scenario(
        doc["as_of"], doc["horizon_days"], include_simulation=doc["simulation"], read_only=True
    )
    web_scenario, web_payload = _web_scenario_and_result(doc)
    expected_events = [{
        "date": "2028-02-15",
        "name": "Car loan",
        "type": "expense",
        "amount_cents": -50_000,
    }] * (1 if linked else 2)
    assert python_scenario["events"] == web_scenario["events"] == expected_events

    # 120,000 minus one or two 50,000 payments. The simulation is deterministic
    # for these inputs, so its low is identical and the reserve costs 10,000.
    expected_low = 70_000 if linked else 20_000
    python_result = run_scenario(python_scenario)
    for result in (python_result, web_payload["result"]):
        assert result["forecast"]["minimum_balance_cents"] == expected_low
        assert result["forecast"]["ending_balance_cents"] == expected_low
        assert result["risk"]["minimum_balance_p10_cents"] == expected_low
        assert result["risk"]["safe_to_spend_cents"] == expected_low - 10_000


def test_same_day_bills_and_income_use_one_canonical_order(tmp_path, monkeypatch):
    """The same ledger must assign seeded draws identically on Web and Python.

    The inputs deliberately use mixed-case names and list the lower-case item first,
    with nonzero bill/income variation, so a locale-dependent or adapter order
    tie-break changes the risk block even though cash totals are unchanged.
    """
    snapshot = {
        "version": "2.2",
        "updated_at": "2026-12-20T00:00:00Z",
        "current_balance_cents": 100_000,
        "incomes": [
            {"id": "inc-z", "name": "alpha income", "amount_cents": 100_000, "frequency": "Monthly", "last_payday": "2026-12-01", "next_payday": "2027-01-01"},
            {"id": "inc-a", "name": "Zulu income", "amount_cents": 200_000, "frequency": "Monthly", "last_payday": "2026-12-01", "next_payday": "2027-01-01"},
        ],
        "payments": [
            {"id": "pmt-z", "name": "apple bill", "amount_cents": 10_000, "recurrence": "Monthly", "due_day": 1},
            {"id": "pmt-a", "name": "Banana bill", "amount_cents": 30_000, "recurrence": "Monthly", "due_day": 1},
        ],
        "transactions": [
            {"id": "tx-open", "amount_cents": 100_000, "type": "Adjustment", "date": "2026-12-20"}
        ],
        "bill_occurrences": [],
        "liabilities": [],
    }
    simulation = {
        "runs": 500,
        "seed": 7,
        "quantile_num": 1,
        "quantile_den": 10,
        "income_variation_min": -50,
        "income_variation_max": 50,
        "expense_variation_min": -50,
        "expense_variation_max": 50,
        "surprise_probability_ppm": 0,
        "surprise_amount_min": 0,
        "surprise_amount_max": 0,
        "surprise_check_interval_days": 14,
        "reserve_cents": 0,
    }
    doc = {
        "ledger": snapshot,
        "as_of": "2026-12-20",
        "horizon_days": 40,
        "simulation": simulation,
    }
    _, web = _web_scenario_and_result(doc)

    monkeypatch.setattr(db_manager, "DB_PATH", str(tmp_path / "same-day.db"))
    db_manager.init_db()
    sync.restore_ledger_snapshot(snapshot)
    built = scenario_mod.build_scenario(
        "2026-12-20", 40, include_simulation=simulation, read_only=True
    )
    python = run_scenario(built)

    for field in (
        "safe_to_spend_cents",
        "negative_balance_probability_ppm",
        "minimum_balance_p10_cents",
        "minimum_balance_p50_cents",
        "minimum_balance_p90_cents",
        "ending_balance_p10_cents",
        "ending_balance_p50_cents",
        "ending_balance_p90_cents",
    ):
        assert python["risk"][field] == web["result"]["risk"][field], field


def test_purchase_comparison_is_fixed_and_matches_web(tmp_path, monkeypatch):
    """A hypothetical purchase must not be varied or consume another bill's draw."""
    snapshot = {
        "version": "2.2",
        "updated_at": "2026-12-01T00:00:00Z",
        "current_balance_cents": 100_000,
        "incomes": [],
        "payments": [
            {"id": "pmt-bill", "name": "Bill", "amount_cents": 10_000, "recurrence": "Monthly", "due_day": 15}
        ],
        "transactions": [
            {"id": "tx-open", "amount_cents": 100_000, "type": "Adjustment", "date": "2026-12-01"}
        ],
        "bill_occurrences": [],
        "liabilities": [],
    }
    sim = {
        "runs": 200,
        "seed": 7,
        "quantile_num": 1,
        "quantile_den": 10,
        "income_variation_min": 0,
        "income_variation_max": 0,
        "expense_variation_min": -10,
        "expense_variation_max": 10,
        "surprise_probability_ppm": 0,
        "surprise_amount_min": 0,
        "surprise_amount_max": 0,
        "surprise_check_interval_days": 14,
        "reserve_cents": 0,
    }
    doc = {
        "ledger": snapshot,
        "as_of": "2026-12-01",
        "horizon_days": 60,
        "simulation": sim,
        "purchase_cents": 25_000,
        "purchase_date": "2026-12-20",
    }
    script = r"""
import { evaluatePurchase } from "./web/dist-test/lib/scenarios.js";
import { parseLedgerState } from "./web/dist-test/lib/validate.js";
import fs from "fs";
const doc = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const parsed = parseLedgerState(doc.ledger);
if (!parsed.ok) { console.error(parsed.error); process.exit(2); }
const s = doc.simulation;
const assumptions = {
  horizonDays: doc.horizon_days, runs: s.runs, seed: s.seed,
  quantileNum: s.quantile_num, quantileDen: s.quantile_den,
  incomeVariationMin: s.income_variation_min, incomeVariationMax: s.income_variation_max,
  expenseVariationMin: s.expense_variation_min, expenseVariationMax: s.expense_variation_max,
  surpriseProbabilityPpm: s.surprise_probability_ppm,
  surpriseAmountMin: s.surprise_amount_min, surpriseAmountMax: s.surprise_amount_max,
  surpriseIntervalDays: s.surprise_check_interval_days, reserveCents: s.reserve_cents,
};
const result = evaluatePurchase(parsed.state, doc.as_of, assumptions, doc.purchase_cents, doc.purchase_date);
console.log(JSON.stringify(result));
"""
    with tempfile.TemporaryDirectory() as directory:
        scenario_path = Path(directory) / "purchase.json"
        scenario_path.write_text(json.dumps(doc), encoding="utf-8")
        proc = subprocess.run(
            ["node", "--input-type=module", "-e", script, str(scenario_path)],
            cwd=str(REPO_ROOT), capture_output=True, text=True,
        )
        assert proc.returncode == 0, proc.stderr
        web = json.loads(proc.stdout)
    assert web["status"] == "ok", web

    monkeypatch.setattr(db_manager, "DB_PATH", str(tmp_path / "purchase.db"))
    db_manager.init_db()
    sync.restore_ledger_snapshot(snapshot)
    from monte_carlo_ledger import decisions

    python = decisions.simulate_purchase(
        25_000, "2026-12-20", "2026-12-01", 60, sim
    )["with_purchase"]
    mapping = {
        "safe_to_spend_cents": "safeSpendCents",
        "negative_balance_probability_ppm": "overdraftPpm",
        "minimum_balance_p10_cents": "minimumBalanceP10Cents",
        "minimum_balance_p50_cents": "minimumBalanceP50Cents",
        "minimum_balance_p90_cents": "minimumBalanceP90Cents",
        "ending_balance_p10_cents": "endingBalanceP10Cents",
        "ending_balance_p50_cents": "endingBalanceP50Cents",
        "ending_balance_p90_cents": "endingBalanceP90Cents",
    }
    for python_field, web_field in mapping.items():
        assert python["risk"][python_field] == web["outcome"][web_field], python_field
