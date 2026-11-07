import assert from "node:assert/strict";
import test from "node:test";

import { LedgerState } from "../types";
import { parseLedgerState } from "../validate";
import { buildScenarioFromLedger } from "../scenario-builder";
import { computeOverdueObligations } from "../overdue";

const AS_OF = "2026-11-01";

function base(overrides: Partial<LedgerState> = {}): LedgerState {
  return {
    version: "2.1",
    updated_at: "2026-11-01T00:00:00Z",
    current_balance_cents: 500000,
    incomes: [],
    payments: [
      { id: "p1", name: "Rent", amount_cents: 50000, recurrence: "Monthly", due_day: 1, is_auto_withdraw: true },
      { id: "p2", name: "Other", amount_cents: 10000, recurrence: "One-time", due_date: "2026-11-02", is_auto_withdraw: true },
    ],
    transactions: [
      { id: "t0", amount_cents: 500000, category: "Opening", type: "Adjustment", date: "2026-09-01", description: "open" },
    ],
    bill_occurrences: [],
    liabilities: [],
    ...overrides,
  };
}

function parse(state: any) {
  const result = parseLedgerState(state);
  assert.equal(result.ok, true, result.ok ? "" : result.error);
  return (result as any).state as LedgerState;
}

function expenses(scenario: any) {
  return scenario.events.filter((e: any) => e.type === "expense");
}

test("a moved bill is projected once at the moved date", () => {
  const state = parse(base({
    bill_occurrences: [
      { id: "o1", payment_id: "p1", due_date: "2026-11-05", paid: false,
        original_due_date: "2026-11-01", is_user_modified: true },
    ],
  }));
  const scenario = buildScenarioFromLedger(state, AS_OF, 30);
  assert.deepEqual(expenses(scenario).filter((e: any) => e.name === "Rent").map((e: any) => e.date), ["2026-11-05"]);
});

test("the month after a move keeps the original recurrence anchor", () => {
  const state = parse(base({
    bill_occurrences: [
      { id: "o1", payment_id: "p1", due_date: "2026-11-05", paid: false,
        original_due_date: "2026-11-01", is_user_modified: true },
    ],
  }));
  const scenario = buildScenarioFromLedger(state, AS_OF, 60);
  assert.deepEqual(expenses(scenario).filter((e: any) => e.name === "Rent").map((e: any) => e.date), ["2026-11-05", "2026-12-01"]);
});

test("a bill moved outside the horizon is not projected", () => {
  const state = parse(base({
    bill_occurrences: [
      { id: "o1", payment_id: "p1", due_date: "2027-01-15", paid: false,
        original_due_date: "2026-11-01", is_user_modified: true },
    ],
  }));
  const scenario = buildScenarioFromLedger(state, AS_OF, 30);
  assert.deepEqual(expenses(scenario).filter((e: any) => e.name === "Rent"), []);
});

test("a bill paid after being moved is excluded", () => {
  const state = parse(base({
    bill_occurrences: [
      { id: "o1", payment_id: "p1", due_date: "2026-11-05", paid: true,
        original_due_date: "2026-11-01", is_user_modified: true },
    ],
  }));
  const scenario = buildScenarioFromLedger(state, AS_OF, 30);
  assert.deepEqual(expenses(scenario).filter((e: any) => e.name === "Rent"), []);
});

test("a skipped bill does not reappear", () => {
  const state = parse(base({
    bill_occurrences: [
      { id: "o1", payment_id: "p1", due_date: "2026-11-01", paid: true },
    ],
  }));
  const scenario = buildScenarioFromLedger(state, AS_OF, 30);
  assert.deepEqual(expenses(scenario).filter((e: any) => e.name === "Rent"), []);
});

test("same-name bills with different ids are independent", () => {
  const state = parse(base({
    payments: [
      { id: "a", name: "Utilities", amount_cents: 1000, recurrence: "One-time", due_date: "2026-11-03", is_auto_withdraw: true },
      { id: "b", name: "Utilities", amount_cents: 2000, recurrence: "One-time", due_date: "2026-11-04", is_auto_withdraw: true },
    ],
  }));
  const scenario = buildScenarioFromLedger(state, AS_OF, 30);
  assert.deepEqual(expenses(scenario).map((e: any) => e.amount_cents).sort((a: number, b: number) => a - b), [-2000, -1000]);
});

