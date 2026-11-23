import { expect, test } from "@playwright/test";
import { DEFAULT_ASSUMPTIONS } from "../src/lib/assumptions";
import type { LedgerState, PaymentItem, TransactionItem } from "../src/lib/types";

// Synthetic financial-review fixtures for the guidance and bill-resolution paths:
// 1. a past one-time bill with no linked record withholds cautious advice until a
//    person links an already-posted expense or records a new one in Bills;
// 2. when a matching posted expense exists, linking it must not add a second debit
//    (this was the duplicate-debit defect);
// 3. a known one-time bill after the half-open window is informational and must
//    not withhold in-window guidance.
//
// Amounts and dates are hand-entered; no live service, bank value, or real
// household is involved.

const AS_OF = "2026-11-10";
const LEDGER_KEY = "montecarlo_ledger_state_v2";
const ASSUMPTIONS_KEY = "montecarlo_financial_assumptions";

const ASSUMPTIONS = {
  ...DEFAULT_ASSUMPTIONS,
  horizonDays: 30,
  runs: 10,
  surpriseProbabilityPpm: 0,
  expenseVariationMin: 0,
  expenseVariationMax: 0,
  reserveCents: 0,
};

test.use({ timezoneId: "UTC", locale: "en-US", reducedMotion: "reduce" });

function ledger(
  payments: PaymentItem[],
  options: { balanceCents?: number; transactions?: TransactionItem[] } = {}
): LedgerState {
  return {
    version: "2.0",
    updated_at: "2026-11-10T12:00:00.000Z",
    current_balance_cents: options.balanceCents ?? 190_000,
    incomes: [],
    payments,
    transactions: options.transactions ?? [{
      id: "tx-open",
      amount_cents: 190_000,
      category: "Opening",
      type: "Adjustment",
      date: "2026-11-01",
      description: "Opening balance",
    }],
    bill_occurrences: [],
    liabilities: [],
  };
}

async function seed(page: import("@playwright/test").Page, state: LedgerState): Promise<void> {
  await page.clock.setFixedTime(new Date(`${AS_OF}T12:00:00Z`));
  // Seed only an empty browser so a reload after saving keeps the saved ledger.
  await page.addInitScript(({ ledgerState, assumptions, ledgerKey, assumptionsKey }) => {
    if (localStorage.getItem(ledgerKey) === null) localStorage.setItem(ledgerKey, JSON.stringify(ledgerState));
    if (localStorage.getItem(assumptionsKey) === null) localStorage.setItem(assumptionsKey, JSON.stringify(assumptions));
  }, { ledgerState: state, assumptions: ASSUMPTIONS, ledgerKey: LEDGER_KEY, assumptionsKey: ASSUMPTIONS_KEY });
  await page.goto("/");
}

const subscription: PaymentItem = {
  id: "subscription",
  name: "Subscription",
  amount_cents: 1_000,
  recurrence: "Monthly",
  due_day: 15,
};

const repair: PaymentItem = {
  id: "repair",
  name: "Car repair",
  amount_cents: 90_000,
  recurrence: "One-time",
  due_date: "2026-11-09",
};

