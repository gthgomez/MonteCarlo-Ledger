import assert from "node:assert/strict";
import test from "node:test";

import { runScenario } from "../../contract/engine";
import { DEFAULT_ASSUMPTIONS } from "../assumptions";
import { buildScenarioFromLedger } from "../scenario-builder";
import {
  evaluateBillAmount,
  evaluateIncomeDelay,
  evaluateLedger,
  evaluateMonthlySetAside,
  evaluatePurchase,
} from "../scenarios";
import { LedgerState, SAMPLE_LEDGER_STATE } from "../types";

const AS_OF = "2026-11-10";

function emptyLedger(balanceCents: number): LedgerState {
  return {
    version: "2.0",
    updated_at: "2026-11-10T00:00:00.000Z",
    current_balance_cents: balanceCents,
    incomes: [],
    payments: [],
    transactions:
      balanceCents === 0
        ? []
        : [
            {
              id: "tx-open",
              amount_cents: balanceCents,
              type: "Adjustment",
              category: "Adjustment",
              date: "2026-11-01",
              description: "Opening",
            },
          ],
    bill_occurrences: [],
    liabilities: [],
  };
}

test("default assumptions match the previous partial simulation config", () => {
  const partial = buildScenarioFromLedger(SAMPLE_LEDGER_STATE, AS_OF, 90, {
    runs: 500,
    seed: 42,
    quantile_num: 1,
    quantile_den: 10,
  });
  const previous = runScenario(partial);
  const current = evaluateLedger(SAMPLE_LEDGER_STATE, AS_OF, DEFAULT_ASSUMPTIONS);
  assert.equal(current.status, "ok");
  if (current.status !== "ok") return;
  assert.equal(current.outcome.safeSpendCents, previous.risk.safe_to_spend_cents);
  assert.equal(current.outcome.overdraftPpm, previous.risk.negative_balance_probability_ppm);
  assert.equal(current.outcome.minimumBalanceP10Cents, previous.risk.minimum_balance_p10_cents);
  assert.equal(current.outcome.minimumBalanceP50Cents, previous.risk.minimum_balance_p50_cents);
  assert.equal(current.outcome.projectedLowCents, previous.forecast.minimum_balance_cents);
  assert.equal(current.outcome.endingBalanceCents, previous.forecast.ending_balance_cents);
  assert.equal(current.rows.length > 0, true);
});

test("a purchase outside the window fails closed and does not change the ledger", () => {
  const before = structuredClone(SAMPLE_LEDGER_STATE);
  const outside = evaluatePurchase(SAMPLE_LEDGER_STATE, AS_OF, DEFAULT_ASSUMPTIONS, 650_00, "2027-06-01");
  assert.equal(outside.status, "error");
  if (outside.status === "error") assert.equal(outside.code, "EVENT_OUT_OF_HORIZON");
  const zero = evaluatePurchase(SAMPLE_LEDGER_STATE, AS_OF, DEFAULT_ASSUMPTIONS, 0, AS_OF);
  assert.equal(zero.status, "error");
  if (zero.status === "error") assert.equal(zero.code, "INVALID_AMOUNT");
  assert.deepEqual(SAMPLE_LEDGER_STATE, before);
});

test("a purchase result is the engine result for that added expense", () => {
  const amount = 35_000;
  const evaluated = evaluatePurchase(SAMPLE_LEDGER_STATE, AS_OF, DEFAULT_ASSUMPTIONS, amount, AS_OF);
  const scenario = buildScenarioFromLedger(SAMPLE_LEDGER_STATE, AS_OF, 90, {
    runs: 500,
    seed: 42,
    quantile_num: 1,
    quantile_den: 10,
    income_variation_min: -8,
    income_variation_max: 8,
    expense_variation_min: 0,
    expense_variation_max: 0,
    surprise_probability_ppm: 150_000,
    surprise_amount_min: 2_000,
    surprise_amount_max: 15_000,
    surprise_check_interval_days: 14,
    reserve_cents: 0,
  });
  scenario.events.push({
    date: AS_OF,
    amount_cents: -amount,
    type: "expense",
    name: "Simulated Purchase",
  });
  const raw = runScenario(scenario);
  assert.equal(evaluated.status, "ok");
  if (evaluated.status !== "ok") return;
  assert.equal(evaluated.outcome.safeSpendCents, raw.risk.safe_to_spend_cents);
  assert.equal(evaluated.outcome.overdraftPpm, raw.risk.negative_balance_probability_ppm);
  assert.equal(evaluated.outcome.projectedLowCents, raw.forecast.minimum_balance_cents);
});

test("delaying income with no paycheck returns NO_INCOME", () => {
  const result = evaluateIncomeDelay(emptyLedger(10_000), AS_OF, DEFAULT_ASSUMPTIONS, 3);
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.code, "NO_INCOME");
});

test("an unknown bill is not given a made-up result", () => {
  const result = evaluateBillAmount(SAMPLE_LEDGER_STATE, AS_OF, DEFAULT_ASSUMPTIONS, "missing", 1_000);
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.code, "PAYMENT_NOT_FOUND");
});

test("setting money aside is modeled as a bill and does not mutate the ledger", () => {
  const before = structuredClone(SAMPLE_LEDGER_STATE);
  const base = evaluateLedger(SAMPLE_LEDGER_STATE, AS_OF, DEFAULT_ASSUMPTIONS);
  const aside = evaluateMonthlySetAside(SAMPLE_LEDGER_STATE, AS_OF, DEFAULT_ASSUMPTIONS, 10_000);
  assert.equal(base.status, "ok");
  assert.equal(aside.status, "ok");
  if (base.status !== "ok" || aside.status !== "ok") return;
  assert.equal(
    aside.rows.some((row) => row.name === "Amount set aside"),
    true
  );
  assert.notEqual(aside.outcome.endingBalanceCents, base.outcome.endingBalanceCents);
  assert.deepEqual(SAMPLE_LEDGER_STATE, before);
});

test("a bill larger than the balance produces a negative plan without a substituted zero", () => {
  const state = emptyLedger(10_000);
  state.payments = [
    {
      id: "rent",
      name: "Rent",
      amount_cents: 50_000,
      recurrence: "Monthly",
      due_day: 1,
    },
  ];
  const result = evaluateLedger(state, AS_OF, DEFAULT_ASSUMPTIONS);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.ok(result.outcome.projectedLowCents < 0);
  assert.ok(result.outcome.firstNegativeDate);
  assert.ok(result.outcome.safeSpendCents < 0);
});
