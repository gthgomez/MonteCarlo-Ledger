import { LedgerState } from "./types";

/** Structural + semantic validation for imported/pulled ledgers. */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ACCEPTED_VERSIONS = new Set(["2.0", "2.1"]);
const INCOME_FREQUENCIES = new Set(["Weekly", "Bi-weekly", "Monthly", "One-time"]);
const PAYMENT_RECURRENCES = new Set(["Monthly", "One-time", "Weekly", "Bi-weekly"]);
const TRANSACTION_TYPES = new Set(["Income", "Expense", "Adjustment"]);

/**
 * The snapshot format defines these collections. A missing collection is an
 * incomplete snapshot, not an empty one; defaulting it to `[]` would delete data.
 */
const REQUIRED_FIELDS = [
  "version",
  "current_balance_cents",
  "incomes",
  "payments",
  "transactions",
  "bill_occurrences",
  "liabilities",
] as const;
const KNOWN_TOP_LEVEL = new Set<string>([...REQUIRED_FIELDS, "updated_at"]);

/** Exact row shapes. Unknown fields are rejected rather than silently dropped. */
const ROW_FIELDS: Record<string, Set<string>> = {
  incomes: new Set([
    "id", "name", "amount_cents", "frequency", "last_payday", "next_payday", "expected_amount",
  ]),
  payments: new Set([
    "id", "name", "amount_cents", "due_day", "recurrence", "due_date", "is_auto_withdraw",
  ]),
  transactions: new Set([
    "id", "amount_cents", "category", "type", "date", "description",
  ]),
  bill_occurrences: new Set([
    "id", "payment_id", "due_date", "paid", "transaction_id",
    "original_due_date", "is_user_modified",
  ]),
  liabilities: new Set([
    "id", "name", "balance_cents", "apr_basis_points", "min_payment_cents",
    "kind", "min_payment_percent_bps", "min_payment_floor_cents", "due_day_of_month",
  ]),
};

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

/** Reject fields the validator cannot preserve. */
function checkRowFields(
  row: Record<string, any>,
  collection: string,
  index: number
): ParseResult | null {
  const allowed = ROW_FIELDS[collection];
  const unknown = Object.keys(row).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    return fail(
      `${collection}[${index}]`,
      `contains unsupported fields (${unknown.sort().join(", ")}); refusing to discard financial information`
    );
  }
  return null;
}

function ids(rows: any[], path: string): Set<string> | ParseResult {
  const seen = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (!isObject(row)) return fail(`${path}[${index}]`, "must be an object");
    if (row.id === undefined || row.id === null) {
      return fail(`${path}[${index}].id`, "is required");
    }
    if (
      (typeof row.id !== "number" || !isSafeInt(row.id)) &&
      (typeof row.id !== "string" || row.id.length === 0)
    ) {
      return fail(`${path}[${index}].id`, "must be an integer or a non-empty string");
    }
    const key = String(row.id);
    if (seen.has(key)) return fail(`${path}[${index}].id`, `duplicate id ${key}`);
    seen.add(key);
  }
  return seen;
}

