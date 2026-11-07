import { expect, test } from "@playwright/test";
import { LedgerState } from "../src/lib/types";
import { SAMPLE_LEDGER_STATE } from "../src/lib/types";

// A stored ledger with a zero-amount bill. Validation now rejects it at load time,
// before any financial number is computed, and never substitutes the demo ledger.
function invalidStoredState(): LedgerState {
  return {
    ...SAMPLE_LEDGER_STATE,
    payments: [
      {
        id: "pmt-broken",
        name: "Broken Bill",
        amount_cents: 0,
        due_day: 5,
        recurrence: "Monthly",
      },
    ],
  };
}

// A structurally valid ledger whose arithmetic overflows the supported money range.
// It passes import validation, then the canonical engine rejects it with MONEY_OVERFLOW.
function overflowState(): LedgerState {
  return {
    version: "2.0",
    updated_at: "2026-11-07T00:00:00.000Z",
    current_balance_cents: Number.MAX_SAFE_INTEGER,
    incomes: [
      {
        id: "inc-overflow",
        name: "Overflow Pay",
        amount_cents: 1_000_000,
        frequency: "Monthly",
        last_payday: "2026-10-10",
        next_payday: "2026-11-10",
      },
    ],
    payments: [],
    transactions: [
      {
        id: "tx-balance",
        amount_cents: Number.MAX_SAFE_INTEGER,
        category: "Adjustment",
        type: "Adjustment",
        date: "2026-10-01",
        description: "Opening",
      },
    ],
    bill_occurrences: [],
    liabilities: [],
  };
}

test.describe("dashboard loads with synthetic sample data", () => {
  test("hero renders canonical safe-to-spend, not an error screen", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Safe to Spend (P10)")).toBeVisible();
    await expect(page.getByText("Calculation Failed")).toHaveCount(0);
    // The hero must show a real dollar figure, not a placeholder or zero-fill.
    await expect(page.getByText(/\$[\d,]/).first()).toBeVisible();
  });

  test("decision studio shows the fragility-impact panel (what-if wired)", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Impact On Your Fragility Floor")).toBeVisible();
    await expect(page.getByText("Overdraft Risk:")).toBeVisible();
  });
});

test.describe("fail-closed surfaces", () => {
  test("invalid stored data is reported and never replaced by demo numbers", async ({ page }) => {
    await page.addInitScript((state) => {
      window.localStorage.setItem("montecarlo_ledger_state_v2", JSON.stringify(state));
    }, invalidStoredState());
    await page.goto("/");
    await expect(page.getByText("Saved Ledger Not Loaded")).toBeVisible();
    await expect(page.getByText(/could not be loaded/)).toBeVisible();
    // No dashboard numbers are shown for an unvalidated ledger.
    await expect(page.getByText("Safe to Spend (P10)")).toHaveCount(0);
    await expect(page.getByText("Download raw data")).toBeVisible();
    // Replacement requires the explicit button and confirmation.
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByText("Replace with sample data (explicit)").click();
    await expect(page.getByText("Safe to Spend (P10)")).toBeVisible();
    await expect(page.getByText(/Demo data — not your finances/)).toBeVisible();
  });

  test("a valid ledger that overflows the engine fails closed, never zeros", async ({ page }) => {
    await page.addInitScript((state) => {
      window.localStorage.setItem("montecarlo_ledger_state_v2", JSON.stringify(state));
    }, overflowState());
    await page.goto("/");
    await expect(page.getByText("Calculation Failed")).toBeVisible();
    await expect(page.getByText("MONEY_OVERFLOW").first()).toBeVisible();
    await expect(page.getByText("Reset to sample data")).toBeVisible();
  });
});

test.describe("decision studio journeys", () => {
  test("purchase scenario is labelled as a model estimate, never a guarantee", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText(/^Purchase Amount:/)).toBeVisible();
    await page.locator('input[type="range"]').first().press("End");
    await expect(page.getByText(/^Purchase Amount: \$2,500/)).toBeVisible();
    // The old copy claimed the purchase was safe "without risking negative balance".
    await expect(page.getByText(/without risking negative balance/i)).toHaveCount(0);
    await expect(page.getByText(/in this simulation/i).first()).toBeVisible();
    await expect(page.getByText("Overdraft Risk:")).toBeVisible();
  });

  test("late paycheck tab computes payroll-variance impact", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Late Paycheck/ }).click();
    await expect(page.getByText("Fragility Under Payroll Variance")).toBeVisible();
    await expect(page.getByText("Overdraft Risk:")).toBeVisible();
    await expect(page.getByText("Calculation Failed")).toHaveCount(0);
  });

  test("debt tab computes payoff and states the cash-flow caveat", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: /Debt Snowball vs Avalanche/ }).click();
    await expect(page.getByText("Payoff Strategy")).toBeVisible();
    await expect(page.getByText("Months to Payoff")).toBeVisible();
    await expect(page.getByText("Total Interest Paid")).toBeVisible();
    // Amortization must never be presented as affordability.
    await expect(
      page.getByText(/not automatically included in the cash-flow forecast/i)
    ).toBeVisible();
    await page.getByRole("button", { name: /Avalanche \(APR\)/ }).click();
    await expect(page.getByText("Months to Payoff")).toBeVisible();
    await expect(page.getByText(/Calculation Failed|UNKNOWN_ERROR/)).toHaveCount(0);
  });
});

test.describe("ledger editing", () => {
  test("adding a recurring bill updates the ledger and keeps a valid forecast", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("Safe to Spend (P10)")).toBeVisible();

    const billForm = page
      .locator("form")
      .filter({ has: page.getByPlaceholder("e.g. Electric Bill, Rent, Netflix") });
    await page.getByPlaceholder("e.g. Electric Bill, Rent, Netflix").fill("Demo Gym");
    const numbers = billForm.locator('input[type="number"]');
    await numbers.nth(0).fill("45");
    await numbers.nth(1).fill("12");
    await billForm.getByRole("button", { name: /Add Recurring Bill/ }).click();

    await expect(page.getByText("Demo Gym")).toBeVisible();
    await expect(page.getByText("Safe to Spend (P10)")).toBeVisible();
    await expect(page.getByText("Calculation Failed")).toHaveCount(0);
  });
});
