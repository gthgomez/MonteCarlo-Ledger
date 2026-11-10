import assert from "node:assert/strict";
import test from "node:test";

import {
  addBill,
  addIncomeSchedule,
  addInstallmentDebt,
  aprPercentToBasisPoints,
  createStarterLedger,
  dollarsToCents,
  reconcileBalance,
  recordCashflow,
  removePayment,
} from "../ledger-edits";
import { SAMPLE_LEDGER_STATE } from "../types";
import { transactionSumCents } from "../present";

test("dollar entry becomes integer cents", () => {
  assert.equal(dollarsToCents(45.2), 4520);
  assert.equal(dollarsToCents(Number.NaN), null);
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
