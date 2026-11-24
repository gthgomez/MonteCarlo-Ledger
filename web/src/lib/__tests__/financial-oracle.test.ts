import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import test from "node:test";
import { runScenario, timelineRows } from "../../contract/engine";
import { buildScenarioFromLedger } from "../scenario-builder";
import type { LedgerState } from "../types";

/**
 * Hand-derived debt settlement oracles. Expected values come from the fixture,
 * not from this engine; a mismatch is a financial defect, not a fixture update.
 */

function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, "testdata", "oracle", "debt-settlement-oracle.json"))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error("repository root not found");
}

const doc = JSON.parse(
  fs.readFileSync(path.join(repoRoot(), "testdata", "oracle", "debt-settlement-oracle.json"), "utf8")
);

for (const fixture of doc.cases) {
  test(`debt oracle: ${fixture.id}`, () => {
    const simulation = { ...doc.simulation, ...(fixture.simulation_overrides ?? {}) };
    const state = fixture.snapshot as LedgerState;
    const scenario = buildScenarioFromLedger(state, fixture.as_of, fixture.horizon_days, simulation);
    const rows = timelineRows(scenario);
    const cash = rows
      .filter((row) => row.type !== "income")
      .map((row) => [row.date, row.amount_cents, row.name]);
    assert.deepEqual(cash, fixture.expected.cash_events);

    const result = runScenario(scenario);
    assert.equal(result.risk.safe_to_spend_cents, fixture.expected.safe_to_spend_cents);
    assert.equal(result.forecast.minimum_balance_cents, fixture.expected.minimum_balance_cents);
    assert.equal(result.forecast.ending_balance_cents, fixture.expected.ending_balance_cents);
    assert.equal(
      result.risk.negative_balance_probability_ppm,
      fixture.expected.negative_balance_probability_ppm
    );
  });
}