export function parseLedgerState(raw: unknown): ParseResult {
  if (!isObject(raw)) return { ok: false, error: "ledger must be a JSON object" };

  for (const field of REQUIRED_FIELDS) {
    if (!(field in raw)) {
      return fail(
        field,
        "is required; refusing to treat an incomplete snapshot as an empty ledger"
      );
    }
  }
  const unknownTopLevel = Object.keys(raw).filter((key) => !KNOWN_TOP_LEVEL.has(key));
  if (unknownTopLevel.length > 0) {
    return fail(
      "(root)",
      `contains unsupported fields (${unknownTopLevel.sort().join(", ")}); refusing to discard data the Web ledger cannot represent`
    );
  }

  if (!ACCEPTED_VERSIONS.has(String(raw.version))) {
    return fail("version", `unsupported ledger version ${JSON.stringify(raw.version)}`);
  }
  if (!isSafeInt(raw.current_balance_cents)) {
    return fail("current_balance_cents", "must be integer cents");
  }

  for (const key of ["incomes", "payments", "transactions", "bill_occurrences", "liabilities"]) {
    if (!Array.isArray(raw[key])) {
      return fail(key, "must be an array");
    }
  }
  const incomes = raw.incomes;
  const payments = raw.payments;
  const transactions = raw.transactions;
  const occurrences = raw.bill_occurrences;
  const liabilities = raw.liabilities;

  const incomeIds = ids(incomes, "incomes");
  if ("ok" in incomeIds) return incomeIds;
  for (const [index, inc] of incomes.entries()) {
    const path = `incomes[${index}]`;
    const fieldError = checkRowFields(inc, "incomes", index);
    if (fieldError) return fieldError;
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
    const fieldError = checkRowFields(pmt, "payments", index);
    if (fieldError) return fieldError;
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
    const fieldError = checkRowFields(tx, "transactions", index);
    if (fieldError) return fieldError;
    if (!isSafeInt(tx.amount_cents)) return fail(`${path}.amount_cents`, "must be integer cents");
    if (!TRANSACTION_TYPES.has(tx.type)) return fail(`${path}.type`, "is unsupported");
    // Sign invariants must match ordinary ledger insertion, not merely balance to sum.
    if (tx.type === "Income" && tx.amount_cents <= 0) return fail(`${path}.amount_cents`, "Income must be positive");
    if (tx.type === "Expense" && tx.amount_cents >= 0) return fail(`${path}.amount_cents`, "Expense must be negative");
    if (tx.type === "Adjustment" && tx.amount_cents === 0) return fail(`${path}.amount_cents`, "Adjustment must be non-zero");
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

  const occurrenceIds = ids(occurrences, "bill_occurrences");
  if ("ok" in occurrenceIds) return occurrenceIds;
  const transactionById = new Map(transactions.map((tx: any) => [String(tx.id), tx] as const));
  const paymentAmountById = new Map(payments.map((pmt: any) => [String(pmt.id), pmt.amount_cents] as const));
  const linkedTransactions = new Set<string>();
  for (const [index, occ] of occurrences.entries()) {
    const path = `bill_occurrences[${index}]`;
    const fieldError = checkRowFields(occ, "bill_occurrences", index);
    if (fieldError) return fieldError;
    if (occ.payment_id === undefined || occ.payment_id === null) return fail(`${path}.payment_id`, "is required");
    if (!paymentIds.has(String(occ.payment_id))) return fail(`${path}.payment_id`, "references an unknown payment");
    if (!isDate(occ.due_date)) return fail(`${path}.due_date`, "must be a valid date");
    if (typeof occ.paid !== "boolean") return fail(`${path}.paid`, "must be a boolean");
    if (occ.original_due_date !== undefined && occ.original_due_date !== null && !isDate(occ.original_due_date)) {
      return fail(`${path}.original_due_date`, "must be a valid date or null");
    }
    if (occ.is_user_modified !== undefined && typeof occ.is_user_modified !== "boolean") {
      return fail(`${path}.is_user_modified`, "must be a boolean");
    }
    if (occ.transaction_id !== undefined && occ.transaction_id !== null) {
      const txnKey = String(occ.transaction_id);
      if (!transactionIds.has(txnKey)) return fail(`${path}.transaction_id`, "references an unknown transaction");
      if (!occ.paid) return fail(`${path}.transaction_id`, "cannot link a transaction to an unpaid occurrence");
      if (linkedTransactions.has(txnKey)) {
        return fail(`${path}.transaction_id`, "reuses a transaction that already paid another bill");
      }
      linkedTransactions.add(txnKey);
      const tx: any = transactionById.get(txnKey)!;
      if (tx.type !== "Expense") return fail(`${path}.transaction_id`, "must reference an Expense transaction");
      if (Math.abs(tx.amount_cents) !== paymentAmountById.get(String(occ.payment_id))) {
        return fail(`${path}.transaction_id`, "transaction amount does not match the bill amount");
      }
    }
  }

  const liabilityIds = ids(liabilities, "liabilities");
  if ("ok" in liabilityIds) return liabilityIds;
  for (const [index, liability] of liabilities.entries()) {
    const path = `liabilities[${index}]`;
    const fieldError = checkRowFields(liability, "liabilities", index);
    if (fieldError) return fieldError;
    if (typeof liability.name !== "string" || liability.name.length === 0) return fail(`${path}.name`, "must be a non-empty string");
    if (!isSafeInt(liability.balance_cents) || liability.balance_cents < 0) return fail(`${path}.balance_cents`, "must be non-negative integer cents");
    if (!isSafeInt(liability.apr_basis_points) || liability.apr_basis_points < 0) return fail(`${path}.apr_basis_points`, "must be non-negative basis points");
    if (!isSafeInt(liability.min_payment_cents) || liability.min_payment_cents < 0) return fail(`${path}.min_payment_cents`, "must be non-negative integer cents");
    if (liability.kind !== undefined && liability.kind !== "installment" && liability.kind !== "revolving") {
      return fail(`${path}.kind`, "must be installment or revolving");
    }
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
