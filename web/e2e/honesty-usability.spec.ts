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
    ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
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
  await expect(page.getByText(/required debt minimum from Plan/).first()).toBeVisible();
  await expect(page.getByText(/A debt minimum comes from the balance, minimum payment, and due day recorded in Plan/)).toBeVisible();
});

test("the page has one h1 and a visible-name Sync control", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "MonteCarlo" })).toHaveCount(1);
  const sync = page.getByRole("button", { name: /Cloud Vault/ });
  await expect(sync).toHaveText("Cloud Vault");
});
