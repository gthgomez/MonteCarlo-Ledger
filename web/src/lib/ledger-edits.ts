import { parseLedgerState } from "./validate";
import { unresolvedPastOneTimeSlots } from "./scenario-builder";
import type { IncomeItem, LedgerState, PaymentItem } from "./types";

export type EditResult = { ok: true; state: LedgerState } | { ok: false; error: string };

function clone(state: LedgerState): LedgerState {
  return JSON.parse(JSON.stringify(state)) as LedgerState;
}

function commit(next: LedgerState): EditResult {
  const parsed = parseLedgerState(next);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, state: parsed.state };
}

function nextId(prefix: string, rows: { id?: number | string }[]): string {
  const used = new Set(rows.map((row) => String(row.id)));
  let n = rows.length + 1;
  let id = `${prefix}-${n}`;
  while (used.has(id)) {
    n += 1;
    id = `${prefix}-${n}`;
  }
  return id;
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day;
}

function occurrenceSlot(occurrence: { due_date: string; original_due_date?: string | null }): string {
  return occurrence.original_due_date || occurrence.due_date;
}

/** Append one paid occurrence for a stable schedule slot, without touching cash. */
function appendPaidOccurrence(
  next: LedgerState,
  paymentId: number | string,
  slotDate: string,
  transactionId: number | string | null,
): void {
  next.bill_occurrences = [
    ...next.bill_occurrences,
    {
      id: nextId("occ", next.bill_occurrences),
      payment_id: paymentId,
      due_date: slotDate,
      paid: true,
      transaction_id: transactionId,
      original_due_date: slotDate,
      is_user_modified: false,
    },
  ];
}

function isScheduledPaymentDate(payment: PaymentItem, value: string): boolean {
  if (payment.recurrence === "Monthly" && payment.due_day) {
    const [year, month, day] = value.split("-").map(Number);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return day === Math.min(payment.due_day, lastDay);
  }
  if (!payment.due_date || payment.recurrence === "One-time") return payment.due_date === value;
  const start = new Date(`${payment.due_date}T00:00:00Z`).getTime();
  const current = new Date(`${value}T00:00:00Z`).getTime();
  const days = Math.round((current - start) / 86_400_000);
  const interval = payment.recurrence === "Weekly" ? 7 : 14;
  return days >= 0 && days % interval === 0;
}

/** Mark one stable payment slot paid, atomically adding its matching expense transaction. */
export function markBillOccurrencePaid(
  state: LedgerState,
  paymentId: number | string,
  slotDate: string,
  transactionDate: string = slotDate,
): EditResult {
  if (!validIsoDate(slotDate) || !validIsoDate(transactionDate)) {
    return { ok: false, error: "Use valid calendar dates for the bill and transaction." };
  }
  const payment = state.payments.find((item) => String(item.id) === String(paymentId));
  if (!payment) return { ok: false, error: "That bill no longer exists." };
  const next = clone(state);
  const occurrence = next.bill_occurrences.find(
    (item) => String(item.payment_id) === String(paymentId) && occurrenceSlot(item) === slotDate,
  );
  if (occurrence?.paid) return { ok: true, state };
  if (!occurrence && !isScheduledPaymentDate(payment, slotDate)) {
    return { ok: false, error: "This date is no longer on the bill’s schedule. Reopen the bill and try again." };
  }
  const transactionId = nextId("tx", next.transactions);
  const transaction = {
    id: transactionId,
    amount_cents: -payment.amount_cents,
    category: "Bills",
    type: "Expense" as const,
    date: transactionDate,
    description: payment.name,
  };
  next.transactions = [...next.transactions, transaction];
  next.current_balance_cents += transaction.amount_cents;
  if (!Number.isSafeInteger(next.current_balance_cents)) {
    return { ok: false, error: "That payment is outside the supported balance range." };
  }
  if (occurrence) {
    if (occurrence.transaction_id !== undefined && occurrence.transaction_id !== null) {
      return { ok: false, error: "This bill occurrence already has a transaction." };
    }
    occurrence.paid = true;
    occurrence.transaction_id = transactionId;
  } else {
    appendPaidOccurrence(next, paymentId, slotDate, transactionId);
  }
  next.updated_at = new Date().toISOString();
  return commit(next);
}

export interface PostedExpenseMatch {
  id: number | string;
  /** Positive magnitude in integer cents, equal to the bill amount. */
  amountCents: number;
  date: string;
  description: string;
}

/** Canonical key for comparisons; links use the original stored identifier. */
function stableRowId(value: number | string | null | undefined): string | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? String(value) : null;
  if (typeof value === "string" && value.length > 0) return value;
  return null;
}

