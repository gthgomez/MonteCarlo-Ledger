import assert from "node:assert/strict";
import test from "node:test";

import {
  addBill,
  addIncomeSchedule,
  addInstallmentDebt,
  aprPercentToBasisPoints,
  createStarterLedger,
  deleteCashTransaction,
  dollarsToCents,
  editCashTransaction,
  linkPostedExpenseToPastOneTimeBill,
  markBillOccurrencePaid,
  markPastOneTimeBillPaidWithoutExpense,
  moveBillOccurrence,
  parseDollarsToCents,
  postedExpenseMatchesForPastOneTimeBill,
  reconcileBalance,
  recordCashflow,
  removePayment,
} from "../ledger-edits";
import { SAMPLE_LEDGER_STATE, type LedgerState } from "../types";
import { transactionSumCents } from "../present";
import { unresolvedPastOneTimeSlots } from "../scenario-builder";
import { formatDollarsInput } from "../money-format";

test("dollar entry becomes integer cents", () => {
  assert.equal(dollarsToCents(45.2), 4520);
  assert.equal(dollarsToCents(Number.NaN), null);
});

test("exact dollar entry rejects fractions of a cent and unsafe totals", () => {
  assert.equal(parseDollarsToCents("150.2"), 15_020);
  assert.equal(parseDollarsToCents("0.01"), 1);
  assert.equal(parseDollarsToCents(".50"), 50);
  assert.equal(parseDollarsToCents("90071992547409.91"), Number.MAX_SAFE_INTEGER);
  const cents = Number.MAX_SAFE_INTEGER - 1;
  assert.equal(formatDollarsInput(cents), "90071992547409.90");
  assert.equal(parseDollarsToCents(formatDollarsInput(cents)), cents);
  assert.equal(parseDollarsToCents("-.50", { allowNegative: true }), -50);
  for (const invalid of ["", "-0.50", "0.005", "1e2", "90071992547409.92"]) {
    assert.equal(parseDollarsToCents(invalid), null);
  }
});

test("APR text becomes basis points without binary float drift", () => {
  assert.equal(aprPercentToBasisPoints("21.99"), 2199);
  assert.equal(aprPercentToBasisPoints("5.9"), 590);
  assert.equal(aprPercentToBasisPoints("5"), 500);
  assert.equal(aprPercentToBasisPoints("21.999"), null);
});

test("starter ledger balance is the opening adjustment", () => {
  const created = createStarterLedger({
    asOf: "2026-11-10",
    balanceCents: 125_000,
    income: {
      name: "Job",
      amountCents: 200_000,
      frequency: "Monthly",
      nextPayday: "2026-11-15",
    },
    bill: { name: "Rent", amountCents: 90_000, dueDay: 1 },
  });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.state.current_balance_cents, 125_000);
  assert.equal(transactionSumCents(created.state.transactions), 125_000);
  assert.equal(created.state.transactions[0].date, "2026-11-10");
  assert.equal(created.state.transactions[0].type, "Adjustment");
  assert.equal(created.state.payments[0].is_auto_withdraw, false);
});

test("a zero opening balance does not invent a zero adjustment", () => {
  const created = createStarterLedger({ asOf: "2026-11-10", balanceCents: 0 });
  assert.equal(created.ok, true);
  if (!created.ok) return;
  assert.equal(created.state.transactions.length, 0);
  assert.equal(created.state.current_balance_cents, 0);
});

test("recording an expense keeps the balance equal to the transactions", () => {
  const before = structuredClone(SAMPLE_LEDGER_STATE);
  const result = recordCashflow(SAMPLE_LEDGER_STATE, {
    date: "2026-11-10",
    kind: "Expense",
    amountCents: 1_850,
    category: "Groceries",
    description: "Market",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.current_balance_cents, SAMPLE_LEDGER_STATE.current_balance_cents - 1_850);
  assert.equal(transactionSumCents(result.state.transactions), result.state.current_balance_cents);
  assert.equal(result.state.transactions.at(-1)?.category, "Groceries");
  assert.deepEqual(SAMPLE_LEDGER_STATE, before);
});

test("reconciliation uses the provided calendar day and rejects a matching balance", () => {
  const same = reconcileBalance(SAMPLE_LEDGER_STATE, SAMPLE_LEDGER_STATE.current_balance_cents, "2026-11-10");
  assert.equal(same.ok, false);
  const changed = reconcileBalance(SAMPLE_LEDGER_STATE, SAMPLE_LEDGER_STATE.current_balance_cents + 500, "2026-11-10");
  assert.equal(changed.ok, true);
  if (!changed.ok) return;
  const tx = changed.state.transactions.at(-1);
  assert.equal(tx?.date, "2026-11-10");
  assert.equal(tx?.amount_cents, 500);
  assert.equal(tx?.type, "Adjustment");
  assert.equal(transactionSumCents(changed.state.transactions), changed.state.current_balance_cents);
});

test("a monthly bill without a due day is rejected", () => {
  const result = addBill(SAMPLE_LEDGER_STATE, {
    name: "Gym",
    amountCents: 4_500,
    recurrence: "Monthly",
    dueDay: 0,
    autoWithdraw: false,
  });
  assert.equal(result.ok, false);
});

test("removing a bill drops its occurrences and leaves the original ledger alone", () => {
  const before = structuredClone(SAMPLE_LEDGER_STATE);
  const result = removePayment(SAMPLE_LEDGER_STATE, "pmt-2");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.payments.some((payment) => payment.id === "pmt-2"), false);
  assert.equal(result.state.bill_occurrences.some((row) => row.payment_id === "pmt-2"), false);
  assert.deepEqual(SAMPLE_LEDGER_STATE, before);
});

