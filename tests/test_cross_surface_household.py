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
from pathlib import Path

import pytest

from monte_carlo_ledger import db_manager, decisions, sync
from monte_carlo_ledger import scenario as scenario_mod
from monte_carlo_ledger.contract import run_scenario

REPO_ROOT = Path(__file__).resolve().parents[1]
FIXTURE = REPO_ROOT / "testdata" / "household" / "cross-surface-household.json"


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
  surfaces: {
    safe_to_spend_cents: result.risk.safe_to_spend_cents,
    overdraft_ppm: result.risk.negative_balance_probability_ppm,
    minimum_balance_p10_cents: result.risk.minimum_balance_p10_cents,
    minimum_balance_p50_cents: result.risk.minimum_balance_p50_cents,
    projected_low_cents: result.forecast.minimum_balance_cents,
    projected_low_date: result.forecast.minimum_balance_date,
    ending_balance_cents: result.forecast.ending_balance_cents,
    debt_months_to_payoff: result.debt.months_to_payoff,
    debt_total_interest_cents: result.debt.total_interest_cents,
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
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", script, str(FIXTURE)],
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
    result = run_scenario(built)
    assert "debt" not in result
    oracle = household["oracle"]
    assert result["risk"]["safe_to_spend_cents"] == oracle["safe_to_spend_cents"]
    assert result["forecast"]["ending_balance_cents"] == oracle["ending_balance_cents"]


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
