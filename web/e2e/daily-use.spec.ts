import { expect, test, type Page } from "@playwright/test";

const ledgerKey = "montecarlo_ledger_state_v2";
const firstDay = new Date("2026-03-01T12:00:00Z");

async function rawLedger(page: Page) {
  return page.evaluate((key) => localStorage.getItem(key), ledgerKey);
}

function moneyMetric(page: Page, name: string) {
  return page.getByRole("heading", { name, exact: true }).locator("..").locator("p").first();
}

test.use({ timezoneId: "UTC", locale: "en-US" });

test("check a purchase, record it once, and continue the household on the next day", async ({ page }, testInfo) => {
  test.setTimeout(75_000);
  await page.clock.install({ time: firstDay });
  await page.goto("/");
  await expect(page.getByText(/Demo data — not your finances/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Record a purchase" })).toHaveCount(0);
  await page.getByRole("button", { name: "Enter my own numbers" }).click();
  await page.getByLabel("Money you have now ($)").fill("500");
  await page.getByLabel("A regular bill").fill("Loan bill");
  await page.getByLabel("Bill amount ($)").fill("300");
  await page.getByLabel("Due day").fill("15");
  await page.getByRole("button", { name: "Save and show my plan" }).click();

  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await page.getByLabel("Plan window (days, 1–730)").fill("20");
  await page.getByLabel("Income can fall to (%)").fill("0");
  await page.getByLabel("Income can rise to (%)").fill("0");
  await page.getByLabel("Bills can fall to (%)").fill("0");
  await page.getByLabel("Bills can rise to (%)").fill("0");
  await page.getByLabel("Unexpected expense chance each check (%)").fill("0");
  await page.getByLabel("Reserve to subtract from the chosen low point ($)").fill("100");
  await page.getByRole("button", { name: "Update results" }).click();
  await expect(page.getByLabel("Reserve to subtract from the chosen low point ($)")).toHaveValue("100.00");

  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(moneyMetric(page, "Money available now")).toHaveText("$500.00");
  await expect(moneyMetric(page, "Lowest point if the schedule is exact")).toHaveText("$200.00");
  await expect(moneyMetric(page, "Cautious amount to spend")).toHaveText("$100.00");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  await testInfo.attach("household-overview", { body: await page.screenshot(), contentType: "image/png" });

  const beforeDecision = await rawLedger(page);
  const quickRecord = page.getByRole("button", { name: "Record a purchase" });
  await quickRecord.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Amount ($)", { exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Home", exact: true }).click();

  await page.getByRole("button", { name: "Check a purchase" }).click();
  await page.getByLabel("Or type an amount ($)").fill("40");
  const comparison = page.getByRole("table", { name: "Current plan compared with this decision" });
  await expect(comparison.getByRole("row", { name: /Cautious amount to spend/ }).locator("td")).toHaveText(["$100.00", "$60.00"]);
  await expect(comparison.getByRole("row", { name: /Ending balance/ }).locator("td")).toHaveText(["$200.00", "$160.00"]);
  await testInfo.attach("purchase-comparison", { body: await page.screenshot(), contentType: "image/png" });
  expect(await rawLedger(page)).toBe(beforeDecision);
  await page.getByRole("button", { name: "Review and record this purchase" }).click();

  const amount = page.getByLabel("Amount ($)", { exact: true });
  await expect(amount).toHaveValue("40.00");
  await expect(page.getByLabel("Date", { exact: true })).toHaveValue("2026-03-01");
  expect(await rawLedger(page)).toBe(beforeDecision);
  await page.getByLabel("Note", { exact: true }).fill("Synthetic groceries");
  const record = page.getByRole("button", { name: "Record this", exact: true });
  await record.click();
  await expect(page.getByRole("status").filter({ hasText: /Recorded \$40\.00/ })).toBeVisible();
  await expect(amount).toHaveValue("");
  await record.click();
  await expect(page.getByRole("alert").filter({ hasText: /Enter an amount greater than zero/ })).toBeVisible();

  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(moneyMetric(page, "Money available now")).toHaveText("$460.00");
  await expect(moneyMetric(page, "Cautious amount to spend")).toHaveText("$60.00");
  await page.clock.setSystemTime(new Date("2026-03-02T12:00:00Z"));
  await page.reload();
  await expect(moneyMetric(page, "Money available now")).toHaveText("$460.00");

  await page.getByRole("button", { name: "Money", exact: true }).click();
  await page.getByLabel("Kind").selectOption("Income");
  await page.getByLabel("Amount ($)", { exact: true }).fill("50");
  await page.getByLabel("Note", { exact: true }).fill("Synthetic cash received");
  await page.getByRole("button", { name: "Record this", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: /Recorded \$50\.00/ })).toBeVisible();
  await page.getByRole("button", { name: "Edit Synthetic groceries" }).click();
  await page.getByLabel("Corrected note").fill("Groceries corrected");
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Transaction updated." })).toBeVisible();
  await page.getByLabel("Balance you want recorded ($)").fill("505");
  await expect(page.getByText(/adjustment of -\$5\.00 dated Mar 2, 2026/)).toBeVisible();
  await page.getByRole("button", { name: "Reconcile Ledger" }).click();
  await expect(page.getByText("This already matches the recorded balance. No adjustment will be added.")).toBeVisible();

  await page.getByRole("button", { name: "Bills", exact: true }).click();
  const bill = page.getByRole("listitem", { name: "Loan bill due Mar 15, 2026" });
  await bill.getByRole("button", { name: "Mark paid", exact: true }).click();
  await expect(bill).toHaveCount(0);
  await page.getByRole("button", { name: "Money", exact: true }).click();
  await page.getByRole("button", { name: "Edit Loan bill" }).click();
  await page.getByLabel("Corrected amount ($)").fill("200");
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect(page.getByRole("alert").filter({ hasText: /linked|settles/i })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Delete Loan bill" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Transaction deleted." })).toBeVisible();
  await page.getByRole("button", { name: "Bills", exact: true }).click();
  await bill.getByRole("button", { name: "Mark paid", exact: true }).click();
  await expect(bill).toHaveCount(0);
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(moneyMetric(page, "Money available now")).toHaveText("$205.00");
  await page.reload();
  await expect(moneyMetric(page, "Money available now")).toHaveText("$205.00");

  const final = JSON.parse((await rawLedger(page)) ?? "null");
  expect(final.transactions.map((row: { amount_cents: number }) => row.amount_cents)).toEqual([
    50_000, -4_000, 5_000, -500, -30_000,
  ]);
  expect(final.current_balance_cents).toBe(20_500);
  expect(final.transactions[1]).toMatchObject({ date: "2026-03-01", description: "Groceries corrected" });
  expect(final.transactions[4].id).toEqual(final.bill_occurrences[0].transaction_id);
});