function occurrenceState(): LedgerState {
  return {
    version: "2.0" as const,
    updated_at: "2027-01-01T00:00:00.000Z",
    current_balance_cents: 10_000,
    incomes: [],
    payments: [{ id: "pmt-1", name: "Rent", amount_cents: 2_000, due_day: 15, recurrence: "Monthly" as const }],
    transactions: [{ id: "open", amount_cents: 10_000, type: "Adjustment" as const, date: "2027-01-01" }],
    bill_occurrences: [],
    liabilities: [],
  };
}

test("reconciling current cash preserves a future payment", () => {
  const state = occurrenceState();
  state.transactions.push({
    id: "future", amount_cents: -2_000, type: "Expense", date: "2027-02-15",
  });
  state.current_balance_cents -= 2_000;
  const result = reconcileBalance(state, 9_000, "2027-01-20");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.current_balance_cents, 7_000);
  assert.equal(result.state.transactions.at(-1)?.amount_cents, -1_000);
  assert.equal(result.state.transactions.find((tx) => tx.id === "future")?.amount_cents, -2_000);
});

test("marking a bill occurrence paid creates one matching expense atomically", () => {
  const result = markBillOccurrencePaid(occurrenceState(), "pmt-1", "2027-01-15");
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.current_balance_cents, 8_000);
  assert.deepEqual(result.state.bill_occurrences[0], {
    id: "occ-1", payment_id: "pmt-1", due_date: "2027-01-15", paid: true,
    transaction_id: "tx-2", original_due_date: "2027-01-15", is_user_modified: false,
  });
  assert.equal(result.state.transactions.length, 2);
  assert.equal(result.state.transactions[1].amount_cents, -2_000);
});

test("retrying a paid occurrence is idempotent and does not double-post", () => {
  const first = markBillOccurrencePaid(occurrenceState(), "pmt-1", "2027-01-15");
  assert.equal(first.ok, true);
  if (!first.ok) return;
  const second = markBillOccurrencePaid(first.state, "pmt-1", "2027-01-15");
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.state.current_balance_cents, 8_000);
  assert.equal(second.state.transactions.length, 2);
});

test("moving a bill preserves its original slot and rejects collisions", () => {
  const initial = occurrenceState();
  initial.bill_occurrences = [{ id: "occ-1", payment_id: "pmt-1", due_date: "2027-01-15", paid: false }];
  const moved = moveBillOccurrence(initial, "pmt-1", "2027-01-15", "2027-01-22");
  assert.equal(moved.ok, true);
  if (!moved.ok) return;
  assert.equal(moved.state.bill_occurrences[0].due_date, "2027-01-22");
  assert.equal(moved.state.bill_occurrences[0].original_due_date, "2027-01-15");
  assert.equal(moved.state.bill_occurrences[0].is_user_modified, true);
  const withCollision = {
    ...moved.state,
    bill_occurrences: [...moved.state.bill_occurrences, {
      id: "occ-2", payment_id: "pmt-1", due_date: "2027-02-15", paid: false,
    }],
  };
  const collision = moveBillOccurrence(withCollision, "pmt-1", "2027-02-15", "2027-01-22");
  assert.equal(collision.ok, false);
  const generatedCollision = moveBillOccurrence(initial, "pmt-1", "2027-01-15", "2027-02-15");
  assert.equal(generatedCollision.ok, false);
});

test("bill occurrence actions reject invalid dates and moving paid rows", () => {
  const invalid = markBillOccurrencePaid(occurrenceState(), "pmt-1", "2027-02-30");
  assert.equal(invalid.ok, false);
  const paid = markBillOccurrencePaid(occurrenceState(), "pmt-1", "2027-01-15");
  assert.equal(paid.ok, true);
  if (!paid.ok) return;
  const moved = moveBillOccurrence(paid.state, "pmt-1", "2027-01-15", "2027-01-22");
  assert.equal(moved.ok, false);
});

