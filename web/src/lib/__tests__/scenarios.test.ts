import assert from "node:assert/strict";
import test from "node:test";

import { runScenario } from "../../contract/engine";
import { DEFAULT_ASSUMPTIONS } from "../assumptions";
import { buildScenarioFromLedger } from "../scenario-builder";
import {
  evaluateBillAmount,
  evaluateExtraDebtPayment,
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

test("delaying income with only a future posted refund returns NO_INCOME", () => {
  const ledger = emptyLedger(10_000);
  ledger.current_balance_cents += 5_000;
  ledger.transactions.push({
    id: "refund", amount_cents: 5_000, type: "Income", date: "2026-11-11", description: "Refund",
  });
  const result = evaluateIncomeDelay(ledger, AS_OF, DEFAULT_ASSUMPTIONS, 3);
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.code, "NO_INCOME");
});

test("late paycheck moves the first scheduled payday and leaves a posted refund in place", () => {
  const ledger = emptyLedger(50_000);
  ledger.current_balance_cents += 5_000;
  ledger.transactions.push({
    id: "refund", amount_cents: 5_000, type: "Income", date: "2026-11-11", description: "Refund",
  });
  ledger.incomes = [{
    id: "paycheck", name: "Paycheck", amount_cents: 40_000, frequency: "One-time",
    last_payday: "2026-11-12", next_payday: "2026-11-12",
  }];
  ledger.payments = [{
    id: "bill", name: "Bill", amount_cents: 30_000, recurrence: "One-time", due_date: "2026-11-15",
  }];
  const assumptions = {
    ...DEFAULT_ASSUMPTIONS, horizonDays: 10, runs: 10, surpriseProbabilityPpm: 0,
  };
  const saved = structuredClone(ledger);
  const delayed = evaluateIncomeDelay(ledger, AS_OF, assumptions, 5);
  assert.equal(delayed.status, "ok");
  if (delayed.status !== "ok") return;
  assert.equal(delayed.outcome.startingBalanceCents, 50_000);
  assert.equal(delayed.outcome.projectedLowCents, 25_000);
  assert.equal(delayed.outcome.endingBalanceCents, 65_000);
  assert.deepEqual(delayed.rows.map(({ date, amount_cents }) => [date, amount_cents]), [
    ["2026-11-11", 5_000], ["2026-11-15", -30_000], ["2026-11-17", 40_000],
  ]);
  assert.deepEqual(delayed.rows.map(({ source }) => source?.kind), [
    "posted-transaction", "bill", "scheduled-income",
  ]);
  assert.deepEqual(ledger, saved);
});

test("a moved unpaid linked bill and its minimum shortfall leave cash on the moved date", () => {
  const ledger = emptyLedger(50_000);
  ledger.version = "2.2";
  ledger.payments = [{
    id: "card-bill", name: "Card bill", amount_cents: 20_000, recurrence: "Monthly", due_day: 12,
  }];
  ledger.bill_occurrences = [{
    payment_id: "card-bill", original_due_date: "2026-11-12", due_date: "2026-11-17",
    is_user_modified: true, paid: false,
  }];
  ledger.liabilities = [{
    id: "card", name: "Card", balance_cents: 100_000, apr_basis_points: 0,
    min_payment_cents: 30_000, due_day_of_month: 15, linked_payment_id: "card-bill",
  }];
  const assumptions = {
    ...DEFAULT_ASSUMPTIONS, horizonDays: 10, runs: 10, surpriseProbabilityPpm: 0,
  };
  const full = evaluateLedger(ledger, AS_OF, assumptions);
  assert.equal(full.status, "ok");
  if (full.status !== "ok") return;
  assert.deepEqual(full.rows.map(({ date, amount_cents, name }) => [date, amount_cents, name]), [
    ["2026-11-17", -10_000, "Card"], ["2026-11-17", -20_000, "Card bill"],
  ]);
  assert.equal(full.outcome.projectedLowCents, 20_000);
  assert.equal(full.outcome.projectedLowDate, "2026-11-17");
  assert.deepEqual(full.debtMinimums, [{
    liability_id: "card", name: "Card", date: "2026-11-17",
    amount_cents: -10_000, due_day_of_month: 15,
  }]);
  assert.deepEqual(full.rows[1].source, {
    kind: "bill", paymentId: "card-bill", slotDate: "2026-11-12", dueDate: "2026-11-17",
  });

  const short = evaluateLedger(ledger, AS_OF, { ...assumptions, horizonDays: 7 });
  assert.equal(short.status, "ok");
  if (short.status !== "ok") return;
  assert.deepEqual(short.rows, []);
  assert.deepEqual(short.debtMinimums, []);
  assert.equal(short.outcome.endingBalanceCents, 50_000);
});

