import { expect, test } from "@playwright/test";
import { LedgerState } from "../src/lib/types";
import { SAMPLE_LEDGER_STATE } from "../src/lib/types";

// A ledger whose first bill has amount 0 -> the builder emits an expense of -0 -> the
// contract engine rejects it with INVALID_AMOUNT. This is the "forced financial-engine
// failure" control: the app must fail closed, never render a fabricated number.
function brokenState(): LedgerState {
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

test.describe("forced engine failure fails closed", () => {
  test("broken ledger shows the explicit error state, never zeros", async ({ page }) => {
    await page.addInitScript((state) => {
      window.localStorage.setItem("montecarlo_ledger_state_v2", JSON.stringify(state));
    }, brokenState());
    await page.goto("/");
    await expect(page.getByText("Calculation Failed")).toBeVisible();
    await expect(page.getByText("INVALID_AMOUNT").first()).toBeVisible();
    await expect(page.getByText("Reset to sample data")).toBeVisible();
    // Recovery path works.
    page.on("dialog", (dialog) => dialog.accept());
    await page.getByText("Reset to sample data").click();
    await expect(page.getByText("Safe to Spend (P10)")).toBeVisible();
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
    await page.getByRole("button", { name: /Late Paycheck/ }).click();
    await expect(page.getByText("Fragility Under Payroll Variance")).toBeVisible();
    await page.getByRole("button", { name: /Debt Snowball vs Avalanche/ }).click();
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