test("income and installment debt can be added without breaking validation", () => {
  const income = addIncomeSchedule(SAMPLE_LEDGER_STATE, {
    name: "Side gig",
    amountCents: 30_000,
    frequency: "Monthly",
    nextPayday: "2026-11-20",
  });
  assert.equal(income.ok, true);
  const debt = addInstallmentDebt(SAMPLE_LEDGER_STATE, {
    name: "Card",
    balanceCents: 10_000,
    aprBasisPoints: 1_999,
    minPaymentCents: 2_500,
  });
  assert.equal(debt.ok, true);
});

const AS_OF = "2026-11-10";

/**
 * $1,900 opening cash and an already-posted $900 repair expense leave $1,000.
 * The one-time bill slot is unresolved because no occurrence links that expense.
 */
function pastOneTimeState(): LedgerState {
  return {
    version: "2.0",
    updated_at: "2026-11-10T12:00:00.000Z",
    current_balance_cents: 100_000,
    incomes: [],
    payments: [
      { id: "repair", name: "Car repair", amount_cents: 90_000, recurrence: "One-time", due_date: "2026-11-09" },
      { id: "subscription", name: "Subscription", amount_cents: 1_000, recurrence: "Monthly", due_day: 15 },
    ],
    transactions: [
      { id: "tx-open", amount_cents: 190_000, type: "Adjustment", date: "2026-11-01", description: "Opening balance" },
      { id: "tx-repair", amount_cents: -90_000, type: "Expense", category: "Bills", date: "2026-11-08", description: "Car repair" },
    ],
    bill_occurrences: [],
    liabilities: [],
  };
}

test("a posted expense matching a past one-time bill can be linked without a new debit", () => {
  const state = pastOneTimeState();
  const before = structuredClone(state);
  const matches = postedExpenseMatchesForPastOneTimeBill(state, "repair", "2026-11-09", AS_OF);
  assert.deepEqual(
    matches.map((match) => [match.id, match.amountCents, match.date]),
    [["tx-repair", 90_000, "2026-11-08"]]
  );

  const linked = linkPostedExpenseToPastOneTimeBill(state, "repair", "2026-11-09", "tx-repair", AS_OF);
  assert.equal(linked.ok, true);
  if (!linked.ok) return;
  // $1,000 cash stays $1,000: only the occurrence link was added.
  assert.equal(linked.state.current_balance_cents, 100_000);
  assert.equal(linked.state.transactions.length, 2);
  assert.deepEqual(linked.state.transactions, before.transactions);
  assert.deepEqual(linked.state.bill_occurrences, [{
    id: "occ-1",
    payment_id: "repair",
    due_date: "2026-11-09",
    paid: true,
    transaction_id: "tx-repair",
    original_due_date: "2026-11-09",
    is_user_modified: false,
  }]);
  assert.deepEqual(unresolvedPastOneTimeSlots(linked.state, AS_OF), []);
  assert.equal(transactionSumCents(linked.state.transactions), linked.state.current_balance_cents);
  // The pure action did not mutate its input.
  assert.deepEqual(state, before);

  const retry = linkPostedExpenseToPastOneTimeBill(linked.state, "repair", "2026-11-09", "tx-repair", AS_OF);
  assert.equal(retry.ok, false);
  assert.equal(linked.state.bill_occurrences.length, 1);
});