/**
 * Posted expenses that could be the payment for one unresolved past one-time
 * bill. This is a review aid, not an automatic match: a person must select one
 * explicitly. Candidates use the full exact amount, an Expense with a negative
 * sign, a date on or before `asOf`, a stable id, and no link from any existing
 * occurrence. Paid or moved occurrences already cover their slot through the
 * bill adapter's slot helper, so they never produce candidates.
 */
export function postedExpenseMatchesForPastOneTimeBill(
  state: LedgerState,
  paymentId: number | string,
  slotDate: string,
  asOf: string,
): PostedExpenseMatch[] {
  if (!validIsoDate(slotDate) || !validIsoDate(asOf)) return [];
  const slot = unresolvedPastOneTimeSlots(state, asOf).find(
    (candidate) => String(candidate.payment.id) === String(paymentId) && candidate.slotDate === slotDate,
  );
  if (!slot) return [];
  const amountCents = slot.payment.amount_cents;
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) return [];
  const referenced = new Set<string>();
  for (const occurrence of state.bill_occurrences) {
    const linkedId = stableRowId(occurrence.transaction_id);
    if (linkedId !== null) referenced.add(linkedId);
  }
  const matches: PostedExpenseMatch[] = [];
  for (const transaction of state.transactions) {
    const id = stableRowId(transaction.id);
    if (id === null || referenced.has(id)) continue;
    if (transaction.type !== "Expense") continue;
    if (!Number.isSafeInteger(transaction.amount_cents) || transaction.amount_cents !== -amountCents) continue;
    if (!validIsoDate(transaction.date) || transaction.date > asOf) continue;
    matches.push({
      id: transaction.id as number | string,
      amountCents,
      date: transaction.date,
      description: (transaction.description || transaction.category || "Recorded expense").trim()
        || "Recorded expense",
    });
  }
  matches.sort(
    (left, right) => right.date.localeCompare(left.date) || String(left.id).localeCompare(String(right.id)),
  );
  return matches;
}

/**
 * Record that an already-posted Expense paid one past one-time bill slot.
 * The transaction keeps its id, date, amount, and description; the balance is
 * unchanged. Only the bill occurrence is added, with the original due date as
 * both its due date and its stable slot, and `commit` reconciles the ledger.
 * Eligibility is rechecked here so a stale row cannot link the wrong expense.
 */
export function linkPostedExpenseToPastOneTimeBill(
  state: LedgerState,
  paymentId: number | string,
  slotDate: string,
  transactionId: number | string,
  asOf: string,
): EditResult {
  if (!validIsoDate(slotDate) || !validIsoDate(asOf)) {
    return { ok: false, error: "Use valid calendar dates for the bill and the review date." };
  }
  const transactionKey = stableRowId(transactionId);
  if (transactionKey === null) return { ok: false, error: "Choose a recorded expense to link." };
  const payment = state.payments.find((item) => String(item.id) === String(paymentId));
  if (!payment) return { ok: false, error: "That bill no longer exists." };
  if (payment.recurrence !== "One-time" || payment.due_date !== slotDate) {
    return { ok: false, error: "Only a past one-time bill can link an existing recorded expense." };
  }
  if (!(slotDate < asOf)) {
    return { ok: false, error: "That bill is not past due yet. Resolve it on its scheduled date." };
  }
  const match = postedExpenseMatchesForPastOneTimeBill(state, paymentId, slotDate, asOf)
    .find((item) => String(item.id) === transactionKey);
  if (!match) {
    return {
      ok: false,
      error: "That expense no longer qualifies to pay this bill. Refresh the bill list and choose again.",
    };
  }
  const next = clone(state);
  appendPaidOccurrence(next, paymentId, slotDate, match.id);
  next.updated_at = new Date().toISOString();
  return commit(next);
}

/**
 * Mark a past one-time bill paid without posting a debit because the payment is
 * already included in the starting or reconciled cash balance (for example, it
 * is part of “Money you have now”). Only the paid occurrence is added, with a
 * null transaction id and the original scheduled date as its stable slot. No
 * expense row and no balance adjustment are created. The action is idempotent;
 * an already-paid slot with a transaction stays untouched and is rejected.
 * Eligibility is rechecked here so a stale row cannot mark a different slot.
 */
