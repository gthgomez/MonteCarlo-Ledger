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
  test("home explains the cautious amount, not an error screen", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByText("What these numbers mean")).toBeVisible();
    await expect(page.getByText("Safe to Spend (P10)")).toBeVisible();
    await expect(page.getByText("Calculation Failed")).toHaveCount(0);
    await expect(page.getByText(/\$[\d,]/).first()).toBeVisible();
    await expect(page.getByText(/Demo data — not your finances/)).toBeVisible();
  });

  test("plan shows a purchase comparison from the engine", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await expect(page.getByText("How this changes the plan")).toBeVisible();
    await expect(page.getByText("Chance of running short").first()).toBeVisible();
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

test.describe("decision journeys", () => {
  test("purchase scenario is labelled as a model estimate, never a guarantee", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await expect(page.getByText(/^Purchase Amount:/)).toBeVisible();
    await page.locator('input[type="range"]').first().press("End");
    await expect(page.getByText(/^Purchase Amount: \$2,500/)).toBeVisible();
    await expect(page.getByText(/without risking negative balance/i)).toHaveCount(0);
    await expect(page.getByText(/in this simulation/i).first()).toBeVisible();
    await expect(page.getByText("Chance of running short").first()).toBeVisible();
  });

  test("late paycheck tab computes payroll-variance impact", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await page.getByRole("tab", { name: /What if payday is late/ }).click();
    await expect(page.getByText("If that paycheck arrives late")).toBeVisible();
    await expect(page.getByText("Chance of running short").first()).toBeVisible();
    await expect(page.getByText("Calculation Failed")).toHaveCount(0);
  });

  test("debt tab computes payoff and states the cash-flow caveat", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await page.getByRole("tab", { name: /How do I pay off debt/ }).click();
    await expect(page.getByText("Payoff Strategy")).toBeVisible();
    await expect(page.getByText("Months to Payoff")).toBeVisible();
    await expect(page.getByText("Total Interest Paid")).toBeVisible();
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
    await page.getByRole("button", { name: "Bills", exact: true }).click();
    await expect(page.getByText("Safe to Spend (P10)")).toHaveCount(0);

    const billForm = page
      .locator("form")
      .filter({ has: page.getByPlaceholder("e.g. Electric Bill, Rent, Netflix") });
    await page.getByPlaceholder("e.g. Electric Bill, Rent, Netflix").fill("Demo Gym");
    const numbers = billForm.locator('input[type="number"]');
    await numbers.nth(0).fill("45");
    await numbers.nth(1).fill("12");
    await billForm.getByRole("button", { name: /Add Recurring Bill/ }).click();

    await expect(page.getByRole("button", { name: "Remove Demo Gym" })).toBeVisible();
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await expect(page.getByText("Safe to Spend (P10)")).toBeVisible();
    await expect(page.getByText("Calculation Failed")).toHaveCount(0);
  });
});

test.describe("local-first privacy", () => {
  test("dashboard and decisions make no remote network calls", async ({ page }) => {
    const remote: string[] = [];
    page.on("request", (req) => {
      const url = req.url();
      const local =
        url.startsWith("http://127.0.0.1:3100") ||
        url.startsWith("data:") ||
        url.startsWith("blob:");
      if (!local) remote.push(url);
    });

    await page.goto("/");
    await expect(page.getByText("Safe to Spend (P10)")).toBeVisible();
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await page.getByRole("tab", { name: /What if payday is late/ }).click();
    await expect(page.getByText("If that paycheck arrives late")).toBeVisible();
    await page.getByRole("tab", { name: /How do I pay off debt/ }).click();
    await expect(page.getByText("Payoff Strategy")).toBeVisible();

    expect(remote, `unexpected remote requests: ${remote.join(", ")}`).toEqual([]);
  });

  test("cloud vault is optional and opening it sends nothing", async ({ page }) => {
    const vaultCalls: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/vault")) vaultCalls.push(req.url());
    });

    await page.goto("/");
    await page.getByRole("button", { name: /Cloud Vault/ }).click();
    await expect(page.getByText(/Cloud Vault & CLI Synchronization/)).toBeVisible();
    await expect(page.getByText(/zero-knowledge end-to-end encryption/i)).toBeVisible();
    // Opening the optional sync surface must not by itself send the ledger anywhere.
    expect(vaultCalls).toEqual([]);
    await expect(page.getByText("Safe to Spend (P10)")).toBeVisible();
  });
});