test("an unpaid linked slot from before the forecast month carries its shortfall past a paycheck", () => {
  const ledger = emptyLedger(25_000);
  ledger.version = "2.2";
  ledger.incomes = [{
    id: "paycheck", name: "Paycheck", amount_cents: 40_000, frequency: "One-time",
    last_payday: "2026-11-13", next_payday: "2026-11-13",
  }];
  ledger.payments = [{
    id: "card-bill", name: "Card bill", amount_cents: 20_000, recurrence: "Monthly", due_day: 29,
  }];
  ledger.bill_occurrences = [{
    payment_id: "card-bill", original_due_date: "2026-10-29", due_date: "2026-11-16",
    is_user_modified: true, paid: false,
  }];
  ledger.liabilities = [{
    id: "card", name: "Card", balance_cents: 55_000, apr_basis_points: 1_200,
    min_payment_cents: 30_000, due_day_of_month: 29, linked_payment_id: "card-bill",
  }];
  const assumptions = {
    ...DEFAULT_ASSUMPTIONS, horizonDays: 10, runs: 10,
    incomeVariationMin: 0, incomeVariationMax: 0, surpriseProbabilityPpm: 0,
  };
  const short = evaluateLedger(ledger, AS_OF, assumptions);
  assert.equal(short.status, "ok");
  if (short.status !== "ok") return;
  // $250 opening + $400 payday - $100 shortfall - $200 bill = $350 ending.
  assert.deepEqual(short.rows.map(({ date, amount_cents, name }) => [date, amount_cents, name]), [
    ["2026-11-13", 40_000, "Paycheck"],
    ["2026-11-16", -10_000, "Card"],
    ["2026-11-16", -20_000, "Card bill"],
  ]);
  assert.equal(short.outcome.projectedLowCents, 25_000);
  assert.equal(short.outcome.endingBalanceCents, 35_000);
  assert.equal(short.outcome.safeSpendCents, 25_000);

  const full = evaluateLedger(ledger, AS_OF, { ...assumptions, horizonDays: 20 });
  assert.equal(full.status, "ok");
  if (full.status !== "ok") return;
  // The $300 carried minimum leaves $250 of opening principal. November's
  // $200 bill covers all but $50 of it, with no interest charged for October.
  assert.deepEqual(full.debtMinimums.map(({ date, amount_cents }) => [date, amount_cents]), [
    ["2026-11-16", -10_000],
    ["2026-11-29", -5_000],
  ]);
  assert.equal(full.outcome.endingBalanceCents, 10_000);
});

