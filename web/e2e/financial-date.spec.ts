import { expect, test } from "@playwright/test";
import type { LedgerState } from "../src/lib/types";

test.use({ locale: "en-US", timezoneId: "America/New_York" });

test("a loaded offline tab advances its local financial day without changing a chosen date", async ({ context, page }) => {
  await page.clock.install({ time: new Date("2026-10-31T23:50:00-04:00") });
  await page.clock.pauseAt(new Date("2026-10-31T23:59:50-04:00"));
  await page.goto("/");
  await page.getByRole("button", { name: "Enter my own numbers" }).click();
  await page.getByLabel("Money you have now ($)").fill("1000");
  await page.getByRole("button", { name: "Save and show my plan" }).click();
  await expect(page.getByText(/Demo data — not your finances/)).toHaveCount(0);
  await page.getByRole("button", { name: "Money", exact: true }).click();

  const date = page.getByLabel("Date", { exact: true });
  const payday = page.getByLabel("Next payday", { exact: true });
  await expect(date).toHaveValue("2026-10-31");
  await payday.fill("2026-11-25");
  await context.setOffline(true);
  await page.clock.runFor(20_000);
  await expect(date).toHaveValue("2026-11-01");
  await expect(payday).toHaveValue("2026-11-25");

  await page.getByLabel("Amount ($)", { exact: true }).fill("25");
  await page.getByLabel("Note", { exact: true }).fill("Recorded after midnight");
  await page.getByRole("button", { name: "Record this", exact: true }).click();
  await expect(page.getByText("Recorded after midnight")).toBeVisible();
  const saved = await page.evaluate((): LedgerState =>
    JSON.parse(localStorage.getItem("montecarlo_ledger_state_v2") ?? "null")
  );
  expect(saved.current_balance_cents).toBe(97_500);
  expect(saved.transactions.find((row) => row.description === "Recorded after midnight")).toMatchObject({
    date: "2026-11-01",
    amount_cents: -2_500,
  });
  await page.getByRole("button", { name: "Home", exact: true }).click();
  const moneyNow = page.getByRole("heading", { name: "Money available now" }).locator("..");
  await expect(moneyNow.getByText("$975.00", { exact: true })).toBeVisible();

  // A suspended tab can miss its timer. Refresh on focus without clobbering the form.
  await page.getByRole("button", { name: "Money", exact: true }).click();
  await date.fill("2026-10-30");
  await page.clock.setSystemTime(new Date("2026-11-02T08:00:00-05:00"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(date).toHaveValue("2026-10-30");
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.getByRole("button", { name: "Money", exact: true }).click();
  await expect(date).toHaveValue("2026-11-02");
});