export function markPastOneTimeBillPaidWithoutExpense(
  state: LedgerState,
  paymentId: number | string,
  slotDate: string,
  asOf: string,
): EditResult {
  if (!validIsoDate(slotDate) || !validIsoDate(asOf)) {
    return { ok: false, error: "Use valid calendar dates for the bill and the review date." };
  }
  const payment = state.payments.find((item) => String(item.id) === String(paymentId));
  if (!payment) return { ok: false, error: "That bill no longer exists." };
  if (payment.recurrence !== "One-time" || payment.due_date !== slotDate) {
    return { ok: false, error: "Only a past one-time bill can be marked paid without a new expense." };
  }
  if (!(slotDate < asOf)) {
    return { ok: false, error: "That bill is not past due yet. Resolve it on its scheduled date." };
  }
  const existing = state.bill_occurrences.find(
    (item) => String(item.payment_id) === String(paymentId) && occurrenceSlot(item) === slotDate,
  );
  if (existing) {
    if (existing.paid && !existing.is_user_modified && existing.due_date === slotDate && existing.transaction_id == null) {
      return { ok: true, state };
    }
    return { ok: false, error: "That bill already has a recorded payment. Refresh the bill list." };
  }
  const slot = unresolvedPastOneTimeSlots(state, asOf).find(
    (candidate) => String(candidate.payment.id) === String(paymentId) && candidate.slotDate === slotDate,
  );
  if (!slot) {
    return { ok: false, error: "This is not a past one-time slot on the bill’s schedule. Refresh the bill list." };
  }
  const next = clone(state);
  appendPaidOccurrence(next, paymentId, slotDate, null);
  next.updated_at = new Date().toISOString();
  return commit(next);
}

/** Move one payment slot while retaining its original schedule identity. */
export function moveBillOccurrence(
  state: LedgerState,
  paymentId: number | string,
  slotDate: string,
  newDate: string,
): EditResult {
  if (!validIsoDate(slotDate) || !validIsoDate(newDate)) {
    return { ok: false, error: "Use valid calendar dates for the original and new bill dates." };
  }
  const payment = state.payments.find((item) => String(item.id) === String(paymentId));
  if (!payment) return { ok: false, error: "That bill no longer exists." };
  const next = clone(state);
  const occurrence = next.bill_occurrences.find(
    (item) => String(item.payment_id) === String(paymentId) && occurrenceSlot(item) === slotDate,
  );
  if (occurrence?.paid) return { ok: false, error: "A paid bill occurrence cannot be moved." };
  if (!occurrence && !isScheduledPaymentDate(payment, slotDate)) {
    return { ok: false, error: "This date is no longer on the bill’s schedule. Reopen the bill and try again." };
  }
  const collision = next.bill_occurrences.some(
    (item) => item !== occurrence && String(item.payment_id) === String(paymentId) && item.due_date === newDate,
  );
  if (collision || (newDate !== slotDate && isScheduledPaymentDate(payment, newDate))) {
    return { ok: false, error: "That bill already has an occurrence on the new date." };
  }
  if (occurrence) {
    occurrence.due_date = newDate;
    occurrence.original_due_date = slotDate;
    occurrence.is_user_modified = true;
  } else {
    next.bill_occurrences = [
      ...next.bill_occurrences,
      {
        id: nextId("occ", next.bill_occurrences),
        payment_id: paymentId,
        due_date: newDate,
        paid: false,
        original_due_date: slotDate,
        is_user_modified: true,
      },
    ];
  }
  next.updated_at = new Date().toISOString();
  return commit(next);
}

export function dollarsToCents(value: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents)) return null;
  return cents;
}

/** Parse an entered dollar amount without rounding away a fraction of a cent. */
export function parseDollarsToCents(text: string): number | null {
  const match = /^(\d{1,14})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const cents = BigInt(match[1]) * 100n + BigInt((match[2] ?? "").padEnd(2, "0"));
  const value = Number(cents);
  return Number.isSafeInteger(value) ? value : null;
}

/** "21.99" -> 2199 basis points. Rejects float math and more than two decimals. */
export function aprPercentToBasisPoints(text: string): number | null {
  const trimmed = text.trim();
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(trimmed)) return null;
  const [whole, frac = ""] = trimmed.split(".");
  const bps = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > 100_000) return null;
  return bps;
}