test("linking rejects expenses with the wrong type, sign, amount, date, or id", () => {
  const future = pastOneTimeState();
  future.transactions.push({
    id: "tx-future", amount_cents: -90_000, type: "Expense", date: "2026-11-11", description: "Future repair",
  });
  future.current_balance_cents = 10_000;
  assert.deepEqual(
    postedExpenseMatchesForPastOneTimeBill(future, "repair", "2026-11-09", AS_OF).map((match) => match.id),
    ["tx-repair"]
  );

  const wrongAmount = pastOneTimeState();
  wrongAmount.transactions = [
    { id: "tx-open", amount_cents: 189_999, type: "Adjustment", date: "2026-11-01" },
    { id: "tx-close", amount_cents: -89_999, type: "Expense", date: "2026-11-08", description: "Almost" },
  ];
  wrongAmount.current_balance_cents = 100_000;
  assert.deepEqual(postedExpenseMatchesForPastOneTimeBill(wrongAmount, "repair", "2026-11-09", AS_OF), []);

  const income = pastOneTimeState();
  income.transactions = [
    { id: "tx-open", amount_cents: 190_000, type: "Adjustment", date: "2026-11-01" },
    { id: "tx-income", amount_cents: 90_000, type: "Income", date: "2026-11-08", description: "Refund" },
  ];
  income.current_balance_cents = 280_000;
  assert.deepEqual(postedExpenseMatchesForPastOneTimeBill(income, "repair", "2026-11-09", AS_OF), []);

  const adjustment = pastOneTimeState();
  adjustment.transactions = [
    { id: "tx-open", amount_cents: 190_000, type: "Adjustment", date: "2026-11-01" },
    { id: "tx-adj", amount_cents: -90_000, type: "Adjustment", date: "2026-11-08" },
  ];
  adjustment.current_balance_cents = 100_000;
  assert.deepEqual(postedExpenseMatchesForPastOneTimeBill(adjustment, "repair", "2026-11-09", AS_OF), []);

  const missingId = pastOneTimeState();
  missingId.transactions = [
    { id: "tx-open", amount_cents: 190_000, type: "Adjustment", date: "2026-11-01" },
    { id: undefined, amount_cents: -90_000, type: "Expense", date: "2026-11-08" },
  ];
  missingId.current_balance_cents = 100_000;
  assert.deepEqual(postedExpenseMatchesForPastOneTimeBill(missingId, "repair", "2026-11-09", AS_OF), []);

  const badDate = pastOneTimeState();
  badDate.transactions[1].date = "2026-11-31";
  assert.deepEqual(postedExpenseMatchesForPastOneTimeBill(badDate, "repair", "2026-11-09", AS_OF), []);

  for (const candidate of ["tx-future", "tx-close", "tx-income", "missing", ""]) {
    const result = linkPostedExpenseToPastOneTimeBill(pastOneTimeState(), "repair", "2026-11-09", candidate, AS_OF);
    assert.equal(result.ok, false, `expected ${candidate} to be rejected`);
  }
  const unknownBill = linkPostedExpenseToPastOneTimeBill(pastOneTimeState(), "gone", "2026-11-09", "tx-repair", AS_OF);
  assert.equal(unknownBill.ok, false);
  const recurring = linkPostedExpenseToPastOneTimeBill(pastOneTimeState(), "subscription", "2026-11-09", "tx-repair", AS_OF);
  assert.equal(recurring.ok, false);
  const notPastDue = linkPostedExpenseToPastOneTimeBill(pastOneTimeState(), "repair", "2026-11-09", "tx-repair", "2026-11-09");
  assert.equal(notPastDue.ok, false);
});

test("linking rejects an expense already used by another bill occurrence", () => {
  const state = pastOneTimeState();
  state.payments.push({
    id: "other-repair", name: "Other repair", amount_cents: 90_000, recurrence: "One-time", due_date: "2026-11-07",
  });
  state.bill_occurrences = [{
    id: "occ-other", payment_id: "other-repair", due_date: "2026-11-07", paid: true, transaction_id: "tx-repair",
  }];
  assert.deepEqual(postedExpenseMatchesForPastOneTimeBill(state, "repair", "2026-11-09", AS_OF), []);
  const before = structuredClone(state);
  const result = linkPostedExpenseToPastOneTimeBill(state, "repair", "2026-11-09", "tx-repair", AS_OF);
  assert.equal(result.ok, false);
  assert.deepEqual(state, before);
});

test("paid or moved one-time slots and future or missing slots cannot link", () => {
  const paid = pastOneTimeState();
  paid.bill_occurrences = [{ id: "occ-paid", payment_id: "repair", due_date: "2026-11-09", paid: true }];
  assert.deepEqual(postedExpenseMatchesForPastOneTimeBill(paid, "repair", "2026-11-09", AS_OF), []);
  assert.equal(linkPostedExpenseToPastOneTimeBill(paid, "repair", "2026-11-09", "tx-repair", AS_OF).ok, false);

  const moved = pastOneTimeState();
  moved.bill_occurrences = [{
    id: "occ-moved",
    payment_id: "repair",
    due_date: "2026-11-12",
    original_due_date: "2026-11-09",
    paid: false,
    is_user_modified: true,
  }];
  assert.deepEqual(postedExpenseMatchesForPastOneTimeBill(moved, "repair", "2026-11-09", AS_OF), []);
  assert.equal(linkPostedExpenseToPastOneTimeBill(moved, "repair", "2026-11-09", "tx-repair", AS_OF).ok, false);

  const future = pastOneTimeState();
  future.payments[0].due_date = "2026-11-20";
  assert.deepEqual(postedExpenseMatchesForPastOneTimeBill(future, "repair", "2026-11-20", AS_OF), []);
  assert.equal(linkPostedExpenseToPastOneTimeBill(future, "repair", "2026-11-20", "tx-repair", AS_OF).ok, false);
});

