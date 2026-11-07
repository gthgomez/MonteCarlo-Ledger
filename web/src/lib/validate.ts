import { LedgerState } from "./types";

/** Structural + semantic validation for imported/pulled ledgers. */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ACCEPTED_VERSIONS = new Set(["2.0", "2.1"]);
const INCOME_FREQUENCIES = new Set(["Weekly", "Bi-weekly", "Monthly", "One-time"]);
const PAYMENT_RECURRENCES = new Set(["Monthly", "One-time", "Weekly", "Bi-weekly"]);
const TRANSACTION_TYPES = new Set(["Income", "Expense", "Adjustment"]);

export type ParseResult =
  | { ok: true; state: LedgerState }
  | { ok: false; error: string };

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value);
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

function fail(path: string, message: string): ParseResult {
  return { ok: false, error: `${path}: ${message}` };
}

function ids(rows: any[], path: string): Set<string> | ParseResult {
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (!isObject(row)) return fail(`${path}[${index}]`, "must be an object");
    if (row.id === undefined || row.id === null) {
      return fail(`${path}[${index}].id`, "is required");
    }
    const key = String(row.id);
    if (seen.has(key)) return fail(`${path}[${index}].id`, `duplicate id ${key}`);
    seen.add(key);
  }
  return seen;
}