export function createStarterLedger(input: {
  asOf: string;
  balanceCents: number;
  income?: {
    name: string;
    amountCents: number;
    frequency: IncomeItem["frequency"];
    nextPayday: string;
  } | null;
  bill?: { name: string; amountCents: number; dueDay: number } | null;
}): EditResult {
  if (!Number.isSafeInteger(input.balanceCents)) {
    return { ok: false, error: "Balance must be a whole number of cents." };
  }
  const transactions =
    input.balanceCents === 0
      ? []
      : [
          {
            id: "tx-open",
            amount_cents: input.balanceCents,
            category: "Adjustment",
            type: "Adjustment" as const,
            date: input.asOf,
            description: "Opening balance",
          },
        ];
  const state: LedgerState = {
    version: "2.0",
    updated_at: new Date().toISOString(),
    current_balance_cents: input.balanceCents,
    incomes: [],
    payments: [],
    transactions,
    bill_occurrences: [],
    liabilities: [],
  };
  if (input.income) {
    const name = input.income.name.trim();
    if (!name) return { ok: false, error: "Enter a name for the paycheck." };
    state.incomes.push({
      id: "inc-1",
      name,
      amount_cents: input.income.amountCents,
      frequency: input.income.frequency,
      last_payday: input.income.nextPayday,
      next_payday: input.income.nextPayday,
    });
  }
  if (input.bill) {
    const name = input.bill.name.trim();
    if (!name) return { ok: false, error: "Enter a name for the bill." };
    state.payments.push({
      id: "pmt-1",
      name,
      amount_cents: input.bill.amountCents,
      due_day: input.bill.dueDay,
      recurrence: "Monthly",
      is_auto_withdraw: false,
    });
  }
  return commit(state);
}

export function recordCashflow(
  state: LedgerState,
  input: {
    date: string;
    kind: "Income" | "Expense";
    amountCents: number;
    category: string;
    description: string;
  }
): EditResult {
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0) {
    return { ok: false, error: "Enter an amount greater than zero." };
  }
  const category = input.category.trim() || (input.kind === "Income" ? "Income" : "Spending");
  if (category.length > 40) return { ok: false, error: "Use a shorter category name." };
  const signed = input.kind === "Expense" ? -input.amountCents : input.amountCents;
  const nextBalance = state.current_balance_cents + signed;
  if (!Number.isSafeInteger(nextBalance)) {
    return { ok: false, error: "That amount is outside the supported range." };
  }
  const next = clone(state);
  next.current_balance_cents = nextBalance;
  next.updated_at = new Date().toISOString();
  next.transactions = [
    ...next.transactions,
    {
      id: nextId("tx", next.transactions),
      amount_cents: signed,
      category,
      type: input.kind,
      date: input.date,
      description: input.description.trim() || category,
    },
  ];
  return commit(next);
}

export function reconcileBalance(state: LedgerState, balanceCents: number, date: string): EditResult {
  if (!Number.isSafeInteger(balanceCents)) {
    return { ok: false, error: "Enter the balance in dollars and cents." };
  }
  if (!validIsoDate(date)) return { ok: false, error: "Use a valid reconciliation date." };
  const asOfBalance = state.transactions
    .filter((tx) => tx.date <= date)
    .reduce((sum, tx) => sum + BigInt(tx.amount_cents), 0n);
  const difference = BigInt(balanceCents) - asOfBalance;
  const diff = Number(difference);
  const ledgerTotal = Number(BigInt(state.current_balance_cents) + difference);
  if (!Number.isSafeInteger(diff) || !Number.isSafeInteger(ledgerTotal)) {
    return { ok: false, error: "That balance is outside the supported range." };
  }
  if (diff === 0) {
    return { ok: false, error: "That already matches the recorded balance. No adjustment was added." };
  }
  const next = clone(state);
  next.current_balance_cents = ledgerTotal;
  next.updated_at = new Date().toISOString();
  next.transactions = [
    ...next.transactions,
    {
      id: nextId("tx-adj", next.transactions),
      amount_cents: diff,
      category: "Adjustment",
      type: "Adjustment",
      date,
      description: "Balance reconciliation adjustment",
    },
  ];
  return commit(next);
}

export function addBill(
  state: LedgerState,
  bill: {
    name: string;
    amountCents: number;
    recurrence: PaymentItem["recurrence"];
    dueDay?: number | null;
    dueDate?: string | null;
    autoWithdraw: boolean;
  }
): EditResult {
  const name = bill.name.trim();
  if (!name) return { ok: false, error: "Enter a name for the bill." };
  if (!Number.isSafeInteger(bill.amountCents) || bill.amountCents <= 0) {
    return { ok: false, error: "Enter a bill amount greater than zero." };
  }
  const next = clone(state);
  const row: PaymentItem = {
    id: nextId("pmt", next.payments),
    name,
    amount_cents: bill.amountCents,
    recurrence: bill.recurrence,
    is_auto_withdraw: bill.autoWithdraw,
  };
  if (bill.recurrence === "Monthly") {
    if (!Number.isInteger(bill.dueDay) || (bill.dueDay ?? 0) < 1 || (bill.dueDay ?? 0) > 31) {
      return { ok: false, error: "A monthly bill needs a due day from 1 to 31." };
    }
    row.due_day = bill.dueDay;
  } else if (!bill.dueDate) {
    return { ok: false, error: "Enter the next date for this bill." };
  } else {
    row.due_date = bill.dueDate;
  }
  next.payments = [...next.payments, row];
  next.updated_at = new Date().toISOString();
  return commit(next);
}