test("a payment already reflected in starting cash is marked paid without a new expense", () => {
  const state = pastOneTimeState();
  state.current_balance_cents = 100_000;
  state.transactions = [{
    id: "tx-open", amount_cents: 100_000, type: "Adjustment", date: "2026-11-01",
    description: "Opening balance",
  }];
  const before = structuredClone(state);

  const result = markPastOneTimeBillPaidWithoutExpense(state, "repair", "2026-11-09", AS_OF);
  assert.equal(result.ok, true);
  if (!result.ok) return;

  // Only the paid occurrence changed: cash, transactions, ids, and their dates do not.
  assert.equal(result.state.current_balance_cents, 100_000);
  assert.deepEqual(result.state.transactions, before.transactions);
  assert.deepEqual(result.state.bill_occurrences, [{
    id: "occ-1",
    payment_id: "repair",
    due_date: "2026-11-09",
    paid: true,
    transaction_id: null,
    original_due_date: "2026-11-09",
    is_user_modified: false,
  }]);
  assert.equal(result.state.bill_occurrences[0].transaction_id, null);
  assert.deepEqual(unresolvedPastOneTimeSlots(result.state, AS_OF), []);
  assert.equal(transactionSumCents(result.state.transactions), result.state.current_balance_cents);
  assert.deepEqual(
    { ...result.state, bill_occurrences: before.bill_occurrences, updated_at: before.updated_at },
    before
  );
  // The pure action did not mutate its input.
  assert.deepEqual(state, before);

  // A retry recognises the same reflected slot and posts nothing again.
  const retry = markPastOneTimeBillPaidWithoutExpense(result.state, "repair", "2026-11-09", AS_OF);
  assert.equal(retry.ok, true);
  if (!retry.ok) return;
  assert.equal(retry.state.current_balance_cents, 100_000);
  assert.equal(retry.state.transactions.length, 1);
  assert.equal(retry.state.bill_occurrences.length, 1);
  assert.deepEqual(retry.state.transactions, before.transactions);
});

test("marking a payment reflected fails closed outside unresolved past one-time slots", () => {
  const state = pastOneTimeState();
  state.current_balance_cents = 100_000;
  state.transactions = [{
    id: "tx-open", amount_cents: 100_000, type: "Adjustment", date: "2026-11-01",
    description: "Opening balance",
  }];
  const before = structuredClone(state);

  assert.equal(markPastOneTimeBillPaidWithoutExpense(state, "repair", "2026-02-30", AS_OF).ok, false);
  assert.equal(markPastOneTimeBillPaidWithoutExpense(state, "gone", "2026-11-09", AS_OF).ok, false);
  assert.equal(markPastOneTimeBillPaidWithoutExpense(state, "subscription", "2026-11-09", AS_OF).ok, false);
  assert.equal(markPastOneTimeBillPaidWithoutExpense(state, "repair", "2026-11-08", AS_OF).ok, false);
  assert.equal(markPastOneTimeBillPaidWithoutExpense(state, "repair", "2026-11-09", "2026-11-09").ok, false);

  const moved = structuredClone(state);
  moved.bill_occurrences = [{
    id: "occ-moved",
    payment_id: "repair",
    due_date: "2026-11-12",
    original_due_date: "2026-11-09",
    paid: false,
    is_user_modified: true,
  }];
  assert.equal(markPastOneTimeBillPaidWithoutExpense(moved, "repair", "2026-11-09", AS_OF).ok, false);

  const linked = structuredClone(state);
  linked.bill_occurrences = [{
    id: "occ-linked",
    payment_id: "repair",
    due_date: "2026-11-09",
    paid: true,
    transaction_id: "tx-old",
    original_due_date: "2026-11-09",
    is_user_modified: false,
  }];
  assert.equal(markPastOneTimeBillPaidWithoutExpense(linked, "repair", "2026-11-09", AS_OF).ok, false);

  const unpaid = structuredClone(state);
  unpaid.bill_occurrences = [{
    id: "occ-unpaid",
    payment_id: "repair",
    due_date: "2026-11-09",
    paid: false,
    original_due_date: "2026-11-09",
    is_user_modified: false,
  }];
  assert.equal(markPastOneTimeBillPaidWithoutExpense(unpaid, "repair", "2026-11-09", AS_OF).ok, false);

  // Every rejected attempt left its input ledger untouched.
  assert.deepEqual(state, before);
  assert.deepEqual(moved.bill_occurrences[0], {
    id: "occ-moved",
    payment_id: "repair",
    due_date: "2026-11-12",
    original_due_date: "2026-11-09",
    paid: false,
    is_user_modified: true,
  });
  assert.deepEqual(linked.bill_occurrences[0], {
    id: "occ-linked",
    payment_id: "repair",
    due_date: "2026-11-09",
    paid: true,
    transaction_id: "tx-old",
    original_due_date: "2026-11-09",
    is_user_modified: false,
  });
});

