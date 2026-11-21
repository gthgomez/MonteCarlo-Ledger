import assert from "node:assert/strict";
import test from "node:test";
import { runScenario } from "../../contract/engine";
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

test("an overdue current-month minimum is charged at the as-of date", () => {
  const state = emptyState({
    liabilities: [
      {
        id: "loan",
        name: "Small Loan",
        balance_cents: 5_000,
        apr_basis_points: 0,
        min_payment_cents: 3_000,
        kind: "installment",
        due_day_of_month: 10,
      },
    ],
  });

  const scenario = buildScenarioFromLedger(state, "2027-01-20", 31);

  assert.deepEqual(
    scenario.events.map((event: any) => [event.date, event.amount_cents]),
    [
      ["2027-01-20", -3_000],
      ["2027-02-10", -2_000],
    ]
  );
});

test("revolving minimums include monthly interest before future due dates", () => {
  const state = emptyState({
    liabilities: [
      {
        id: "card",
        name: "Card",
        balance_cents: 100_000,
        apr_basis_points: 12_000,
        min_payment_cents: 0,
        kind: "revolving",
        min_payment_percent_bps: 1_000,
        min_payment_floor_cents: 0,
        due_day_of_month: 10,
      },
    ],
  });

  const scenario = buildScenarioFromLedger(state, "2027-01-01", 90);

  assert.deepEqual(
    scenario.events.map((event: any) => [event.date, event.amount_cents]),
    [
      ["2027-01-10", -10_000],
      ["2027-02-10", -9_900],
      ["2027-03-10", -9_801],
    ]
  );
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

test("installment cash payments shrink the balance and cap the final payment", () => {
  const state = emptyState({
    current_balance_cents: 100_000,
    liabilities: [
      {
        id: "loan-1",
        name: "Small Loan",
        balance_cents: 8_000,
        apr_basis_points: 0,
        min_payment_cents: 3_000,
        due_day_of_month: 15,
      },
    ],
  });
  const scenario = buildScenarioFromLedger(state, "2027-01-01", 90);
  assert.deepEqual(
    scenario.events.map((event: any) => [event.date, event.amount_cents]),
    [
      ["2027-01-15", -3_000],
      ["2027-02-15", -3_000],
      ["2027-03-15", -2_000],
    ]
  );
});

test("a recurring bill that covers a debt is not charged a second time", () => {
  const state = emptyState({
    payments: [
      {
        id: "pmt-loan",
        name: "Small Loan",
        amount_cents: 3_000,
        due_day: 15,
        recurrence: "Monthly",
      },
    ],
    liabilities: [
      {
        id: "loan-1",
        name: "Small Loan",
        balance_cents: 8_000,
        apr_basis_points: 0,
        min_payment_cents: 3_000,
        due_day_of_month: 15,
        linked_payment_id: "pmt-loan",
      },
    ],
  });
  const scenario = buildScenarioFromLedger(state, "2027-01-01", 90);
  assert.deepEqual(
    scenario.events.map((event: any) => [event.date, event.amount_cents, event.name]),
    [
      ["2027-01-15", -3_000, "Small Loan"],
      ["2027-02-15", -3_000, "Small Loan"],
      ["2027-03-15", -3_000, "Small Loan"],
    ]
  );
});

test("identical unrelated bills do not suppress a debt minimum", () => {
  const state = emptyState({
    payments: [{ id: "pmt-unrelated", name: "Small Loan", amount_cents: 3_000, due_day: 15, recurrence: "Monthly" }],
    liabilities: [{
      id: "loan-1", name: "Small Loan", balance_cents: 8_000, apr_basis_points: 0,
      min_payment_cents: 3_000, due_day_of_month: 15,
    }],
  });
  const scenario = buildScenarioFromLedger(state, "2027-01-01", 30);
  assert.deepEqual(
    scenario.events.map((event: any) => [event.date, event.amount_cents]),
    [["2027-01-15", -3_000], ["2027-01-15", -3_000]],
  );
});

test("a linked bill contributes only the debt minimum shortfall", () => {
  const state = emptyState({
    payments: [{ id: "pmt-loan", name: "Loan draft", amount_cents: 1_000, due_day: 15, recurrence: "Monthly" }],
    liabilities: [{
      id: "loan-1", name: "Loan", balance_cents: 8_000, apr_basis_points: 0,
      min_payment_cents: 3_000, due_day_of_month: 15, linked_payment_id: "pmt-loan",
    }],
  });
  const scenario = buildScenarioFromLedger(state, "2027-01-01", 30);
  assert.deepEqual(
    scenario.events.map((event: any) => [event.date, event.amount_cents]),
    [["2027-01-15", -1_000], ["2027-01-15", -2_000]],
  );
});

test("an unpaid overdue linked occurrence does not erase the debt minimum", () => {
  const state = emptyState({
    payments: [{ id: "pmt-loan", name: "Loan draft", amount_cents: 1_000, due_day: 15, recurrence: "Monthly" }],
    bill_occurrences: [{
      payment_id: "pmt-loan", due_date: "2027-01-15", original_due_date: "2027-01-15", paid: false,
    }],
    liabilities: [{
      id: "loan-1", name: "Loan", balance_cents: 8_000, apr_basis_points: 0,
      min_payment_cents: 3_000, due_day_of_month: 15, linked_payment_id: "pmt-loan",
    }],
  });
  const scenario = buildScenarioFromLedger(state, "2027-01-20", 10);
  assert.deepEqual(scenario.events.map((event: any) => [event.date, event.amount_cents]), [["2027-01-20", -1_000], ["2027-01-20", -2_000]]);
});

test("a paid linked occurrence uses its transaction amount and does not reduce principal twice", () => {
  const state = emptyState({
    payments: [{ id: "pmt-loan", name: "Loan draft", amount_cents: 1_000, due_day: 15, recurrence: "Monthly" }],
    transactions: [{ id: "tx-paid", amount_cents: -1_000, type: "Expense", date: "2027-01-15" }],
    bill_occurrences: [{ payment_id: "pmt-loan", due_date: "2027-01-15", paid: true, transaction_id: "tx-paid" }],
    liabilities: [{ id: "loan-1", name: "Loan", balance_cents: 8_000, apr_basis_points: 0, min_payment_cents: 3_000, due_day_of_month: 15, linked_payment_id: "pmt-loan" }],
  });
  const scenario = buildScenarioFromLedger(state, "2027-01-01", 30);
  assert.deepEqual(scenario.events.map((event: any) => [event.date, event.amount_cents]), [["2027-01-15", -1_000], ["2027-01-15", -2_000]]);
});

test("a moved unpaid linked occurrence covers its original slot", () => {
  const state = emptyState({
    payments: [{ id: "pmt-loan", name: "Loan draft", amount_cents: 3_000, due_day: 15, recurrence: "Monthly" }],
    bill_occurrences: [{ payment_id: "pmt-loan", due_date: "2027-01-25", original_due_date: "2027-01-15", is_user_modified: true, paid: false }],
    liabilities: [{ id: "loan-1", name: "Loan", balance_cents: 8_000, apr_basis_points: 0, min_payment_cents: 3_000, due_day_of_month: 15, linked_payment_id: "pmt-loan" }],
  });
  const scenario = buildScenarioFromLedger(state, "2027-01-01", 30);
  assert.deepEqual(scenario.events.map((event: any) => [event.date, event.amount_cents]), [["2027-01-25", -3_000]]);
});

test("programmatic callers reject duplicate linked payment ownership", () => {
  const state = emptyState({
    payments: [{ id: "pmt-loan", name: "Loan draft", amount_cents: 3_000, due_day: 15, recurrence: "Monthly" }],
    liabilities: [
      { id: "loan-1", name: "Loan", balance_cents: 8_000, apr_basis_points: 0, min_payment_cents: 3_000, linked_payment_id: "pmt-loan" },
      { id: "loan-2", name: "Loan copy", balance_cents: 8_000, apr_basis_points: 0, min_payment_cents: 3_000, linked_payment_id: "pmt-loan" },
    ],
  });
  assert.throws(() => buildScenarioFromLedger(state, "2027-01-01", 30), /multiple liabilities/);
});

test("Unicode payment names use the same lowercase matching rule as Python", () => {
  const state = emptyState({
    payments: [
      {
        id: "pmt-1",
        name: "STRASSE",
        amount_cents: 1_000,
        due_day: 15,
        recurrence: "Monthly",
      },
    ],
    liabilities: [
      {
        id: "loan-1",
        name: "Straße",
        balance_cents: 8_000,
        apr_basis_points: 0,
        min_payment_cents: 1_000,
        due_day_of_month: 15,
      },
    ],
  });
  const scenario = buildScenarioFromLedger(state, "2027-01-01", 30);
  assert.deepEqual(
    scenario.events.map((event: any) => [event.name, event.amount_cents]),
    [["STRASSE", -1_000], ["Straße", -1_000]]
  );
});

test("same-day debt expenses use stable ID order for seeded risk", () => {
  const base = emptyState({
    current_balance_cents: 500_000,
    transactions: [
      {
        id: "opening",
        amount_cents: 500_000,
        category: "System",
        type: "Adjustment",
        date: "2026-10-01",
        description: "Opening balance",
      },
    ],
  });
  const debts = [
    {
      id: "debt-z",
      name: "Z Loan",
      balance_cents: 100_000,
      apr_basis_points: 0,
      min_payment_cents: 12_000,
      due_day_of_month: 15,
    },
    {
      id: "debt-a",
      name: "A Loan",
      balance_cents: 100_000,
      apr_basis_points: 0,
      min_payment_cents: 8_000,
      due_day_of_month: 15,
    },
  ];
  const simulation = {
    runs: 100,
    seed: 7,
    quantile_num: 1,
    quantile_den: 10,
    income_variation_min: 0,
    income_variation_max: 0,
    expense_variation_min: -20,
    expense_variation_max: 20,
    surprise_probability_ppm: 0,
    surprise_amount_min: 0,
    surprise_amount_max: 0,
    surprise_check_interval_days: 14,
    reserve_cents: 0,
  };
  const forward = buildScenarioFromLedger(
    { ...base, liabilities: debts },
    "2026-11-01",
    30,
    simulation
  );
  const reversed = buildScenarioFromLedger(
    { ...base, liabilities: [...debts].reverse() },
    "2026-11-01",
    30,
    simulation
  );
  assert.deepEqual(
    forward.events.map((event: any) => event.name),
    ["A Loan", "Z Loan"]
  );
  assert.deepEqual(reversed.events, forward.events);
  assert.deepEqual(runScenario(reversed).risk, runScenario(forward).risk);
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