export function removePayment(state: LedgerState, id: number | string): EditResult {
  const next = clone(state);
  next.payments = next.payments.filter((payment) => String(payment.id) !== String(id));
  for (const debt of next.liabilities ?? []) {
    if (debt.linked_payment_id != null && String(debt.linked_payment_id) === String(id)) {
      delete debt.linked_payment_id;
    }
  }
  next.bill_occurrences = next.bill_occurrences.filter(
    (occurrence) => String(occurrence.payment_id) !== String(id)
  );
  next.updated_at = new Date().toISOString();
  return commit(next);
}

export function addIncomeSchedule(
  state: LedgerState,
  income: {
    name: string;
    amountCents: number;
    frequency: IncomeItem["frequency"];
    nextPayday: string;
  }
): EditResult {
  const name = income.name.trim();
  if (!name) return { ok: false, error: "Enter a name for this income." };
  if (!Number.isSafeInteger(income.amountCents) || income.amountCents <= 0) {
    return { ok: false, error: "Enter a take-home amount greater than zero." };
  }
  const next = clone(state);
  next.incomes = [
    ...next.incomes,
    {
      id: nextId("inc", next.incomes),
      name,
      amount_cents: income.amountCents,
      frequency: income.frequency,
      last_payday: income.nextPayday,
      next_payday: income.nextPayday,
    },
  ];
  next.updated_at = new Date().toISOString();
  return commit(next);
}

export function removeIncome(state: LedgerState, id: number | string): EditResult {
  const next = clone(state);
  next.incomes = next.incomes.filter((income) => String(income.id) !== String(id));
  next.updated_at = new Date().toISOString();
  return commit(next);
}

export function addInstallmentDebt(
  state: LedgerState,
  debt: { name: string; balanceCents: number; aprBasisPoints: number; minPaymentCents: number; dueDay?: number; linkedPaymentId?: number | string }
): EditResult {
  const name = debt.name.trim();
  if (!name) return { ok: false, error: "Enter a name for the debt." };
  if (!Number.isSafeInteger(debt.balanceCents) || debt.balanceCents < 0) {
    return { ok: false, error: "Enter the amount you still owe." };
  }
  if (!Number.isSafeInteger(debt.aprBasisPoints) || debt.aprBasisPoints < 0) {
    return { ok: false, error: "Enter the interest rate, such as 21.99." };
  }
  if (!Number.isSafeInteger(debt.minPaymentCents) || debt.minPaymentCents < 0) {
    return { ok: false, error: "Enter the minimum payment." };
  }
  if (debt.dueDay !== undefined && (!Number.isInteger(debt.dueDay) || debt.dueDay < 1 || debt.dueDay > 31)) {
    return { ok: false, error: "Enter the usual payment day from 1 to 31." };
  }
  const next = clone(state);
  next.liabilities = [
    ...(next.liabilities ?? []),
    {
      id: nextId("debt", next.liabilities ?? []),
      name,
      balance_cents: debt.balanceCents,
      apr_basis_points: debt.aprBasisPoints,
      min_payment_cents: debt.minPaymentCents,
      kind: "installment",
      ...(debt.dueDay === undefined ? {} : { due_day_of_month: debt.dueDay }),
      ...(debt.linkedPaymentId === undefined ? {} : { linked_payment_id: debt.linkedPaymentId }),
    },
  ];
  if (debt.linkedPaymentId !== undefined) next.version = "2.2";
  next.updated_at = new Date().toISOString();
  return commit(next);
}

export function updateLiabilityBalance(state: LedgerState, id: string, balanceCents: number): EditResult {
  if (!Number.isSafeInteger(balanceCents) || balanceCents < 0) {
    return { ok: false, error: "Enter the amount still owed in dollars, or enter 0 for a paid-off debt." };
  }
  const next = clone(state);
  const debt = next.liabilities.find((item) => item.id === id);
  if (!debt) return { ok: false, error: "That debt no longer exists." };
  debt.balance_cents = balanceCents;
  next.updated_at = new Date().toISOString();
  return commit(next);
}

export function removeLiability(state: LedgerState, id: string): EditResult {
  const next = clone(state);
  next.liabilities = (next.liabilities ?? []).filter((debt) => debt.id !== id);
  next.updated_at = new Date().toISOString();
  return commit(next);
}