test.describe("beginner financial journey", () => {
  test("own numbers, spending, bills, a decision, and the forecast stay consistent", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Enter my own numbers" }).click();
    await page.getByLabel("Money you have now ($)").fill("1800");
    await page.getByLabel("Paycheck name").fill("Job");
    await page.getByLabel("Take-home amount ($)").fill("2400");
    await page.getByLabel("A regular bill").fill("Rent");
    await page.getByLabel("Bill amount ($)").fill("900");
    await page.getByLabel("Due day").fill("1");
    await page.getByRole("button", { name: "Save and show my plan" }).click();

    await expect(page.getByText("Demo data — not your finances.")).toHaveCount(0);
    await expect(page.getByText("$1,800.00").first()).toBeVisible();
    await expect(page.getByText("Calculation Failed")).toHaveCount(0);
    await expect(page.getByText(/not a guarantee/i).first()).toBeVisible();

    await page.getByRole("button", { name: "Money", exact: true }).click();
    await page.getByRole("textbox", { name: "Amount ($)", exact: true }).fill("80");
    await page.getByLabel("Category").fill("Groceries");
    await page.getByRole("button", { name: "Record this" }).click();
    await expect(page.getByText("Groceries").first()).toBeVisible();
    await expect(page.getByText(/This matches the sum of/)).toBeVisible();

    await page.getByRole("button", { name: "Budget", exact: true }).click();
    await expect(page.getByText("Groceries").first()).toBeVisible();
    await expect(page.getByText("$80.00").first()).toBeVisible();
    await page.getByLabel("Monthly spending target ($)").fill("200");
    await page.getByRole("button", { name: "Save target" }).click();
    await expect(page.getByText(/\$120\.00 under the target/)).toBeVisible();
    await expect(page.getByText(/not part of the forecast/i)).toBeVisible();

    await page.getByRole("button", { name: "Bills", exact: true }).click();
    await expect(page.getByRole("button", { name: "Remove Rent" })).toBeVisible();
    await expect(page.getByText(/you marked this as leaving on its own/i)).toHaveCount(0);

    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await expect(page.getByText("How this changes the plan")).toBeVisible();
    await page.getByRole("tab", { name: /What if payday is late/ }).click();
    await expect(page.getByText("If that paycheck arrives late")).toBeVisible();

    await page.getByRole("button", { name: "Future", exact: true }).click();
    await expect(page.getByText(/median, not an average/i).first()).toBeVisible();
    await expect(page.getByText("More difficult low point")).toBeVisible();
    await expect(page.getByText("Calculation Failed")).toHaveCount(0);

    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    await page.getByLabel("Seed").fill("7");
    await page.getByRole("button", { name: "Update results" }).click();
    await expect(page.getByText("7 / 500 / 90 days")).toBeVisible();
    await expect(page.getByText("minimum_balance_p10 / p50 / p90")).toBeVisible();
  });

  test("sections fit the required viewports without horizontal overflow", async ({ page }) => {
    await page.goto("/");
    const sizes = [
      [320, 568],
      [375, 667],
      [390, 844],
      [768, 1024],
      [1280, 800],
      [1440, 900],
    ] as const;
    const sections = ["Home", "Money", "Budget", "Bills", "Plan", "Future", "Advanced"] as const;
    for (const [width, height] of sizes) {
      await page.setViewportSize({ width, height });
      for (const name of sections) {
        await page.getByRole("button", { name, exact: true }).click();
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth
        );
        expect(overflow, `${name} at ${width}x${height}`).toBeLessThanOrEqual(1);
      }
    }
  });
});
