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
    await page.clock.install({ time: new Date(`${doc.as_of}T12:00:00.000Z`) });
    await page.addInitScript((ledger) => {
      window.localStorage.setItem("montecarlo_ledger_state_v2", JSON.stringify(ledger));
      window.localStorage.setItem("mc-theme", "light");
    }, doc.ledger);

    await page.goto("/");
    await expect(page.getByText("Safe to Spend (P10)")).toBeVisible();
    await expect(page.getByText("Calculation Failed")).toHaveCount(0);
    const readCautiousAmount = async (targetPage: typeof page) => {
      const text = await targetPage
        .getByRole("heading", { name: "Cautious amount to spend" })
        .locator("..")
        .locator("p")
        .first()
        .innerText();
      return Number(text.replace(/[^\d.-]/g, ""));
    };
    const withDebt = await readCautiousAmount(page);
    expect(Number.isFinite(withDebt)).toBe(true);

    const debtFreeLedger = JSON.parse(JSON.stringify(doc.ledger));
    delete debtFreeLedger.liabilities;
    const debtFreePage = await page.context().newPage();
    await debtFreePage.clock.install({ time: new Date(`${doc.as_of}T12:00:00.000Z`) });
    await debtFreePage.addInitScript((ledger) => {
      window.localStorage.setItem("montecarlo_ledger_state_v2", JSON.stringify(ledger));
    }, debtFreeLedger);
    await debtFreePage.goto("/");
    await expect(debtFreePage.getByText("Safe to Spend (P10)")).toBeVisible();
    await expect(debtFreePage.getByText("Calculation Failed")).toHaveCount(0);
    const withoutDebt = await readCautiousAmount(debtFreePage);
    expect(withoutDebt).toBeGreaterThan(withDebt);
    await debtFreePage.close();
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

test("an existing bill can be linked to a debt and survives reload", async ({ page }) => {
  await page.clock.install({ time: new Date("2028-02-01T12:00:00.000Z") });
  const storageKey = "montecarlo_ledger_state_v2";
  await page.addInitScript(({ key, ledger }) => {
    if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(ledger));
  }, {
    key: storageKey,
    ledger: {
      version: "2.1",
      current_balance_cents: 210_000,
      incomes: [],
      payments: [{
        id: "existing-loan",
        name: "Car payment",
        amount_cents: 50_000,
        recurrence: "Monthly",
        due_day: 15,
      }],
      transactions: [{
        id: 1, type: "Adjustment", amount_cents: 200_000, date: "2028-01-31",
      }, {
        id: 2, type: "Income", amount_cents: 10_000, date: "2028-02-25", description: "Future income",
      }],
      bill_occurrences: [],
      liabilities: [],
    },
  });
  const home = page.getByRole("heading", { name: "Cautious amount to spend" }).locator("..");
  const amount = home.locator("p").first();

  await page.goto("/");
  await expect(amount).toBeVisible();
  await expect(page.getByRole("heading", { name: "Money available now" }).locator("..").locator("p").first())
    .toHaveText("$2,000.00");
  const details = page.getByText("See what is included", { exact: true });
  await details.focus();
  await details.press("Enter");
  await expect(page.getByText(/Future income/)).toBeVisible();
  const before = await amount.innerText();
  await page.getByRole("button", { name: "Plan", exact: true }).click();
  await page.getByRole("tab", { name: /How do I pay off debt/ }).click();
  await page.getByLabel("Debt name").fill("Car loan");
  await page.getByLabel("Amount still owed ($)").fill("3000");
  await page.getByLabel("Interest rate (%)").fill("0");
  await page.getByLabel("Minimum payment ($)").fill("500");
  await page.getByLabel("Bill for this debt (optional)").selectOption("existing-loan");
  await page.getByRole("button", { name: "Add debt" }).click();
  await expect(page.getByRole("button", { name: "Remove Car loan" })).toBeVisible();

  await page.reload();
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(amount).toHaveText(before);
  const saved = await page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), storageKey);
  expect(saved.version).toBe("2.2");
  expect(saved.liabilities).toMatchObject([{
    linked_payment_id: "existing-loan",
    due_day_of_month: 15,
    min_payment_cents: 50_000,
  }]);
});
