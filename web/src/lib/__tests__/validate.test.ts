import test from "node:test";
import assert from "node:assert/strict";
import { parseLedgerState } from "../validate";

function base(overrides: Record<string, unknown> = {}) {
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

test("accepts a zero-balance ledger (the old import guard rejected it)", () => {
  const result = parseLedgerState(base());
  assert.equal(result.ok, true);
});

test("accepts negative balances and preserves expected_amount", () => {
  const result = parseLedgerState(
    base({
      current_balance_cents: -500,
      incomes: [
        {
          id: "inc-1",
          name: "Pay",
          amount_cents: 220_000,
          frequency: "Bi-weekly",
          last_payday: "2026-10-09",
          next_payday: "2026-10-23",
          expected_amount: 235_000,
        },
      ],
      transactions: [
        { id: 1, amount_cents: -500, type: "Expense", date: "2026-10-01" },
      ],
    })
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.state.incomes[0].expected_amount, 235_000);
    assert.equal(result.state.current_balance_cents, -500);
  }
});

test("rejects unsupported versions", () => {
  const result = parseLedgerState(base({ version: "9.9" }));
  assert.equal(result.ok, false);
});

test("rejects non-integer money", () => {
  const result = parseLedgerState(base({ current_balance_cents: 1.5 }));
  assert.equal(result.ok, false);
});

test("rejects a balance that disagrees with the transaction ledger", () => {
  const result = parseLedgerState(
    base({
      current_balance_cents: 0,
      transactions: [
        { id: 1, amount_cents: 500, type: "Income", date: "2026-10-01" },
      ],
    })
  );
  assert.equal(result.ok, false);
});

test("rejects duplicate identifiers", () => {
  const result = parseLedgerState(
    base({
      current_balance_cents: 0,
      transactions: [
        { id: 1, amount_cents: 100, type: "Income", date: "2026-10-01" },
        { id: 1, amount_cents: -100, type: "Expense", date: "2026-10-02" },
      ],
    })
  );
  assert.equal(result.ok, false);
});

test("rejects an occurrence that references an unknown payment", () => {
  const result = parseLedgerState(
    base({
      current_balance_cents: 0,
      bill_occurrences: [
        { id: 1, payment_id: "missing", due_date: "2026-10-01", paid: false },
      ],
    })
  );
  assert.equal(result.ok, false);
});

test("rejects impossible calendar dates", () => {
  const result = parseLedgerState(
    base({
      current_balance_cents: 100,
      transactions: [
        { id: 1, amount_cents: 100, type: "Income", date: "2026-02-30" },
      ],
    })
  );
  assert.equal(result.ok, false);
});

test("rejects a snapshot with a missing required collection", () => {
  for (const key of ["incomes", "payments", "transactions", "bill_occurrences", "liabilities"]) {
    const snapshot = base();
    delete (snapshot as Record<string, unknown>)[key];
    const result = parseLedgerState(snapshot);
    assert.equal(result.ok, false, `missing ${key} must be rejected`);
    if (!result.ok) assert.match(result.error, new RegExp(key));
  }
});

test("rejects a missing balance instead of treating it as zero", () => {
  const snapshot = base();
  delete (snapshot as Record<string, unknown>).current_balance_cents;
  const result = parseLedgerState(snapshot);
  assert.equal(result.ok, false);
});

test("rejects null or wrongly-typed collections", () => {
  const nulled = parseLedgerState(base({ transactions: null }));
  assert.equal(nulled.ok, false);
  const wrongType = parseLedgerState(base({ payments: { not: "an array" } }));
  assert.equal(wrongType.ok, false);
});

test("rejects unknown top-level financial records instead of discarding them", () => {
  const result = parseLedgerState(base({ debt_accounts: [{ id: "x", balance_cents: 100 }] }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /unsupported fields/);
});

test("rejects unknown debt-related fields inside a row", () => {
  const result = parseLedgerState(
    base({
      liabilities: [
        {
          id: "l1",
          name: "Card",
          balance_cents: 100,
          apr_basis_points: 1999,
          min_payment_cents: 10,
          secret_extra_balance_cents: 50,
        },
      ],
    })
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /unsupported fields/);
});

test("rejects duplicate liability identifiers", () => {
  const liability = {
    id: "l1",
    name: "Card",
    balance_cents: 100,
    apr_basis_points: 1999,
    min_payment_cents: 10,
  };
  const result = parseLedgerState(base({ liabilities: [liability, { ...liability }] }));
  assert.equal(result.ok, false);
});

test("rejects duplicate bill-occurrence identifiers", () => {
  const result = parseLedgerState(
    base({
      payments: [
        { id: "p1", name: "Rent", amount_cents: 100, recurrence: "Monthly", due_day: 1 },
      ],
      bill_occurrences: [
        { id: "o1", payment_id: "p1", due_date: "2026-10-01", paid: false },
        { id: "o1", payment_id: "p1", due_date: "2026-11-01", paid: false },
      ],
    })
  );
  assert.equal(result.ok, false);
});

test("rejects fractional cents", () => {
  const result = parseLedgerState(
    base({
      current_balance_cents: 1.5,
      transactions: [{ id: 1, amount_cents: 1.5, type: "Income", date: "2026-10-01" }],
    })
  );
  assert.equal(result.ok, false);
});

test("rejects an occurrence with an invalid transaction reference", () => {
  const result = parseLedgerState(
    base({
      payments: [
        { id: "p1", name: "Rent", amount_cents: 100, recurrence: "Monthly", due_day: 1 },
      ],
      bill_occurrences: [
        { id: "o1", payment_id: "p1", due_date: "2026-10-01", paid: true, transaction_id: "nope" },
      ],
    })
  );
  assert.equal(result.ok, false);
});

test("rejects a future unsupported snapshot version", () => {
  assert.equal(parseLedgerState(base({ version: "3.0" })).ok, false);
});

test("rejects liability amounts that are not non-negative integers", () => {
  const result = parseLedgerState(
    base({
      liabilities: [
        {
          id: "l1",
          name: "Card",
          balance_cents: 1.5,
          apr_basis_points: 1999,
          min_payment_cents: 100,
        },
      ],
    })
  );
  assert.equal(result.ok, false);
});
