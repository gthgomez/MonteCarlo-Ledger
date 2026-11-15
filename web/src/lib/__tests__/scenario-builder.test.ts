import assert from "node:assert/strict";
import test from "node:test";
import { buildScenarioFromLedger, planningMinimumPaymentCents } from "../scenario-builder";
import { LedgerState } from "../types";

function emptyState(overrides: Partial<LedgerState> = {}): LedgerState {
  return {
    version: "2.0",
    updated_at: "2026-11-07T00:00:00.000Z",
    current_balance_cents: 0,
    incomes: [],
    payments: [],
    transactions: [],
    bill_occurrences: [],
    liabilities: [],
    ...overrides,
  };
}

test("monthly income on the 31st clamps to month end and preserves the anchor", () => {
  const state = emptyState({
    incomes: [
      {
        id: "inc-1",
        name: "Monthly Salary",
        amount_cents: 100000,
        frequency: "Monthly",
        last_payday: "2026-12-31",
        next_payday: "2027-01-31",
      },
    ],
  });
  const scenario = buildScenarioFromLedger(state, "2027-01-01", 90);
  const incomeDates = scenario.events
    .filter((e: any) => e.type === "income")
    .map((e: any) => e.date)
    .sort();
  // 90 days from 2027-01-01 ends 2027-04-01 (exclusive): Jan 31, Feb 28, Mar 31.
  // The pre-fix builder drifted Jan 31 -> Mar 03 and skipped February entirely.
  assert.deepEqual(incomeDates, ["2027-01-31", "2027-02-28", "2027-03-31"]);
});

test("monthly income anchor survives a leap February", () => {
  const state = emptyState({
    incomes: [
      {
        id: "inc-1",
        name: "Monthly Salary",
        amount_cents: 100000,
        frequency: "Monthly",
        last_payday: "2027-12-31",
        next_payday: "2028-01-31",
      },
    ],
  });
  const scenario = buildScenarioFromLedger(state, "2028-01-01", 60);
  const incomeDates = scenario.events
    .filter((e: any) => e.type === "income")
    .map((e: any) => e.date)
    .sort();
  assert.deepEqual(incomeDates, ["2028-01-31", "2028-02-29"]);
});

test("paid bill occurrences are excluded from the scenario", () => {
  const state = emptyState({
    payments: [
      {
        id: "pmt-1",
        name: "Rent",
        amount_cents: 135000,
        due_date: "2027-01-05",
        recurrence: "Monthly",
      },
    ],
    bill_occurrences: [{ payment_id: "pmt-1", due_date: "2027-01-05", paid: true }],
  });
  const scenario = buildScenarioFromLedger(state, "2027-01-01", 70);
  const rentDates = scenario.events
    .filter((e: any) => e.name === "Rent")
    .map((e: any) => e.date);
  assert.equal(
    rentDates.includes("2027-01-05"),
    false,
    "the paid occurrence must not appear"
  );
  // Later, unpaid occurrences of the same bill must still be scheduled.
  assert.deepEqual(rentDates.sort(), ["2027-02-05", "2027-03-05"]);
});

test("events outside [as_of, windowEnd) are excluded", () => {
  const state = emptyState({
    payments: [
      {
        id: "pmt-1",
        name: "Bill",
        amount_cents: 5000,
        due_date: "2026-12-31",
        recurrence: "One-time",
      },
      {
        id: "pmt-2",
        name: "Far Future Bill",
        amount_cents: 5000,
        due_date: "2027-04-15",
        recurrence: "One-time",
      },
    ],
  });
  const scenario = buildScenarioFromLedger(state, "2027-01-01", 90);
  assert.deepEqual(scenario.events, []);
});