test("an accelerated one-time linked bill includes its shortfall even when its original month is outside the window", () => {
  const ledger = emptyLedger(50_000);
  ledger.version = "2.2";
  ledger.payments = [{
    id: "card-bill", name: "Card bill", amount_cents: 20_000, recurrence: "One-time", due_date: "2027-01-15",
  }];
  ledger.bill_occurrences = [{
    payment_id: "card-bill", original_due_date: "2027-01-15", due_date: "2026-11-16",
    is_user_modified: true, paid: false,
  }];
  ledger.liabilities = [{
    id: "card", name: "Card", balance_cents: 300_000, apr_basis_points: 2_400,
    kind: "revolving", min_payment_cents: 0, min_payment_percent_bps: 1_000,
    due_day_of_month: 30, linked_payment_id: "card-bill",
  }];
  const assumptions = {
    ...DEFAULT_ASSUMPTIONS, horizonDays: 10, runs: 10, surpriseProbabilityPpm: 0,
  };
  const short = evaluateLedger(ledger, AS_OF, assumptions);
  assert.equal(short.status, "ok");
  if (short.status !== "ok") return;
  // At the November cash date, the $3,000 opening debt needs $300 before
  // any later month's interest. The linked bill covers $200 of that amount.
  assert.deepEqual(short.rows.map(({ date, amount_cents, name }) => [date, amount_cents, name]), [
    ["2026-11-16", -10_000, "Card"],
    ["2026-11-16", -20_000, "Card bill"],
  ]);
  assert.equal(short.outcome.projectedLowCents, 20_000);
  assert.equal(short.outcome.endingBalanceCents, 20_000);
  assert.equal(short.outcome.safeSpendCents, 20_000);

  const full = evaluateLedger(ledger, AS_OF, { ...assumptions, horizonDays: 83 });
  assert.equal(full.status, "ok");
  if (full.status !== "ok") return;
  // November's fallback is 10% of the $2,700 remaining after the move. In
  // December, $2,430 gains 2% interest before its $247.86 minimum. January
  // has no separate fallback: its linked slot has already been moved.
  assert.deepEqual(full.debtMinimums.map(({ date, amount_cents }) => [date, amount_cents]), [
    ["2026-11-16", -10_000],
    ["2026-11-30", -27_000],
    ["2026-12-30", -24_786],
  ]);
  assert.equal(full.outcome.endingBalanceCents, -31_786);
});

test("evaluated row sources distinguish identical-looking bills, transactions, and debt minimums", () => {
  const date = "2026-11-12";
  const ledger = emptyLedger(50_000);
  ledger.current_balance_cents -= 10_000;
  ledger.transactions.push({
    id: "posted-card", amount_cents: -10_000, type: "Expense", date, description: "Card",
  });
  ledger.payments = [{
    id: "card-bill", name: "Card", amount_cents: 10_000, recurrence: "One-time", due_date: date,
  }];
  ledger.liabilities = [{
    id: "card", name: "Card", balance_cents: 10_000, apr_basis_points: 0,
    min_payment_cents: 10_000, due_day_of_month: 12,
  }];
  const assumptions = {
    ...DEFAULT_ASSUMPTIONS, horizonDays: 10, runs: 10, surpriseProbabilityPpm: 0,
  };
  const result = evaluateLedger(ledger, AS_OF, assumptions);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.rows.map(({ source, balance_after_cents }) => [source, balance_after_cents]), [
    [{ kind: "bill", paymentId: "card-bill", slotDate: date, dueDate: date }, 40_000],
    [{ kind: "posted-transaction", transactionId: "posted-card" }, 30_000],
    [{ kind: "debt-minimum", minimum: result.debtMinimums[0] }, 20_000],
  ]);
  assert.equal(result.debtMinimums.length, 1);
  const scenario = buildScenarioFromLedger(ledger, AS_OF, assumptions.horizonDays);
  assert.deepEqual(scenario.events, Array.from({ length: 3 }, () => ({
    date, amount_cents: -10_000, type: "expense", name: "Card",
  })));
});

test("an anchored monthly bill does not appear before its first saved date", () => {
  const ledger = emptyLedger(50_000);
  ledger.transactions[0].date = "2026-10-09";
  ledger.payments = [{
    id: "utility", name: "Utility", amount_cents: 30_000, recurrence: "Monthly", due_day: 15, due_date: "2026-11-15",
  }];
  const assumptions = { ...DEFAULT_ASSUMPTIONS, horizonDays: 45 };
  const result = evaluateLedger(ledger, "2026-10-10", assumptions);
  assert.equal(result.status, "ok");
  if (result.status === "ok") {
    assert.deepEqual(result.rows.map((row) => [row.date, row.amount_cents]), [["2026-11-15", -30_000]]);
  }
});