test("future-dated transactions are events, not opening cash", () => {
  const state = parse(base({
    current_balance_cents: 460000,
    payments: [],
    transactions: [
      { id: "t0", amount_cents: 500000, category: "Opening", type: "Adjustment", date: "2026-09-01", description: "open" },
      { id: "t1", amount_cents: -40000, category: "Future", type: "Expense", date: "2026-11-15", description: "future" },
    ],
  }));
  const scenario = buildScenarioFromLedger(state, AS_OF, 30);
  assert.equal(scenario.starting_balance_cents, 500000);
  const future = scenario.events.filter((e: any) => e.date === "2026-11-15");
  assert.deepEqual(future, [{ date: "2026-11-15", amount_cents: -40000, type: "expense", name: "future" }]);
});

test("overdue obligations are reported but not projected", () => {
  const state = parse(base({
    payments: [
      { id: "p1", name: "Past", amount_cents: 25000, recurrence: "One-time", due_date: "2026-10-15", is_auto_withdraw: true },
    ],
    bill_occurrences: [
      { id: "o1", payment_id: "p1", due_date: "2026-10-15", paid: false },
    ],
  }));
  assert.deepEqual(computeOverdueObligations(state, AS_OF), {
    count: 1, total_cents: 25000, earliest_date: "2026-10-15",
  });
  const scenario = buildScenarioFromLedger(state, AS_OF, 30);
  assert.deepEqual(expenses(scenario), []);
});

test("snapshot rejects one transaction paying two bills", () => {
  const state = base({
    payments: [
      { id: "p1", name: "A", amount_cents: 10000, recurrence: "One-time", due_date: "2026-11-01", is_auto_withdraw: true },
      { id: "p2", name: "B", amount_cents: 10000, recurrence: "One-time", due_date: "2026-11-02", is_auto_withdraw: true },
    ],
    current_balance_cents: -10000,
    transactions: [
      { id: "t1", amount_cents: -10000, category: "Bills", type: "Expense", date: "2026-10-01", description: "paid" },
    ],
    bill_occurrences: [
      { id: "o1", payment_id: "p1", due_date: "2026-11-01", paid: true, transaction_id: "t1" },
      { id: "o2", payment_id: "p2", due_date: "2026-11-02", paid: true, transaction_id: "t1" },
    ],
  });
  const result = parseLedgerState(state);
  assert.equal(result.ok, false);
  assert.match((result as any).error, /reuses a transaction/);
});

test("snapshot rejects a non-expense or mismatched settlement", () => {
  const income = base({
    payments: [{ id: "p1", name: "A", amount_cents: 10000, recurrence: "One-time", due_date: "2026-11-01", is_auto_withdraw: true }],
    current_balance_cents: 10000,
    transactions: [{ id: "t1", amount_cents: 10000, category: "Pay", type: "Income", date: "2026-10-01", description: "pay" }],
    bill_occurrences: [{ id: "o1", payment_id: "p1", due_date: "2026-11-01", paid: true, transaction_id: "t1" }],
  });
  let result = parseLedgerState(income);
  assert.equal(result.ok, false);
  assert.match((result as any).error, /Expense transaction/);

  const mismatch = base({
    payments: [{ id: "p1", name: "A", amount_cents: 10000, recurrence: "One-time", due_date: "2026-11-01", is_auto_withdraw: true }],
    current_balance_cents: -9999,
    transactions: [{ id: "t1", amount_cents: -9999, category: "Bills", type: "Expense", date: "2026-10-01", description: "paid" }],
    bill_occurrences: [{ id: "o1", payment_id: "p1", due_date: "2026-11-01", paid: true, transaction_id: "t1" }],
  });
  result = parseLedgerState(mismatch);
  assert.equal(result.ok, false);
  assert.match((result as any).error, /does not match the bill amount/);
});

test("snapshot enforces transaction sign rules", () => {
  for (const [type, amount, pattern] of [
    ["Income", -1, /Income must be positive/],
    ["Expense", 1, /Expense must be negative/],
    ["Adjustment", 0, /Adjustment must be non-zero/],
  ] as const) {
    const state = base({
      payments: [],
      bill_occurrences: [],
      transactions: [{ id: "t1", amount_cents: amount, category: "x", type, date: "2026-10-01", description: "x" }],
      current_balance_cents: amount,
    });
    const result = parseLedgerState(state);
    assert.equal(result.ok, false);
    assert.match((result as any).error, pattern);
  }
});

test("moved-occurrence fields survive parsing", () => {
  const state = parse(base({
    bill_occurrences: [
      { id: "o1", payment_id: "p1", due_date: "2026-11-05", paid: false,
        original_due_date: "2026-11-01", is_user_modified: true },
    ],
  }));
  assert.equal(state.bill_occurrences[0].original_due_date, "2026-11-01");
  assert.equal(state.bill_occurrences[0].is_user_modified, true);
});
