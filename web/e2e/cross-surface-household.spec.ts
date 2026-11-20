import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const fixturePath = path.join(
  __dirname,
  "..",
  "..",
  "testdata",
  "household",
  "cross-surface-household.json"
);
const doc = JSON.parse(fs.readFileSync(fixturePath, "utf8"));
const evidenceDir = path.join(
  __dirname,
  "..",
  "..",
  "..",
  "evidence",
  "screenshots"
);

test.describe("cross-surface household rendered views", () => {
  test.use({ viewport: { width: 1280, height: 900 } });

  test("Home Money Budget Bills Plan Future show shared P10 and seed-bound figures", async ({
    page,
  }, testInfo) => {
    // Only run the desktop project for screenshots.
    test.skip(testInfo.project.name !== "desktop", "desktop screenshots only");

    fs.mkdirSync(evidenceDir, { recursive: true });
    await page.addInitScript((ledger) => {
      window.localStorage.setItem("montecarlo_ledger_state_v2", JSON.stringify(ledger));
      window.localStorage.setItem("mc-theme", "light");
    }, doc.ledger);

    await page.goto("/");
    await expect(page.getByText("Safe to Spend (P10)")).toBeVisible();
    await expect(page.getByText("Calculation Failed")).toHaveCount(0);
    const cautiousAmount = page
      .getByRole("heading", { name: "Cautious amount to spend" })
      .locator("..");
    await expect(cautiousAmount.getByText("$4,422.00", { exact: true })).toBeVisible();
    await page.screenshot({
      path: path.join(evidenceDir, "home.png"),
      fullPage: true,
    });

    const sections = [
      ["Money", "money.png"],
      ["Budget", "budget.png"],
      ["Bills", "bills.png"],
      ["Plan", "plan.png"],
      ["Future", "future.png"],
    ] as const;

    for (const [label, file] of sections) {
      await page.getByRole("button", { name: label, exact: true }).click();
      await expect(page.getByText("Calculation Failed")).toHaveCount(0);
      if (label === "Future" || label === "Plan") {
        await expect(page.getByText(/Safe to Spend \(P10\)|Cautious amount|Chance of running short|Payoff/i).first()).toBeVisible();
      }
      await page.screenshot({
        path: path.join(evidenceDir, file),
        fullPage: true,
      });
    }

    // Plan debt tab states the cash-flow caveat and still computes.
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await page.getByRole("tab", { name: /How do I pay off debt/ }).click();
    await expect(page.getByText("Months to Payoff")).toBeVisible();
    await expect(
      page.getByText(/Minimum payments for debts you entered are already ordinary outflows/i)
    ).toBeVisible();
    await page.screenshot({
      path: path.join(evidenceDir, "plan-debt.png"),
      fullPage: true,
    });

    // Advanced: seed-bound controls remain visible without promising outcomes.
    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    await expect(page.getByText("Safe to Spend (P10)")).toBeVisible();
  });
});
