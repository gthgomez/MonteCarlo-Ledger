import { expect, test } from "@playwright/test";
import { DEFAULT_ASSUMPTIONS } from "../src/lib/assumptions";
import type { LedgerState, PaymentItem } from "../src/lib/types";

// Synthetic financial-review fixtures for the two guidance defects:
// 1. a past one-time bill with no stored occurrence must withhold cautious advice
//    until it is marked paid or moved in Bills;
// 2. a known one-time bill after the half-open window is informational and must
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

function ledger(payments: PaymentItem[]): LedgerState {
  return {
    version: "2.0",
    updated_at: "2026-11-10T12:00:00.000Z",
    current_balance_cents: 100_000,
    incomes: [],
    payments,
    transactions: [{
      id: "tx-open",
      amount_cents: 100_000,
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
  await page.addInitScript(({ ledgerState, assumptions, ledgerKey, assumptionsKey }) => {
    localStorage.setItem(ledgerKey, JSON.stringify(ledgerState));
    localStorage.setItem(assumptionsKey, JSON.stringify(assumptions));
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

test("a past one-time bill withholds advice and can be resolved in Bills", async ({ page }) => {
  const repair: PaymentItem = {
    id: "repair",
    name: "Car repair",
    amount_cents: 90_000,
    recurrence: "One-time",
    due_date: "2026-11-09",
  };
  await seed(page, ledger([repair, subscription]));

  // The known $10 in-window bill still appears in the plan, but the cautious
  // amount is withheld because the $900 slot has no stored occurrence.
  await expect(page.getByText(/Car repair.*\$900\.00.*Nov 9, 2026/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Cautious amount to spend" })).toHaveCount(0);
  await expect(page.getByText("Calculation Failed")).toHaveCount(0);

  await page.getByRole("button", { name: "Bills", exact: true }).click();
  await expect(page.getByText("1 past-due unpaid bill")).toBeVisible();
  await expect(page.getByText(/one-time bill with no recorded occurrence is not in the plan/)).toBeVisible();
  const row = page.locator('li[aria-label="Car repair due Nov 9, 2026"]');
  await expect(row).toBeVisible();
  await expect(row).toContainText("$900.00");
  await row.getByRole("button", { name: "Mark paid" }).click();
  await expect(row).toHaveCount(0);

  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), LEDGER_KEY);
  expect(saved.current_balance_cents).toBe(10_000);
  expect(saved.bill_occurrences).toEqual([
    expect.objectContaining({ payment_id: "repair", due_date: "2026-11-09", paid: true }),
  ]);

  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Cautious amount to spend" })).toBeVisible();
  await expect(page.getByText(/Car repair.*no recorded payment/)).toHaveCount(0);
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
