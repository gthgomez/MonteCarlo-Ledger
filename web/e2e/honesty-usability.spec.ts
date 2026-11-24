import { expect, test, type Page } from "@playwright/test";

import { LEDGER_STORAGE_KEY } from "../src/lib/persistence";
import { SAMPLE_LEDGER_STATE, type LedgerState } from "../src/lib/types";

/**
 * Honesty and beginner-navigation regressions:
 * - sample data stays labelled after an edit and reload;
 * - a past "next payday" is not shown as if it were next;
 * - debt minimums are not presented as entered bills or linked to a dead-end action.
 */

function syntheticLedger(overrides: Partial<LedgerState> = {}): LedgerState {
  const opening = 100_000;
  return {
    version: "2.2",
    updated_at: "2026-11-01T00:00:00.000Z",
    current_balance_cents: opening,
    incomes: [],
    payments: [],
    transactions: [
      {
        id: "tx-opening",
        amount_cents: opening,
        category: "Adjustment",
        type: "Adjustment",
        date: "2026-11-01",
        description: "Opening balance",
      },
    ],
    bill_occurrences: [],
    liabilities: [],
    ...overrides,
  };
}

async function seed(page: Page, ledger: LedgerState): Promise<void> {
  await page.goto("/");
  await page.evaluate(
    ({ key, value }) => {
      localStorage.setItem(key, JSON.stringify(value));
      localStorage.removeItem("montecarlo_demo_mode_v1");
    },
    { key: LEDGER_STORAGE_KEY, value: ledger }
  );
  await page.reload();
}

test("sample data stays labelled after an edit and after reload", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Demo data — not your finances.")).toBeVisible();
  await page.getByRole("button", { name: "Bills", exact: true }).click();
  await page.getByLabel("Bill name").fill("Sample edit");
  await page.getByLabel("Amount ($)").fill("10");
  await page.getByLabel("Due day (1-31)").fill("15");
  await page.getByRole("button", { name: "Add Recurring Bill" }).click();
  await expect(page.getByText("Sample edit").first()).toBeVisible();

  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByText("Demo data — not your finances.")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Demo data — not your finances.")).toBeVisible();
});

test("sample data cannot be pushed as the person's ledger", async ({ page }) => {
  const vaultCalls: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/vault")) vaultCalls.push(request.url());
  });
  await page.goto("/");
  await page.getByRole("button", { name: /Cloud Vault/ }).click();
  await page.getByLabel("Vault Identifier").fill("e2e-demo-not-uploaded");
  await page.getByLabel("Vault Secret Passphrase").fill("synthetic demo guard passphrase");
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "Push (Upload)" }).click();
  await expect(page.getByText("Push cancelled. Sample data was not sent.")).toBeVisible();
  expect(vaultCalls).toEqual([]);
});

test("a past next-payday date is not labelled as next", async ({ page }) => {
  await seed(
    page,
    syntheticLedger({
      incomes: [
        {
          id: "inc-stale",
          name: "Old payday",
          amount_cents: 200000,
          frequency: "Monthly",
          last_payday: "2020-01-15",
          next_payday: "2020-02-15",
        },
      ],
    })
  );
  await page.getByRole("button", { name: "Money", exact: true }).click();
  await expect(page.getByText(/entered date .* has passed/)).toBeVisible();
  await expect(page.getByText(/next Feb 15, 2020/)).toHaveCount(0);
});

test("a debt minimum is identified as a Plan obligation, not an entered bill", async ({ page }) => {
  await seed(
    page,
    syntheticLedger({
      liabilities: [
        {
          id: "debt-card",
          name: "Card",
          balance_cents: 100000,
          apr_basis_points: 0,
          min_payment_cents: 30000,
          kind: "installment",
          due_day_of_month: 20,
        },
      ],
    })
  );
  await expect(page.getByText(/Card minimum payment is due/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Review debt" })).toBeVisible();
  await page.getByRole("button", { name: "Bills", exact: true }).click();
  await expect(page.getByText(/required debt minimum/).first()).toBeVisible();
  await expect(page.getByText(/These amounts come from the balance, minimum payment, and due day recorded in Plan/)).toBeVisible();
});

test("the page has one h1 and a visible-name Sync control", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "MonteCarlo" })).toHaveCount(1);
  const sync = page.getByRole("button", { name: /Cloud Vault/ });
  await expect(sync).toHaveText("Cloud Vault");
});

test("the Home lead describes the same horizon as the cautious amount", async ({ page }) => {
  const due = new Date();
  due.setDate(due.getDate() + 60);
  const dueIso = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, "0")}-${String(due.getDate()).padStart(2, "0")}`;
  await seed(
    page,
    syntheticLedger({
      payments: [
        { id: "pmt-later", name: "Later annual bill", amount_cents: 250000, recurrence: "One-time", due_date: dueIso },
      ],
    })
  );
  await expect(page.getByText(/Known bills( and required debt payments)? in the next 90 days total/)).toBeVisible();
  await expect(page.getByText(/With nothing scheduled/)).toHaveCount(0);
  await expect(page.getByText("The next 30 days, if the schedule is exact")).toBeVisible();
  await expect(page.getByText(/No payments or income are scheduled in this period/)).toBeVisible();
});

test("a non-P10 rank is not called cautious", async ({ page }) => {
  await seed(
    page,
    syntheticLedger({
      payments: [
        { id: "pmt-small", name: "Small bill", amount_cents: 10000, recurrence: "Monthly", due_day: 15 },
      ],
    })
  );
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await page.getByLabel(/Low-point rank used for the cautious amount/).selectOption("9/10");
  await page.getByRole("button", { name: "Update results" }).click();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByText("This is not the cautious P10 amount")).toBeVisible();
  await expect(page.getByText("Optimistic modeled amount").first()).toBeVisible();
  await expect(page.getByText(/About 90% of modeled low points are at or below it/)).toBeVisible();
});
