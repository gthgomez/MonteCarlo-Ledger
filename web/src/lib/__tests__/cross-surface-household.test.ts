/**
 * Cross-surface household: Home / Money / Budget / Bills / Plan / Future share
 * one Contract 2.0 evaluation for the synthetic fixture. Stochastic fields are
 * seed-bound to the fixture; they are not promised outcomes.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { amortize } from "../../contract/debt";
import { runScenario, timelineRows } from "../../contract/engine";
import { safeSpendTechnicalName } from "../assumptions";
import {
  cashMinusEnteredDebt,
  slicePlan,
  spendingThisMonth,
} from "../present";
import { buildScenarioFromLedger } from "../scenario-builder";
import { parseLedgerState } from "../validate";

function findRepoRoot(start: string = __dirname): string {
  let dir = start;
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(dir, "testdata", "household", "cross-surface-household.json"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("could not locate repository root from " + start);
}

const FIXTURE = path.join(
  findRepoRoot(),
  "testdata",
  "household",
  "cross-surface-household.json"
);

const doc = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));

test("web surfaces share one seed-bound evaluation against the oracle", () => {
  const parsed = parseLedgerState(doc.ledger);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

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
  const oracle = doc.oracle;

  // Home / Future / Plan cautious figures
  assert.equal(result.risk.safe_to_spend_cents, oracle.safe_to_spend_cents);
  assert.equal(result.risk.negative_balance_probability_ppm, oracle.overdraft_ppm);
  assert.equal(result.risk.minimum_balance_p10_cents, oracle.minimum_balance_p10_cents);
  assert.equal(result.risk.minimum_balance_p50_cents, oracle.minimum_balance_p50_cents);
  assert.equal(result.forecast.minimum_balance_cents, oracle.projected_low_cents);
  assert.equal(result.forecast.minimum_balance_date, oracle.projected_low_date);
  assert.equal(result.forecast.ending_balance_cents, oracle.ending_balance_cents);
  assert.equal(
    safeSpendTechnicalName(doc.simulation.quantile_num, doc.simulation.quantile_den),
    oracle.p10_label
  );

  // Money
  assert.equal(scenario.starting_balance_cents, oracle.starting_balance_cents);
  assert.equal(net, oracle.cash_minus_entered_debt_cents);

  // Budget (recorded spend only)
  assert.equal(spend.totalCents, oracle.recorded_spend_this_month_cents);

  // Bills (horizon window from the shared timeline)
  assert.equal(slice.scheduledOutflowCents, oracle.scheduled_outflow_in_horizon_cents);

  // Plan debt block (same amortize path; not folded into cash forecast)
  assert.equal(result.debt.months_to_payoff, oracle.debt_months_to_payoff);
  assert.equal(result.debt.total_interest_cents, oracle.debt_total_interest_cents);
  const planDebt = amortize(
    doc.as_of,
    scenario.liabilities,
    "snowball",
    0
  );
  assert.equal(planDebt.months_to_payoff, oracle.debt_months_to_payoff);
});

test("legacy snapshot without liabilities still loads and keeps cash metrics", () => {
  const parsed = parseLedgerState(doc.legacy_snapshot_without_liabilities);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.state.liabilities.length, 0);

  const scenario = buildScenarioFromLedger(
    parsed.state,
    doc.as_of,
    doc.horizon_days,
    doc.simulation
  );
  assert.equal("liabilities" in scenario, false);
  const result = runScenario(scenario);
  assert.equal("debt" in result, false);
  assert.equal(result.risk.safe_to_spend_cents, doc.oracle.safe_to_spend_cents);
  assert.equal(result.forecast.ending_balance_cents, doc.oracle.ending_balance_cents);
});

test("import then restart from JSON keeps liabilities and P10", () => {
  const raw = JSON.stringify(doc.ledger);
  const again = parseLedgerState(JSON.parse(raw));
  assert.equal(again.ok, true);
  if (!again.ok) return;
  assert.equal(again.state.liabilities.length, 2);

  const scenario = buildScenarioFromLedger(
    again.state,
    doc.as_of,
    doc.horizon_days,
    doc.simulation
  );
  const result = runScenario(scenario);
  assert.equal(result.risk.minimum_balance_p10_cents, doc.oracle.minimum_balance_p10_cents);
  assert.equal(result.debt.months_to_payoff, doc.oracle.debt_months_to_payoff);
});
