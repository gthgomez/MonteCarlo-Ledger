import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildScenarioFromLedger } from "../scenario-builder";
import { parseLedgerState } from "../validate";
import { runScenario } from "../../contract/engine";

/**
 * The same persisted household as tests/test_adapter_parity.py. The Web adapter
 * must build an equivalent canonical scenario from the persisted records and reach
 * the same conclusion as the Python adapter — not merely agree on raw JSON fixtures.
 */

function findRepoRoot(): string {
  let curr = __dirname;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(curr, "fixtures")) && fs.existsSync(path.join(curr, "schemas"))) {
      return curr;
    }
    curr = path.dirname(curr);
  }
  throw new Error("Could not locate repository root from " + __dirname);
}

const FIXTURE = path.join(findRepoRoot(), "testdata", "adapters", "synthetic-household.json");

test("the TypeScript adapter matches the Python adapter on the shared household", () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  const parsed = parseLedgerState(fixture.ledger);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
  if (!parsed.ok) return;

  const scenario = buildScenarioFromLedger(
    parsed.state,
    fixture.as_of,
    fixture.horizon_days,
    fixture.simulation
  );
  const result = runScenario(scenario);

  assert.deepEqual(result.forecast, fixture.expected.forecast);
  assert.deepEqual(result.risk, fixture.expected.risk);
});

function runMutated(mutate: (ledger: any) => void) {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  const ledger = JSON.parse(JSON.stringify(fixture.ledger));
  mutate(ledger);
  const parsed = parseLedgerState(ledger);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error);
  if (!parsed.ok) throw new Error("invalid mutant");
  const scenario = buildScenarioFromLedger(
    parsed.state,
    fixture.as_of,
    fixture.horizon_days,
    fixture.simulation
  );
  return { result: runScenario(scenario), expected: fixture.expected };
}

test("negative control: wrong monthly anchor is detected", () => {
  const { result, expected } = runMutated((ledger) => {
    ledger.incomes[0].last_payday = "2026-01-28";
  });
  assert.notDeepEqual(result.forecast, expected.forecast);
});

test("negative control: missing expected-amount override is detected", () => {
  const { result, expected } = runMutated((ledger) => {
    delete ledger.incomes[0].expected_amount;
  });
  assert.notDeepEqual(result.forecast, expected.forecast);
});

test("negative control: missing paid-bill exclusion is detected", () => {
  const { result, expected } = runMutated((ledger) => {
    ledger.bill_occurrences[0].paid = false;
  });
  assert.notDeepEqual(result.forecast, expected.forecast);
});

test("negative control: one-cent balance drift is detected", () => {
  const { result, expected } = runMutated((ledger) => {
    ledger.current_balance_cents -= 1;
    ledger.transactions[ledger.transactions.length - 1].amount_cents -= 1;
  });
  assert.notDeepEqual(result.forecast, expected.forecast);
});

test("the shared corpus starts from a real negative balance and a paid bill", () => {
  const fixture = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
  assert.ok(fixture.ledger.current_balance_cents < 0);
  assert.ok(fixture.ledger.bill_occurrences.some((o: any) => o.paid === true));
  assert.ok(fixture.ledger.incomes.some((i: any) => typeof i.expected_amount === "number"));
});