test("legacy edited due days match by explicit payment ID and oldest original slot", () => {
  const ledger = emptyLedger(100_000);
  ledger.payments = [{
    id: "bill", name: "Loan bill", amount_cents: 20_000, recurrence: "Monthly", due_day: 15,
  }];
  ledger.bill_occurrences = [
    { payment_id: "bill", original_due_date: "2026-11-08", due_date: "2026-11-10", paid: false, is_user_modified: true },
    { payment_id: "bill", original_due_date: "2026-11-05", due_date: "2026-11-20", paid: false, is_user_modified: true },
  ];
  ledger.liabilities = [{
    id: "loan", name: "Loan", balance_cents: 50_000, apr_basis_points: 0,
    min_payment_cents: 30_000, due_day_of_month: 15, linked_payment_id: "bill",
  }];
  const assumptions = { ...DEFAULT_ASSUMPTIONS, horizonDays: 21 };
  for (const occurrences of [ledger.bill_occurrences, [...ledger.bill_occurrences].reverse()]) {
    const result = evaluateLedger({ ...ledger, bill_occurrences: occurrences }, AS_OF, assumptions);
    assert.equal(result.status, "ok");
    if (result.status === "ok") {
      assert.deepEqual(result.debtMinimums.map((minimum) => [minimum.date, minimum.amount_cents]), [
        ["2026-11-20", -10_000],
      ]);
    }
  }
});

test("an overflowing debt projection fails within evaluation without publishing partial minimums", () => {
  const ledger = emptyLedger(50_000);
  ledger.liabilities = [{
    id: "card", name: "Card", balance_cents: Number.MAX_SAFE_INTEGER, apr_basis_points: 1_200,
    min_payment_cents: 1, due_day_of_month: 12,
  }];
  const result = evaluateLedger(ledger, AS_OF, DEFAULT_ASSUMPTIONS);
  assert.equal(result.status, "error");
  if (result.status === "error") assert.equal(result.code, "MONEY_OVERFLOW");
  assert.equal("debtMinimums" in result, false);
});

test("an extra debt payment consumes the reserve margin once without changing a linked minimum", () => {
  const ledger = emptyLedger(100_000);
  ledger.version = "2.2";
  ledger.payments = [
    { id: "rent", name: "Rent", amount_cents: 60_000, recurrence: "Monthly", due_day: 11 },
    { id: "loan-bill", name: "Loan bill", amount_cents: 20_000, recurrence: "Monthly", due_day: 12 },
  ];
  ledger.liabilities = [{
    id: "loan", name: "Loan", balance_cents: 90_000, apr_basis_points: 0,
    min_payment_cents: 20_000, due_day_of_month: 12, linked_payment_id: "loan-bill",
  }];
  const saved = structuredClone(ledger);
  const assumptions = {
    ...DEFAULT_ASSUMPTIONS,
    horizonDays: 10, runs: 10, reserveCents: 10_000, surpriseProbabilityPpm: 0,
  };
  const baseline = evaluateLedger(ledger, AS_OF, assumptions);
  const inside = evaluateExtraDebtPayment(ledger, AS_OF, assumptions, 15_000, AS_OF);
  const lastDay = evaluateExtraDebtPayment(ledger, AS_OF, assumptions, 25_000, "2026-11-19");
  assert.equal(baseline.status, "ok");
  assert.equal(inside.status, "ok");
  assert.equal(lastDay.status, "ok");
  if (baseline.status !== "ok" || inside.status !== "ok" || lastDay.status !== "ok") return;
  // $1,000 - $600 rent - $200 loan = $200 low, then $100 reserved. The
  // $150 extra leaves $50 in cash ($50 below reserve), not an overdraft.
  assert.equal(baseline.outcome.safeSpendCents, 10_000);
  assert.equal(inside.outcome.endingBalanceCents, 5_000);
  assert.equal(inside.outcome.safeSpendCents, -5_000);
  assert.equal(inside.outcome.firstNegativeDate, null);
  assert.equal(inside.outcome.overdraftPpm, 0);
  assert.deepEqual(inside.rows.map(({ date, amount_cents }) => [date, amount_cents]), [
    [AS_OF, -15_000], ["2026-11-11", -60_000], ["2026-11-12", -20_000],
  ]);
  assert.equal(lastDay.outcome.endingBalanceCents, -5_000);
  assert.equal(lastDay.outcome.firstNegativeDate, "2026-11-19");
  assert.equal(lastDay.outcome.overdraftPpm, 1_000_000);
  assert.deepEqual(ledger, saved);
});

