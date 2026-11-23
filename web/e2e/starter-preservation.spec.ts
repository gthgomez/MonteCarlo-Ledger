import { expect, test, type Locator, type Page } from "@playwright/test";

import { LEDGER_STORAGE_KEY } from "../src/lib/persistence";
import type { LedgerState } from "../src/lib/types";

/**
 * P1: Home must not offer the demo starter form to an existing or restored
 * ledger that simply has no saved paycheck/bill schedule. The only replacement
 * route is the demo notice. A real ledger gets ordinary navigation to Money and
 * Bills, which add a schedule without replacing its recorded entries.
 */
const AS_OF = "2026-11-23";
const CLOCK = new Date("2026-11-23T15:00:00.000Z");

test.use({
  timezoneId: "UTC",
  locale: "en-US",
});

function metric(page: Page, label: string): Locator {
  return page.getByRole("heading", { name: label, exact: true }).locator("..");
}

async function expectMoneyNow(page: Page, value: string): Promise<void> {
  await expect(metric(page, "Money available now").locator("p").first()).toHaveText(value);
}

async function readLedger(page: Page): Promise<LedgerState> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), LEDGER_STORAGE_KEY);
}

async function openSection(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name, exact: true }).click();
}

async function expectNoStarterReplacement(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Enter my own numbers" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Your numbers" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save and show my plan" })).toHaveCount(0);
  await expect(page.getByLabel("Money you have now ($)")).toHaveCount(0);
}

function importedLedger(): LedgerState {
  return {
    version: "2.0",
    updated_at: "2026-11-20T12:00:00.000Z",
    current_balance_cents: 84_500,
    incomes: [],
    payments: [],
    transactions: [
      {
        id: "import-opening",
        amount_cents: 100_000,
        category: "Adjustment",
        type: "Adjustment",
        date: "2026-11-01",
        description: "Imported opening balance",
      },
      {
        id: "import-groceries",
        amount_cents: -15_500,
        category: "Groceries",
        type: "Expense",
        date: "2026-11-10",
        description: "Imported groceries",
      },
    ],
    bill_occurrences: [],
    liabilities: [
      {
        id: "import-debt",
        name: "Imported loan",
        balance_cents: 25_000,
        apr_basis_points: 0,
        min_payment_cents: 5_000,
        kind: "installment",
        due_day_of_month: 20,
      },
    ],
  };
}