export function parseLedgerState(raw: unknown): ParseResult {
  if (!isObject(raw)) return { ok: false, error: "ledger must be a JSON object" };
  if (!ACCEPTED_VERSIONS.has(String(raw.version))) {
    return fail("version", `unsupported ledger version ${JSON.stringify(raw.version)}`);
  }
  if (!isSafeInt(raw.current_balance_cents)) {
    return fail("current_balance_cents", "must be integer cents");
  }

  for (const key of ["incomes", "payments", "transactions", "bill_occurrences", "liabilities"]) {
    if (raw[key] !== undefined && !Array.isArray(raw[key])) {
      return fail(key, "must be an array");
    }
  }
  const incomes = raw.incomes ?? [];
  const payments = raw.payments ?? [];
  const transactions = raw.transactions ?? [];
  const occurrences = raw.bill_occurrences ?? [];
  const liabilities = raw.liabilities ?? [];

  const incomeIds = ids(incomes, "incomes");
  if ("ok" in incomeIds) return incomeIds;
  for (const [index, inc] of incomes.entries()) {
    const path = `incomes[${index}]`;
    if (typeof inc.name !== "string" || inc.name.length === 0) return fail(`${path}.name`, "must be a non-empty string");
    if (!isSafeInt(inc.amount_cents) || inc.amount_cents <= 0) return fail(`${path}.amount_cents`, "must be positive integer cents");
    if (!INCOME_FREQUENCIES.has(inc.frequency)) return fail(`${path}.frequency`, "is unsupported");
    if (!isDate(inc.last_payday)) return fail(`${path}.last_payday`, "must be a valid date");
    if (!isDate(inc.next_payday)) return fail(`${path}.next_payday`, "must be a valid date");
    if (inc.expected_amount !== undefined && inc.expected_amount !== null &&
        (!isSafeInt(inc.expected_amount) || inc.expected_amount <= 0)) {
      return fail(`${path}.expected_amount`, "must be positive integer cents or null");
    }
  }

  const paymentIds = ids(payments, "payments");
  if ("ok" in paymentIds) return paymentIds;
  for (const [index, pmt] of payments.entries()) {
    const path = `payments[${index}]`;
    if (typeof pmt.name !== "string" || pmt.name.length === 0) return fail(`${path}.name`, "must be a non-empty string");
    if (!isSafeInt(pmt.amount_cents) || pmt.amount_cents <= 0) return fail(`${path}.amount_cents`, "must be positive integer cents");
    if (!PAYMENT_RECURRENCES.has(pmt.recurrence)) return fail(`${path}.recurrence`, "is unsupported");
    if (pmt.due_day !== undefined && pmt.due_day !== null &&
        (!isSafeInt(pmt.due_day) || pmt.due_day < 1 || pmt.due_day > 31)) {
      return fail(`${path}.due_day`, "must be 1..31 or null");
    }
    if (pmt.due_date !== undefined && pmt.due_date !== null && !isDate(pmt.due_date)) {
      return fail(`${path}.due_date`, "must be a valid date or null");
    }
    if (pmt.is_auto_withdraw !== undefined && typeof pmt.is_auto_withdraw !== "boolean") {
      return fail(`${path}.is_auto_withdraw`, "must be a boolean");
    }
  }

  const transactionIds = ids(transactions, "transactions");
  if ("ok" in transactionIds) return transactionIds;
  let sum = 0;
  for (const [index, tx] of transactions.entries()) {
    const path = `transactions[${index}]`;
    if (!isSafeInt(tx.amount_cents)) return fail(`${path}.amount_cents`, "must be integer cents");
    if (!TRANSACTION_TYPES.has(tx.type)) return fail(`${path}.type`, "is unsupported");
    if (!isDate(tx.date)) return fail(`${path}.date`, "must be a valid date");
    if (tx.category !== undefined && tx.category !== null && typeof tx.category !== "string") {
      return fail(`${path}.category`, "must be a string");
    }
    if (tx.description !== undefined && tx.description !== null && typeof tx.description !== "string") {
      return fail(`${path}.description`, "must be a string");
    }
    sum += tx.amount_cents;
  }
  if (sum !== raw.current_balance_cents) {
    return fail(
      "current_balance_cents",
      `is inconsistent with the transaction ledger (${raw.current_balance_cents} vs ${sum})`
    );
  }

  for (const [index, occ] of occurrences.entries()) {
    const path = `bill_occurrences[${index}]`;
    if (!isObject(occ)) return fail(path, "must be an object");
    if (occ.id === undefined || occ.id === null) return fail(`${path}.id`, "is required");
    if (occ.payment_id === undefined || occ.payment_id === null) return fail(`${path}.payment_id`, "is required");
    if (!paymentIds.has(String(occ.payment_id))) return fail(`${path}.payment_id`, "references an unknown payment");
    if (!isDate(occ.due_date)) return fail(`${path}.due_date`, "must be a valid date");
    if (typeof occ.paid !== "boolean") return fail(`${path}.paid`, "must be a boolean");
    if (occ.transaction_id !== undefined && occ.transaction_id !== null &&
        !transactionIds.has(String(occ.transaction_id))) {
      return fail(`${path}.transaction_id`, "references an unknown transaction");
    }
  }

  for (const [index, liability] of liabilities.entries()) {
    const path = `liabilities[${index}]`;
    if (!isObject(liability)) return fail(path, "must be an object");
    if (liability.id === undefined || liability.id === null) return fail(`${path}.id`, "is required");
    if (typeof liability.name !== "string" || liability.name.length === 0) return fail(`${path}.name`, "must be a non-empty string");
    if (!isSafeInt(liability.balance_cents) || liability.balance_cents < 0) return fail(`${path}.balance_cents`, "must be non-negative integer cents");
    if (!isSafeInt(liability.apr_basis_points) || liability.apr_basis_points < 0) return fail(`${path}.apr_basis_points`, "must be non-negative basis points");
    if (!isSafeInt(liability.min_payment_cents) || liability.min_payment_cents < 0) return fail(`${path}.min_payment_cents`, "must be non-negative integer cents");
  }

  return {
    ok: true,
    state: {
      version: raw.version,
      updated_at: typeof raw.updated_at === "string" ? raw.updated_at : new Date().toISOString(),
      current_balance_cents: raw.current_balance_cents,
      incomes,
      payments,
      transactions,
      bill_occurrences: occurrences,
      liabilities,
    } as LedgerState,
  };
}