test("numeric ids stay numeric and links remain unique", () => {
  const state = pastOneTimeState();
  state.payments[0].id = 7;
  state.payments[1].id = 8;
  state.transactions[1].id = 42;
  const matches = postedExpenseMatchesForPastOneTimeBill(state, 7, "2026-11-09", AS_OF);
  assert.deepEqual(matches.map((match) => match.id), [42]);
  const linked = linkPostedExpenseToPastOneTimeBill(state, 7, "2026-11-09", "42", AS_OF);
  assert.equal(linked.ok, true);
  if (!linked.ok) return;
  const occurrence = linked.state.bill_occurrences[0];
  assert.equal(occurrence.payment_id, 7);
  assert.equal(occurrence.transaction_id, 42);
  assert.equal(typeof occurrence.transaction_id, "number");
  assert.equal(linked.state.current_balance_cents, 100_000);
  assert.equal(linked.state.transactions.length, 2);
});

/** $1,000 opening, a $500 repair already spent, and a future $200 rent row. */
function cashHistoryState(): LedgerState {
  return {
    version: "2.0",
    updated_at: "2027-01-01T00:00:00.000Z",
    current_balance_cents: 30_000,
    incomes: [],
    payments: [],
    transactions: [
      { id: "tx-open", amount_cents: 100_000, type: "Adjustment", date: "2027-01-01", category: "Adjustment", description: "Opening balance" },
      { id: "tx-repair", amount_cents: -50_000, type: "Expense", date: "2027-01-05", category: "Repairs", description: "Repair" },
      { id: "tx-future", amount_cents: -20_000, type: "Expense", date: "2027-02-01", category: "Rent", description: "Future rent" },
    ],
    bill_occurrences: [],
    liabilities: [],
  };
}

