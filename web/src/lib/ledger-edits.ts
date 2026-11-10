import { parseLedgerState } from "./validate";
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

export function dollarsToCents(value: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const cents = Math.round(value * 100);
  if (!Number.isSafeInteger(cents)) return null;
  return cents;
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
  const diff = balanceCents - state.current_balance_cents;
  if (!Number.isSafeInteger(diff)) {
    return { ok: false, error: "That balance is outside the supported range." };
  }
  if (diff === 0) {
    return { ok: false, error: "That already matches the recorded balance. No adjustment was added." };
  }
  const next = clone(state);
  next.current_balance_cents = balanceCents;
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
  debt: { name: string; balanceCents: number; aprBasisPoints: number; minPaymentCents: number }
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
    },
  ];
  next.updated_at = new Date().toISOString();
  return commit(next);
}

export function removeLiability(state: LedgerState, id: string): EditResult {
  const next = clone(state);
  next.liabilities = (next.liabilities ?? []).filter((debt) => debt.id !== id);
  next.updated_at = new Date().toISOString();
  return commit(next);
}