test("Home adds a paycheck without replacing a cash-only ledger's saved expense or debt", async ({
  page,
}) => {
  await page.clock.install({ time: CLOCK });
  await page.goto("/");

  // Fresh profile: the in-memory demo is the only starting point. Entering the
  // person's own opening balance is the deliberate replacement path.
  await expect(page.getByText(/Demo data — not your finances/)).toBeVisible();
  await page.getByRole("button", { name: "Enter my own numbers" }).click();
  await page.getByLabel("Money you have now ($)").fill("1000");
  await page.getByRole("button", { name: "Save and show my plan" }).click();
  await expect(page.getByText(/Demo data — not your finances/)).toHaveCount(0);
  await expectMoneyNow(page, "$1,000.00");

  const openingTransactions = (await readLedger(page)).transactions;
  expect(openingTransactions).toHaveLength(1);
  expect(openingTransactions[0]).toMatchObject({
    amount_cents: 100_000,
    type: "Adjustment",
    date: AS_OF,
    description: "Opening balance",
  });

  // Record one ordinary expense through the real Money controls.
  await openSection(page, "Money");
  await page.getByLabel("Amount ($)", { exact: true }).fill("50");
  await page.getByLabel("Category").fill("Groceries");
  await page.getByLabel("Date", { exact: true }).fill(AS_OF);
  await page.getByLabel("Note").fill("Fifty dollar expense");
  await page.getByRole("button", { name: "Record this" }).click();
  await expect(page.getByText("Fifty dollar expense")).toBeVisible();

  // Add an independent debt through the real Plan controls.
  await openSection(page, "Plan");
  await page.getByRole("tab", { name: /How do I pay off debt/ }).click();
  await page.getByLabel("Debt name").fill("Small independent debt");
  await page.getByLabel("Amount still owed ($)").fill("120");
  await page.getByLabel("Interest rate (%)").fill("0");
  await page.getByLabel("Minimum payment ($)").fill("10");
  await page.getByLabel(/Usual payment day/).fill("18");
  await page.getByRole("button", { name: "Add debt" }).click();
  await expect(page.getByRole("button", { name: "Remove Small independent debt" })).toBeVisible();
  const beforeSchedule = await readLedger(page);

  // Home must show non-destructive schedule actions, not the starter form.
  await openSection(page, "Home");
  await expectMoneyNow(page, "$950.00");
  await expectNoStarterReplacement(page);
  await expect(page.getByRole("button", { name: "Add a paycheck" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add a bill" })).toBeVisible();

  // Follow the paycheck route and add a schedule through Money.
  await page.getByRole("button", { name: "Add a paycheck" }).click();
  await expect(page.getByRole("heading", { name: "Paychecks you expect" })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Test paycheck");
  await page.getByLabel("Take-home amount ($)").fill("300");
  await page.getByLabel("How often").selectOption("Bi-weekly");
  await page.getByLabel("Next payday").fill(AS_OF);
  await page.getByRole("button", { name: "Add income" }).click();
  await expect(page.getByText("Test paycheck", { exact: true })).toBeVisible();

  await openSection(page, "Home");
  await expectMoneyNow(page, "$950.00");

  // Everything recorded before the route is still exact after a reload, and the
  // new paycheck is stored alongside it.
  await page.reload();
  await expectMoneyNow(page, "$950.00");
  await expectNoStarterReplacement(page);
  const saved = await readLedger(page);
  expect(saved.current_balance_cents).toBe(95_000);
  expect(saved.transactions).toEqual(beforeSchedule.transactions);
  expect(saved.liabilities).toEqual(beforeSchedule.liabilities);
  expect(saved.transactions).toHaveLength(2);
  expect(saved.transactions[0]).toEqual(openingTransactions[0]);
  expect(saved.transactions[1]).toMatchObject({
    amount_cents: -5_000,
    category: "Groceries",
    type: "Expense",
    date: AS_OF,
    description: "Fifty dollar expense",
  });
  expect(saved.liabilities).toHaveLength(1);
  expect(saved.liabilities[0]).toMatchObject({
    name: "Small independent debt",
    balance_cents: 12_000,
    apr_basis_points: 0,
    min_payment_cents: 1_000,
    kind: "installment",
    due_day_of_month: 18,
  });
  expect(saved.incomes).toHaveLength(1);
  expect(saved.incomes[0]).toMatchObject({
    name: "Test paycheck",
    amount_cents: 30_000,
    frequency: "Bi-weekly",
    next_payday: AS_OF,
  });
});

test("a normal JSON import with transactions and debt but no schedule opens the safe Home routes, not a replacement", async ({
  page,
}) => {
  const imported = importedLedger();
  await page.clock.install({ time: CLOCK });
  await page.goto("/");

  // Use the ordinary Sync import surface with a separate, valid synthetic
  // ledger. No storage injection and no real vault is involved.
  await page.getByRole("button", { name: /Cloud Vault/ }).click();
  await page.getByRole("button", { name: "Local JSON Backup" }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "synthetic-imported-ledger.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(imported)),
  });
  await expect(page.getByText("Successfully imported ledger backup file!")).toBeVisible();
  await page.getByRole("button", { name: "Close synchronization" }).click();

  await expectMoneyNow(page, "$845.00");
  await expectNoStarterReplacement(page);
  await expect(page.getByRole("button", { name: "Add a paycheck" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add a bill" })).toBeVisible();

  const restored = await readLedger(page);
  expect(restored).toEqual(imported);

  // Both Home routes are ordinary navigation to the existing editors. Visiting
  // them must not replace or reconcile the imported ledger.
  await page.getByRole("button", { name: "Add a paycheck" }).click();
  await expect(page.getByRole("heading", { name: "Paychecks you expect" })).toBeVisible();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("");
  await openSection(page, "Home");
  expect(await readLedger(page)).toEqual(restored);

  await page.getByRole("button", { name: "Add a bill" }).click();
  await expect(page.getByRole("heading", { name: "Recurring bills" })).toBeVisible();
  await page.getByLabel("Bill name").fill("Imported rent");
  await page.getByLabel("Amount ($)", { exact: true }).fill("250");
  await page.getByLabel("Due day (1-31)").fill("5");
  await page.getByRole("button", { name: "Add Recurring Bill" }).click();
  await expect(page.getByRole("button", { name: "Remove Imported rent" })).toBeVisible();

  await openSection(page, "Home");
  await expectMoneyNow(page, "$845.00");

  // The imported transactions, debt, and cash remain exact through reload. The
  // newly added bill is scheduled; it does not become a second cash debit.
  await page.reload();
  await expectMoneyNow(page, "$845.00");
  await expectNoStarterReplacement(page);
  const saved = await readLedger(page);
  expect(saved.current_balance_cents).toBe(84_500);
  expect(saved.transactions).toEqual(restored.transactions);
  expect(saved.liabilities).toEqual(restored.liabilities);
  expect(saved.incomes).toEqual([]);
  expect(saved.payments).toHaveLength(1);
  expect(saved.payments[0]).toMatchObject({
    name: "Imported rent",
    amount_cents: 25_000,
    due_day: 5,
    recurrence: "Monthly",
  });
});