test("editing a $500 expense recomputes cash and leaves the future row alone", () => {
  const state = cashHistoryState();
  const before = structuredClone(state);
  const future = structuredClone(state.transactions[2]);

  const result = editCashTransaction(state, "tx-repair", {
    date: "2027-01-06",
    amountCents: 30_000,
    category: "Home",
    description: "Fixed sink",
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;

  const edited = result.state.transactions.find((tx) => tx.id === "tx-repair");
  assert.deepEqual(edited, {
    id: "tx-repair",
    amount_cents: -30_000,
    type: "Expense",
    date: "2027-01-06",
    category: "Home",
    description: "Fixed sink",
  });
  // Cash is rebuilt from every row, not adjusted by a delta.
  assert.equal(result.state.current_balance_cents, 50_000);
  assert.equal(transactionSumCents(result.state.transactions), result.state.current_balance_cents);
  // The scheduled row keeps its date, sign, and amount.
  assert.deepEqual(result.state.transactions.find((tx) => tx.id === "tx-future"), future);
  // The pure action did not mutate its input.
  assert.deepEqual(state, before);
});

test("editing keeps stable numeric ids, the stored kind, and whole-cent signs", () => {
  const state: LedgerState = {
    version: "2.0",
    updated_at: "2027-01-01T00:00:00.000Z",
    current_balance_cents: 60_000,
    incomes: [],
    payments: [],
    transactions: [
      { id: 1, amount_cents: 10_000, type: "Adjustment", date: "2027-01-01", category: "Adjustment" },
      { id: 42, amount_cents: -20_000, type: "Expense", date: "2027-01-02", category: "Food" },
      { id: "pay", amount_cents: 70_000, type: "Income", date: "2027-01-03", category: "Income" },
    ],
    bill_occurrences: [],
    liabilities: [],
  };

  // A string lookup finds the numeric row and keeps the id numeric.
  const expense = editCashTransaction(state, "42", {
    date: "2027-01-04",
    amountCents: 12_500,
    category: "Groceries",
    description: "Weekly shop",
  });
  assert.equal(expense.ok, true);
  if (!expense.ok) return;
  const expenseRow = expense.state.transactions.find((tx) => String(tx.id) === "42")!;
  assert.equal(expenseRow.id, 42);
  assert.equal(typeof expenseRow.id, "number");
  assert.equal(expenseRow.amount_cents, -12_500);
  assert.equal(expense.state.current_balance_cents, 67_500);
  assert.equal(transactionSumCents(expense.state.transactions), 67_500);

  // Income stays positive, and omitted metadata is preserved.
  const income = editCashTransaction(expense.state, "pay", { date: "2027-01-03", amountCents: 80_000 });
  assert.equal(income.ok, true);
  if (!income.ok) return;
  const incomeRow = income.state.transactions.find((tx) => tx.id === "pay")!;
  assert.equal(incomeRow.amount_cents, 80_000);
  assert.equal(incomeRow.category, "Income");
  assert.equal(incomeRow.description, undefined);
  assert.equal(income.state.current_balance_cents, 77_500);
  assert.equal(transactionSumCents(income.state.transactions), 77_500);

  // Deleting by the numeric identity removes only that row.
  const deleted = deleteCashTransaction(income.state, 42);
  assert.equal(deleted.ok, true);
  if (!deleted.ok) return;
  assert.equal(deleted.state.transactions.some((tx) => String(tx.id) === "42"), false);
  assert.equal(deleted.state.current_balance_cents, 90_000);
  assert.equal(transactionSumCents(deleted.state.transactions), 90_000);
});

test("Adjustment history and malformed identities are rejected explicitly", () => {
  const state = cashHistoryState();
  const before = structuredClone(state);

  const adjust = editCashTransaction(state, "tx-open", {
    date: "2027-01-02",
    amountCents: 99_000,
    category: "Opening",
    description: "Changed",
  });
  assert.equal(adjust.ok, false);
  if (!adjust.ok) assert.match(adjust.error, /Adjustment/);
  const adjustDelete = deleteCashTransaction(state, "tx-open");
  assert.equal(adjustDelete.ok, false);
  if (!adjustDelete.ok) assert.match(adjustDelete.error, /Adjustment/);

  const invalidEdits = [
    editCashTransaction(state, "tx-repair", { date: "2027-02-30", amountCents: 30_000 }),
    editCashTransaction(state, "tx-repair", { date: "2027-01-06", amountCents: 0 }),
    editCashTransaction(state, "tx-repair", { date: "2027-01-06", amountCents: -30_000 }),
    editCashTransaction(state, "tx-repair", { date: "2027-01-06", amountCents: 12.5 }),
    editCashTransaction(state, "tx-repair", { date: "2027-01-06", amountCents: Number.NaN }),
    editCashTransaction(state, "missing", { date: "2027-01-06", amountCents: 1_000 }),
    editCashTransaction(state, "", { date: "2027-01-06", amountCents: 1_000 }),
    editCashTransaction(state, 1.5, { date: "2027-01-06", amountCents: 1_000 }),
  ];
  for (const result of invalidEdits) assert.equal(result.ok, false);
  assert.equal(deleteCashTransaction(state, "missing").ok, false);
  assert.equal(deleteCashTransaction(state, "").ok, false);
  assert.equal(deleteCashTransaction(state, 1.5).ok, false);
  // Every rejection left the ledger untouched.
  assert.deepEqual(state, before);
});

/**
 * $1,000 opening cash and one paid $200 rent occurrence plus an open next
 * month. The paid row and its bill are linked bidirectionally.
 */
function linkedBillState(): LedgerState {
  return {
    version: "2.2",
    updated_at: "2027-01-01T00:00:00.000Z",
    current_balance_cents: 8_000,
    incomes: [],
    payments: [{ id: "pmt-1", name: "Rent", amount_cents: 2_000, due_day: 15, recurrence: "Monthly" }],
    transactions: [
      { id: "tx-open", amount_cents: 10_000, type: "Adjustment", date: "2027-01-01", category: "Adjustment" },
      { id: "tx-rent", amount_cents: -2_000, type: "Expense", date: "2027-01-15", category: "Bills", description: "Rent" },
    ],
    bill_occurrences: [
      {
        id: "occ-1", payment_id: "pmt-1", due_date: "2027-01-15", paid: true,
        transaction_id: "tx-rent", original_due_date: "2027-01-15", is_user_modified: false,
      },
      { id: "occ-next", payment_id: "pmt-1", due_date: "2027-02-15", paid: false },
    ],
    liabilities: [
      {
        id: "debt-card", name: "Card", balance_cents: 5_000, apr_basis_points: 1_999,
        min_payment_cents: 1_000, kind: "revolving", linked_payment_id: "pmt-1",
      },
    ],
  };
}

test("editing a bill-linked expense allows date and metadata but not its amount", () => {
  const state = linkedBillState();
  const before = structuredClone(state);
  const occurrence = structuredClone(state.bill_occurrences[0]);

  const edited = editCashTransaction(state, "tx-rent", {
    date: "2027-01-16",
    amountCents: 2_000,
    category: "Housing",
    description: "January rent",
  });
  assert.equal(edited.ok, true);
  if (!edited.ok) return;
  assert.equal(edited.state.current_balance_cents, 8_000);
  assert.deepEqual(edited.state.bill_occurrences[0], occurrence);
  assert.deepEqual(edited.state.liabilities, before.liabilities);
  const row = edited.state.transactions.find((tx) => tx.id === "tx-rent")!;
  assert.equal(row.amount_cents, -2_000);
  assert.equal(row.date, "2027-01-16");
  assert.equal(row.category, "Housing");
  assert.equal(row.description, "January rent");
  assert.equal(transactionSumCents(edited.state.transactions), edited.state.current_balance_cents);

  for (const amountCents of [2_100, 1_900, 3_000]) {
    const changed = editCashTransaction(state, "tx-rent", {
      date: "2027-01-16",
      amountCents,
      category: "Housing",
      description: "January rent",
    });
    assert.equal(changed.ok, false, `expected ${amountCents} to be rejected`);
    if (!changed.ok) assert.match(changed.error, /bill/i);
  }
  // The refused edits did not touch the original ledger.
  assert.deepEqual(state, before);
});

test("deleting a bill-linked expense reopens the original occurrence and restores cash", () => {
  const state = linkedBillState();
  const before = structuredClone(state);

  const deleted = deleteCashTransaction(state, "tx-rent");
  assert.equal(deleted.ok, true);
  if (!deleted.ok) return;
  assert.equal(deleted.state.transactions.some((tx) => tx.id === "tx-rent"), false);
  assert.equal(deleted.state.current_balance_cents, 10_000);
  assert.equal(transactionSumCents(deleted.state.transactions), deleted.state.current_balance_cents);
  assert.deepEqual(deleted.state.bill_occurrences, [
    {
      id: "occ-1", payment_id: "pmt-1", due_date: "2027-01-15", paid: false,
      transaction_id: null, original_due_date: "2027-01-15", is_user_modified: false,
    },
    { id: "occ-next", payment_id: "pmt-1", due_date: "2027-02-15", paid: false },
  ]);
  // Debts and their bill relationships survive the settlement rollback.
  assert.deepEqual(deleted.state.liabilities, before.liabilities);
  assert.deepEqual(state, before);

  // A repeat delete is refused because the row is already gone.
  const repeat = deleteCashTransaction(deleted.state, "tx-rent");
  assert.equal(repeat.ok, false);
  assert.equal(deleted.state.transactions.length, 1);
});

test("deleting a moved settlement reopens it in place, then settles and repeats safely", () => {
  const moved = linkedBillState();
  moved.bill_occurrences[0] = {
    ...moved.bill_occurrences[0],
    due_date: "2027-01-22",
    original_due_date: "2027-01-15",
    is_user_modified: true,
  };

  const reopened = deleteCashTransaction(moved, "tx-rent");
  assert.equal(reopened.ok, true);
  if (!reopened.ok) return;
  // The moved date, original slot, and modified flag all survive the rollback.
  assert.deepEqual(reopened.state.bill_occurrences[0], {
    id: "occ-1", payment_id: "pmt-1", due_date: "2027-01-22", paid: false,
    transaction_id: null, original_due_date: "2027-01-15", is_user_modified: true,
  });
  assert.equal(reopened.state.current_balance_cents, 10_000);
  assert.equal(reopened.state.bill_occurrences.length, 2);

  // A retry is refused and does not duplicate the occurrence.
  assert.equal(deleteCashTransaction(reopened.state, "tx-rent").ok, false);
  assert.equal(reopened.state.bill_occurrences.length, 2);

  // Settling the same original slot again links one fresh row, not a second occurrence.
  const resettled = markBillOccurrencePaid(reopened.state, "pmt-1", "2027-01-15");
  assert.equal(resettled.ok, true);
  if (!resettled.ok) return;
  assert.equal(resettled.state.bill_occurrences.length, 2);
  assert.equal(resettled.state.current_balance_cents, 8_000);
  const settlement = resettled.state.transactions.at(-1)!;
  assert.equal(settlement.amount_cents, -2_000);
  assert.equal(resettled.state.bill_occurrences[0].transaction_id, settlement.id);
  assert.equal(resettled.state.bill_occurrences[0].due_date, "2027-01-22");

  // Deleting that settlement opens the moved occurrence one more time.
  const reopenedAgain = deleteCashTransaction(resettled.state, settlement.id!);
  assert.equal(reopenedAgain.ok, true);
  if (!reopenedAgain.ok) return;
  assert.equal(reopenedAgain.state.current_balance_cents, 10_000);
  assert.equal(reopenedAgain.state.transactions.length, 1);
  assert.equal(reopenedAgain.state.bill_occurrences.length, 2);
  assert.equal(reopenedAgain.state.bill_occurrences[0].paid, false);
  assert.equal(reopenedAgain.state.bill_occurrences[0].transaction_id, null);
  assert.equal(reopenedAgain.state.bill_occurrences[0].original_due_date, "2027-01-15");
  assert.equal(transactionSumCents(reopenedAgain.state.transactions), reopenedAgain.state.current_balance_cents);
});