test("liabilities are mapped through with contract-2.0 fields", () => {
  const state = emptyState({
    liabilities: [
      {
        id: "card",
        name: "Credit Card",
        balance_cents: 100000,
        apr_basis_points: 2199,
        min_payment_cents: 5000,
        kind: "revolving",
        min_payment_percent_bps: 200,
        min_payment_floor_cents: 3500,
        due_day_of_month: 12,
      },
    ],
  });
  const scenario = buildScenarioFromLedger(state, "2027-01-01", 90);
  assert.equal(scenario.debt_strategy, "snowball");
  assert.deepEqual(scenario.liabilities, [
    {
      id: "card",
      name: "Credit Card",
      balance_cents: 100000,
      apr_basis_points: 2199,
      min_payment_cents: 5000,
      kind: "revolving",
      min_payment_percent_bps: 200,
      min_payment_floor_cents: 3500,
      due_day_of_month: 12,
    },
  ]);
  // Revolving planning min = max(2% of 100000, 3500) = 3500 on the 12th each month.
  const cardOutflows = scenario.events.filter((event: { name: string }) => event.name === "Credit Card");
  assert.equal(cardOutflows.length, 3);
  assert.ok(cardOutflows.every((event: { amount_cents: number }) => event.amount_cents === -3500));
});

test("revolving planning minimum uses percent/floor, not min_payment_cents", () => {
  assert.equal(
    planningMinimumPaymentCents({
      id: "card",
      name: "Card",
      balance_cents: 100_000,
      apr_basis_points: 2199,
      min_payment_cents: 6_500,
      kind: "revolving",
      min_payment_percent_bps: 200,
      min_payment_floor_cents: 3_500,
    }),
    3_500
  );
});

test("liability minimums lower the cash plan versus a twin without debt", () => {
  const base = emptyState({
    current_balance_cents: 100_000,
    transactions: [
      {
        id: "tx-1",
        amount_cents: 100_000,
        category: "System",
        type: "Adjustment",
        date: "2026-11-01",
        description: "Opening",
      },
    ],
  });
  const withDebt = emptyState({
    ...base,
    liabilities: [
      {
        id: "loan",
        name: "Auto Loan",
        balance_cents: 500_000,
        apr_basis_points: 599,
        min_payment_cents: 30_000,
        kind: "installment",
        due_day_of_month: 5,
      },
    ],
  });
  const without = buildScenarioFromLedger(base, "2026-11-01", 60);
  const withMins = buildScenarioFromLedger(withDebt, "2026-11-01", 60);
  assert.equal(without.events.length, 0);
  assert.ok(withMins.events.some((event: { amount_cents: number }) => event.amount_cents === -30_000));
});

test("monthly payment with due_day clamps to month end without drift", () => {
  const state = emptyState({
    payments: [
      {
        id: "pmt-1",
        name: "Storage Unit",
        amount_cents: 3000,
        due_day: 31,
        recurrence: "Monthly",
      },
    ],
  });
  const scenario = buildScenarioFromLedger(state, "2027-01-01", 90);
  const dates = scenario.events.map((e: any) => e.date).sort();
  assert.deepEqual(dates, ["2027-01-31", "2027-02-28", "2027-03-31"]);
});

test("a clamped stored next_payday does not erase the original anchor", () => {
  const state = emptyState({
    incomes: [
      {
        id: "inc-1",
        name: "Monthly Salary",
        amount_cents: 100000,
        frequency: "Monthly",
        last_payday: "2027-01-31",
        next_payday: "2027-02-28", // stored clamped occurrence
      },
    ],
  });
  const scenario = buildScenarioFromLedger(state, "2027-02-01", 90);
  const incomeDates = scenario.events
    .filter((e: any) => e.type === "income")
    .map((e: any) => e.date)
    .sort();
  assert.deepEqual(incomeDates, ["2027-02-28", "2027-03-31", "2027-04-30"]);
});

test("expected_amount overrides only the first projected paycheck", () => {
  const state = emptyState({
    incomes: [
      {
        id: "inc-1",
        name: "Monthly Salary",
        amount_cents: 220000,
        expected_amount: 235000,
        frequency: "Monthly",
        last_payday: "2027-01-31",
        next_payday: "2027-02-28",
      },
    ],
  });
  const scenario = buildScenarioFromLedger(state, "2027-02-01", 120);
  const amounts = scenario.events
    .filter((e: any) => e.type === "income")
    .map((e: any) => e.amount_cents);
  assert.equal(amounts[0], 235000);
  assert.deepEqual(amounts.slice(1), [220000, 220000, 220000]);
});