test("a past one-time bill can link an already-posted expense without a second debit", async ({ page }) => {
  // $1,900 opening cash and a posted -$900 repair already leave $1,000.
  await seed(page, ledger([repair, subscription], {
    balanceCents: 100_000,
    transactions: [
      {
        id: "tx-open", amount_cents: 190_000, category: "Opening", type: "Adjustment",
        date: "2026-11-01", description: "Opening balance",
      },
      {
        id: "tx-repair", amount_cents: -90_000, category: "Bills", type: "Expense",
        date: "2026-11-08", description: "Car repair",
      },
    ],
  }));

  // The in-window $10 bill is known, but cautious advice waits for the link.
  await expect(page.getByText(/Car repair.*\$900\.00.*Nov 9, 2026/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Cautious amount to spend" })).toHaveCount(0);
  const guidance = page.getByText(/has no linked bill record/).first();
  await expect(guidance).toBeVisible();
  await expect(guidance).toContainText(/not that no payment was made/);
  await expect(page.getByText("Calculation Failed")).toHaveCount(0);

  await page.getByRole("button", { name: "Bills", exact: true }).click();
  await expect(page.getByText("1 past-due bill to review")).toBeVisible();
  await expect(page.getByText(/one-time bill with no linked bill record is not in the plan/)).toBeVisible();
  const row = page.locator('li[aria-label="Car repair due Nov 9, 2026"]');
  await expect(row).toBeVisible();
  await expect(row).toContainText("$900.00");

  // A matching posted expense exists, so posting a second one requires explicit confirmation.
  const recordNew = row.getByRole("button", { name: "Record new expense" });
  await expect(recordNew).toBeDisabled();
  const confirm = row.getByRole("checkbox", { name: /have not recorded the payment in Money/ });
  await confirm.check();
  await expect(recordNew).toBeEnabled();
  await confirm.uncheck();

  await row.getByLabel("Recorded expense for Car repair due Nov 9, 2026").selectOption("tx-repair");
  await row.getByRole("button", { name: "Link recorded expense" }).click();
  await expect(row).toHaveCount(0);

  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), LEDGER_KEY);
  // Linking keeps the same cash, the same two transactions, and the same ids.
  expect(saved.current_balance_cents).toBe(100_000);
  expect(saved.transactions).toHaveLength(2);
  expect(saved.transactions.map((tx: TransactionItem) => tx.id)).toEqual(["tx-open", "tx-repair"]);
  expect(saved.transactions[1]).toMatchObject({ amount_cents: -90_000, date: "2026-11-08" });
  expect(saved.bill_occurrences).toEqual([{
    id: "occ-1",
    payment_id: "repair",
    due_date: "2026-11-09",
    paid: true,
    transaction_id: "tx-repair",
    original_due_date: "2026-11-09",
    is_user_modified: false,
  }]);

  await page.reload();
  await page.getByRole("button", { name: "Bills", exact: true }).click();
  await expect(page.locator('li[aria-label="Car repair due Nov 9, 2026"]')).toHaveCount(0);
  const reloaded = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), LEDGER_KEY);
  expect(reloaded.current_balance_cents).toBe(100_000);
  expect(reloaded.transactions).toHaveLength(2);
  expect(reloaded.bill_occurrences[0].id).toBe("occ-1");
  expect(reloaded.bill_occurrences[0].transaction_id).toBe("tx-repair");

  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Cautious amount to spend" })).toBeVisible();
  await expect(page.getByText(/has no linked bill record/)).toHaveCount(0);
});

test("a past one-time bill with no recorded expense posts exactly once", async ({ page }) => {
  await seed(page, ledger([repair, subscription], {
    balanceCents: 100_000,
    transactions: [{
      id: "tx-open", amount_cents: 100_000, category: "Opening", type: "Adjustment",
      date: "2026-11-01", description: "Opening balance",
    }],
  }));

  await expect(page.getByRole("heading", { name: "Cautious amount to spend" })).toHaveCount(0);
  await page.getByRole("button", { name: "Bills", exact: true }).click();
  const row = page.locator('li[aria-label="Car repair due Nov 9, 2026"]');
  await expect(row).toBeVisible();
  await expect(row.getByLabel(/^Recorded expense for/)).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Record new expense" })).toBeDisabled();
  await row.getByRole("checkbox", { name: /have not recorded the payment in Money/ }).check();
  await row.getByRole("button", { name: "Record new expense" }).click();
  await expect(row).toHaveCount(0);

  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), LEDGER_KEY);
  expect(saved.current_balance_cents).toBe(10_000);
  expect(saved.transactions).toHaveLength(2);
  expect(saved.transactions[1]).toMatchObject({
    id: "tx-2", amount_cents: -90_000, type: "Expense", date: "2026-11-10", description: "Car repair",
  });
  expect(saved.bill_occurrences).toEqual([{
    id: "occ-1",
    payment_id: "repair",
    due_date: "2026-11-09",
    paid: true,
    transaction_id: "tx-2",
    original_due_date: "2026-11-09",
    is_user_modified: false,
  }]);

  await page.reload();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Cautious amount to spend" })).toBeVisible();
  await expect(page.getByText(/has no linked bill record/)).toHaveCount(0);
  const reloaded = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), LEDGER_KEY);
  expect(reloaded.current_balance_cents).toBe(10_000);
  expect(reloaded.transactions).toHaveLength(2);
  expect(reloaded.bill_occurrences[0].transaction_id).toBe("tx-2");
});

test("a one-time bill after the window is informational without withholding advice", async ({ page }) => {
  const laterRepair: PaymentItem = {
    id: "repair-later",
    name: "Car repair",
    amount_cents: 90_000,
    recurrence: "One-time",
    due_date: "2026-12-15",
  };
  await seed(page, ledger([subscription, laterRepair]));

  await expect(page.getByText("A bill is outside the plan window")).toBeVisible();
  await expect(page.getByText(/Car repair.*\$900\.00.*Dec 15, 2026/)).toBeVisible();
  await expect(page.getByText(/Extend the plan window under Advanced/)).toBeVisible();
  // The in-window $10 bill still lets the cautious estimate use this 30-day window.
  await expect(page.getByRole("heading", { name: "Cautious amount to spend" })).toBeVisible();
  await expect(page.getByText("Calculation Failed")).toHaveCount(0);
});
