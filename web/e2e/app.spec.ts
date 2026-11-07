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