test("extra debt payment rejects unsupported amounts and dates outside the half-open window", () => {
  const assumptions = { ...DEFAULT_ASSUMPTIONS, horizonDays: 10 };
  const ledger = emptyLedger(100_000);
  for (const [amount, date, code] of [
    [1, "2026-11-09", "EVENT_OUT_OF_HORIZON"],
    [1, "2026-11-20", "EVENT_OUT_OF_HORIZON"],
    [1, "2026-11-31", "INVALID_DATE"],
    [0, AS_OF, "INVALID_AMOUNT"],
    [1.25, AS_OF, "INVALID_AMOUNT"],
  ] as const) {
    const result = evaluateExtraDebtPayment(ledger, AS_OF, assumptions, amount, date);
    assert.equal(result.status, "error");
    if (result.status === "error") assert.equal(result.code, code);
  }
});

test("a fixed extra payment does not shift the other seeded random draws", () => {
  const ledger = emptyLedger(10_000);
  ledger.payments = [{
    id: "bill", name: "Ordinary bill", amount_cents: 10_000, recurrence: "Monthly", due_day: 11,
  }];
  const assumptions = {
    ...DEFAULT_ASSUMPTIONS,
    seed: 11, runs: 10, horizonDays: 10,
    expenseVariationMin: -20, expenseVariationMax: 20, surpriseProbabilityPpm: 0,
  };
  const baseline = evaluateLedger(ledger, AS_OF, assumptions);
  const draft = evaluateExtraDebtPayment(ledger, AS_OF, assumptions, 1, AS_OF);
  assert.equal(baseline.status, "ok");
  assert.equal(draft.status, "ok");
  if (baseline.status !== "ok" || draft.status !== "ok") return;
  // The ten bill draws for seed 11 are 1%, 3%, 1%, −13%, −11%, 14%, −19%, −17%, 16%, 1%.
  // Six runs go below zero either way. The worst low is 16% of $100 plus the exact cent.
  assert.equal(baseline.outcome.overdraftPpm, 600_000);
  assert.equal(draft.outcome.overdraftPpm, 600_000);
  assert.equal(baseline.outcome.minimumBalanceP10Cents, -1_600);
  assert.equal(draft.outcome.minimumBalanceP10Cents, -1_601);
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

test("an extra debt payment is frozen against bill variance but the linked minimum still varies", () => {
  // Hand oracle: $1,000 cash, a $100 linked minimum, and a $980 extra today.
  // Exact schedule: 1000 - 100 - 980 = -$80. A fixed -50% bill variance halves
  // only the minimum, so every modeled low is 1000 - 50 - 980 = -$30.
  const ledger = emptyLedger(100_000);
  ledger.version = "2.2";
  ledger.payments = [
    { id: "loan-bill", name: "Loan bill", amount_cents: 10_000, recurrence: "Monthly", due_day: 10 },
  ];
  ledger.liabilities = [{
    id: "loan", name: "Loan", balance_cents: 10_000, apr_basis_points: 0,
    min_payment_cents: 10_000, due_day_of_month: 10, linked_payment_id: "loan-bill",
  }];
  const saved = structuredClone(ledger);
  const assumptions = {
    ...DEFAULT_ASSUMPTIONS,
    horizonDays: 30,
    runs: 10,
    expenseVariationMin: -50,
    expenseVariationMax: -50,
    surpriseProbabilityPpm: 0,
    reserveCents: 0,
  };
  const result = evaluateExtraDebtPayment(ledger, AS_OF, assumptions, 98_000, AS_OF);
  assert.equal(result.status, "ok");
  if (result.status !== "ok") return;
  assert.deepEqual(result.rows.map(({ date, amount_cents }) => [date, amount_cents]), [
    [AS_OF, -98_000],
    [AS_OF, -10_000],
  ]);
  assert.equal(result.outcome.projectedLowCents, -8_000);
  assert.equal(result.outcome.safeSpendCents, -3_000);
  assert.equal(result.outcome.overdraftPpm, 1_000_000);
  assert.equal(result.outcome.firstNegativeDate, AS_OF);
  assert.deepEqual(ledger, saved);
});

test("a hypothetical purchase stays fixed and consumes no bill draw", () => {
  const ledger = emptyLedger(100_000);
  ledger.payments = [
    { id: "bill-a", name: "A bill", amount_cents: 10_000, recurrence: "Monthly", due_day: 10 },
    { id: "bill-b", name: "B bill", amount_cents: 20_000, recurrence: "Monthly", due_day: 20 },
  ];
  const assumptions = {
    ...DEFAULT_ASSUMPTIONS,
    horizonDays: 60,
    runs: 200,
    seed: 7,
    expenseVariationMin: -50,
    expenseVariationMax: 50,
    surpriseProbabilityPpm: 0,
    reserveCents: 0,
  };
  const baseline = evaluateLedger(ledger, AS_OF, assumptions);
  assert.equal(baseline.status, "ok");
  if (baseline.status !== "ok") return;
  const amount = 10_000;
  const purchase = evaluatePurchase(ledger, AS_OF, assumptions, amount, AS_OF);
  assert.equal(purchase.status, "ok");
  if (purchase.status !== "ok") return;

  // The decision amount must not be scaled by bill variance, and the other bills'
  // draws must be identical, so every modeled trough moves by exactly the amount.
  assert.equal(purchase.outcome.projectedLowCents, baseline.outcome.projectedLowCents - amount);
  assert.equal(purchase.outcome.safeSpendCents, baseline.outcome.safeSpendCents - amount);
  assert.equal(purchase.outcome.minimumBalanceP10Cents, baseline.outcome.minimumBalanceP10Cents - amount);
  assert.equal(purchase.outcome.overdraftPpm, baseline.outcome.overdraftPpm);
});

test("a monthly set-aside stays fixed under bill variation", () => {
  const ledger = emptyLedger(100_000);
  const assumptions = {
    ...DEFAULT_ASSUMPTIONS,
    horizonDays: 30,
    runs: 50,
    seed: 3,
    expenseVariationMin: -50,
    expenseVariationMax: 50,
    surpriseProbabilityPpm: 0,
    reserveCents: 0,
  };
  const aside = evaluateMonthlySetAside(ledger, AS_OF, assumptions, 25_000);
  assert.equal(aside.status, "ok");
  if (aside.status !== "ok") return;
  assert.equal(aside.outcome.safeSpendCents, 75_000);
  assert.equal(aside.outcome.projectedLowCents, 75_000);
  assert.deepEqual(
    aside.rows.filter((row) => row.name === "Amount set aside").map((row) => row.amount_cents),
    [-25_000]
  );
});

test("a coincidental category name cannot freeze an existing future expense", () => {
  const ledger = emptyLedger(100_000);
  ledger.current_balance_cents = 100_000;
  ledger.transactions = [
    { id: "tx-open", amount_cents: 110_000, type: "Adjustment", date: AS_OF, category: "Adjustment" },
    {
      id: "tx-existing",
      amount_cents: -10_000,
      type: "Expense",
      date: "2027-01-10",
      category: "extra-debt-payment",
      description: "Existing future expense",
    },
  ];
  const assumptions = {
    ...DEFAULT_ASSUMPTIONS,
    horizonDays: 60,
    runs: 200,
    seed: 9,
    expenseVariationMin: -50,
    expenseVariationMax: 50,
    surpriseProbabilityPpm: 0,
    reserveCents: 0,
  };
  const baseline = evaluateLedger(ledger, AS_OF, assumptions);
  assert.equal(baseline.status, "ok");
  if (baseline.status !== "ok") return;
  const extra = evaluateExtraDebtPayment(ledger, AS_OF, assumptions, 5_000, AS_OF);
  assert.equal(extra.status, "ok");
  if (extra.status !== "ok") return;
  // Only the fixed extra payment moves every modeled trough; the existing
  // same-category expense keeps its normal seeded variation.
  assert.equal(extra.outcome.projectedLowCents, baseline.outcome.projectedLowCents - 5_000);
  assert.equal(extra.outcome.minimumBalanceP10Cents, baseline.outcome.minimumBalanceP10Cents - 5_000);
});

test("public scenarios reject an adapter-private fixed field", () => {
  assert.throws(
    () =>
      runScenario({
        contract_version: "2.0",
        scenario_id: "fixed-field",
        as_of: AS_OF,
        starting_balance_cents: 100_000,
        horizon_days: 30,
        events: [
          { date: AS_OF, amount_cents: -10_000, type: "expense", name: "Rent", fixed: true },
        ],
      }),
    /fixed is not a contract event field/
  );
});
