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

  // A matching posted expense exists, but a new debit still requires choosing that
  // treatment and explicitly confirming the payment is not already reflected.
  await row.getByRole("radio", { name: /not recorded in Money and my current cash does not include it/ }).check();
  const recordNew = row.getByRole("button", { name: "Record new expense" });
  await expect(recordNew).toBeDisabled();
  const confirm = row.getByRole("checkbox", { name: /I confirm this payment is not already recorded/ });
  await confirm.check();
  await expect(recordNew).toBeEnabled();
  await confirm.uncheck();

  await row.getByRole("radio", { name: /already recorded in Money/ }).check();
  const expense = row.getByLabel("Recorded expense for Car repair due Nov 9, 2026");
  await expense.selectOption("tx-repair");
  await row.getByRole("radio", { name: /already reflected in the cash I have now/ }).check();
  await row.getByRole("radio", { name: /already recorded in Money/ }).check();
  await expect(expense).toHaveValue("tx-repair");
  const [removePrompt] = await Promise.all([
    page.waitForEvent("dialog").then(async (dialog) => {
      const message = dialog.message();
      await dialog.dismiss();
      return message;
    }),
    page.getByRole("button", { name: "Remove Car repair", exact: true }).click(),
  ]);
  expect(removePrompt).toMatch(/discards its unsaved drafts/i);
  await expect(expense).toHaveValue("tx-repair");
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
  await expect(row.getByRole("radio", { name: /already recorded in Money/ })).toBeDisabled();
  await expect(row.getByLabel(/^Recorded expense for/)).toHaveCount(0);
  await row.getByRole("radio", { name: /not recorded in Money and my current cash does not include it/ }).check();
  await expect(row.getByRole("button", { name: "Record new expense" })).toBeDisabled();
  await row.getByRole("checkbox", { name: /I confirm this payment is not already recorded/ }).check();
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

test("cash already reflecting a past payment marks the bill paid without a new debit", async ({ page }) => {
  // Normal onboarding: $1,000 is the only cash entry and already reflects a
  // prior $900 repair, so no separate Expense exists. A future $10 subscription
  // keeps a known in-window bill on the schedule.
  await page.clock.setFixedTime(new Date(`${AS_OF}T12:00:00Z`));
  await page.addInitScript(({ assumptions, assumptionsKey }) => {
    if (localStorage.getItem(assumptionsKey) === null) {
      localStorage.setItem(assumptionsKey, JSON.stringify(assumptions));
    }
  }, { assumptions: ASSUMPTIONS, assumptionsKey: ASSUMPTIONS_KEY });
  await page.goto("/");

  await page.getByRole("button", { name: "Enter my own numbers" }).click();
  await page.getByLabel("Money you have now ($)").fill("1000");
  await page.getByLabel("A regular bill").fill("Subscription");
  await page.getByLabel("Bill amount ($)").fill("10");
  await page.getByLabel("Due day").fill("15");
  await page.getByRole("button", { name: "Save and show my plan" }).click();
  await expect(page.getByRole("heading", { name: "Your numbers" })).toHaveCount(0);

  const onboarded = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), LEDGER_KEY);
  expect(onboarded.current_balance_cents).toBe(100_000);
  expect(onboarded.transactions).toHaveLength(1);
  expect(onboarded.transactions[0]).toMatchObject({
    id: "tx-open", amount_cents: 100_000, type: "Adjustment", date: AS_OF,
  });
  expect(onboarded.payments).toHaveLength(1);
  expect(onboarded.bill_occurrences).toEqual([]);

  // Enter the overdue one-time bill through the ordinary Add Bill form.
  await page.getByRole("button", { name: "Bills", exact: true }).click();
  await page.getByLabel("Bill name").fill("Car repair");
  await page.getByLabel("Amount ($)").fill("900");
  await page.getByLabel("How often").selectOption("One-time");
  await page.getByLabel("Next date").fill("2026-11-09");
  await page.getByRole("button", { name: "Add Recurring Bill" }).click();

  const row = page.locator('li[aria-label="Car repair due Nov 9, 2026"]');
  await expect(row).toBeVisible();
  await expect(row).toContainText("$900.00");
  const before = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), LEDGER_KEY);
  expect(before.current_balance_cents).toBe(100_000);
  expect(before.transactions).toHaveLength(1);
  expect(before.bill_occurrences).toEqual([]);

  // All three treatments are visible, but neither paid action exists until the
  // person explicitly selects one.
  await expect(row.getByRole("radio")).toHaveCount(3);
  await expect(row.getByRole("button", { name: "Mark paid without new expense" })).toHaveCount(0);
  await expect(row.getByRole("button", { name: "Record new expense" })).toHaveCount(0);

  // The second treatment is explicit: cash already reflects this payment, so
  // record only the paid occurrence and add no transaction or balance change.
  await row.getByRole("radio", { name: /already reflected in the cash I have now/ }).check();
  await row.getByRole("button", { name: "Mark paid without new expense" }).click();
  await expect(row).toHaveCount(0);

  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), LEDGER_KEY);
  expect(saved.current_balance_cents).toBe(100_000);
  expect(saved.transactions).toHaveLength(1);
  expect(saved.transactions[0].id).toBe("tx-open");
  expect(saved.bill_occurrences).toEqual([{
    id: "occ-1",
    payment_id: "pmt-2",
    due_date: "2026-11-09",
    paid: true,
    transaction_id: null,
    original_due_date: "2026-11-09",
    is_user_modified: false,
  }]);
  expect(saved.bill_occurrences[0].transaction_id).toBeNull();

  // Reload proves the snapshot-compatible null link and identical cash survive.
  await page.reload();
  await page.getByRole("button", { name: "Bills", exact: true }).click();
  await expect(page.locator('li[aria-label="Car repair due Nov 9, 2026"]')).toHaveCount(0);
  const reloaded = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), LEDGER_KEY);
  expect(reloaded.current_balance_cents).toBe(100_000);
  expect(reloaded.transactions).toHaveLength(1);
  expect(reloaded.bill_occurrences[0]).toEqual(saved.bill_occurrences[0]);

  // The resolved bill no longer withholds guidance, and the upcoming subscription
  // keeps the cautious estimate available for this window.
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Cautious amount to spend" })).toBeVisible();
  await expect(page.getByText(/has no linked bill record/)).toHaveCount(0);
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
