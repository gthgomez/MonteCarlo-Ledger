import { expect, test, type Page } from "@playwright/test";
import { LEDGER_STORAGE_KEY } from "../src/lib/persistence";
import type { LedgerState } from "../src/lib/types";
import {
  failNextLedgerWrite,
  holdLedgerLock,
  queuedWrites,
  releaseLedgerLock,
} from "./helpers/ledger-lock";

test.use({ locale: "en-US", timezoneId: "America/New_York" });

function syntheticLedger(): LedgerState {
  return {
    version: "2.0",
    updated_at: "2026-10-31T00:00:00.000Z",
    current_balance_cents: 100_000,
    incomes: [],
    payments: [],
    transactions: [
      {
        id: "tx-opening",
        amount_cents: 100_000,
        category: "Adjustment",
        type: "Adjustment",
        date: "2026-10-31",
        description: "Opening balance",
      },
    ],
    bill_occurrences: [],
    liabilities: [],
  };
}

/** Freeze the page ten seconds before local midnight in an isolated context. */
async function installDuskClock(page: Page): Promise<void> {
  await page.clock.install({ time: new Date("2026-10-31T23:50:00-04:00") });
  await page.clock.pauseAt(new Date("2026-10-31T23:59:50-04:00"));
}

/** Seed only an empty test profile so later reads see what the app wrote. */
async function seedSyntheticLedger(page: Page, ledger = syntheticLedger()): Promise<void> {
  await page.addInitScript(
    ({ key, ledger }) => {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(ledger));
    },
    { key: LEDGER_STORAGE_KEY, ledger }
  );
  await page.goto("/");
}

async function openMoney(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Money", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Amount ($)", exact: true })).toBeVisible();
}

function storedRaw(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), LEDGER_STORAGE_KEY);
}

function storedLedger(page: Page): Promise<LedgerState> {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? "null"), LEDGER_STORAGE_KEY);
}

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

test("a queued money record keeps its communicated date across midnight and releases it on success", async ({ page }) => {
  await installDuskClock(page);
  await seedSyntheticLedger(page);
  await openMoney(page);

  const date = page.getByLabel("Date", { exact: true });
  const payday = page.getByLabel("Next payday", { exact: true });
  const amount = page.getByRole("textbox", { name: "Amount ($)", exact: true });
  const note = page.getByLabel("Note", { exact: true });
  await expect(date).toHaveValue("2026-10-31");
  await expect(payday).toHaveValue("2026-10-31");
  await amount.fill("25");
  await note.fill("Queued at dusk");
  const originalRaw = await storedRaw(page);

  await holdLedgerLock(page);
  try {
    await page.getByRole("button", { name: "Record this", exact: true }).click();
    await expect.poll(() => queuedWrites(page)).toBe(1);
    await expect(page.getByText("Saving your ledger change", { exact: true })).toBeVisible();
    await expect(date).toBeDisabled();
    await expect(date).toHaveValue("2026-10-31");

    await page.clock.runFor(20_000);
    // The submitted date stays visible while the write is queued; the untouched
    // default on the sibling income form is not frozen by this form's pin.
    await expect(date).toHaveValue("2026-10-31");
    await expect(payday).toHaveValue("2026-11-01");
    expect(await storedRaw(page)).toBe(originalRaw);
  } finally {
    await releaseLedgerLock(page);
  }

  await expect(page.getByText("Saving your ledger change", { exact: true })).toHaveCount(0);
  await expect(amount).toHaveValue("");
  await expect(note).toHaveValue("");
  // The successful implicit submission released its pin: a fresh default follows
  // the live local day again.
  await expect(date).toHaveValue("2026-11-01");
  const saved = await storedLedger(page);
  expect(saved.transactions.find((tx) => tx.description === "Queued at dusk")).toMatchObject({
    date: "2026-10-31",
    amount_cents: -2_500,
  });
});

test("a failed queued money write keeps and retries its communicated date, then resumes the fresh day", async ({ page }) => {
  await installDuskClock(page);
  await seedSyntheticLedger(page);
  await openMoney(page);

  const date = page.getByLabel("Date", { exact: true });
  const amount = page.getByRole("textbox", { name: "Amount ($)", exact: true });
  const note = page.getByLabel("Note", { exact: true });
  await amount.fill("33.33");
  await note.fill("Kept after failure");
  const originalRaw = await storedRaw(page);

  await holdLedgerLock(page);
  try {
    await page.getByRole("button", { name: "Record this", exact: true }).click();
    await expect.poll(() => queuedWrites(page)).toBe(1);
    await expect(date).toHaveValue("2026-10-31");
    await page.clock.runFor(20_000);
    // The one synthetic storage failure lands while this request is still queued.
    await failNextLedgerWrite(page);
  } finally {
    await releaseLedgerLock(page);
  }

  await expect(page.getByText("Not saved", { exact: true })).toBeVisible();
  await expect(date).toHaveValue("2026-10-31");
  await expect(amount).toHaveValue("33.33");
  await expect(note).toHaveValue("Kept after failure");
  expect(await storedRaw(page)).toBe(originalRaw);

  // A later local day and refocus cannot move a failed draft's communicated date.
  await page.clock.setSystemTime(new Date("2026-11-02T08:00:00-05:00"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(date).toHaveValue("2026-10-31");

  // Retrying is queued again so the pending UI is observable, and it still sends
  // the date this form already showed rather than the new local day.
  await holdLedgerLock(page);
  try {
    await page.getByRole("button", { name: "Record this", exact: true }).click();
    await expect.poll(() => queuedWrites(page)).toBe(1);
    await expect(page.getByText("Saving your ledger change", { exact: true })).toBeVisible();
    await expect(date).toBeDisabled();
    await expect(date).toHaveValue("2026-10-31");
  } finally {
    await releaseLedgerLock(page);
  }

  await expect(page.getByText("Saving your ledger change", { exact: true })).toHaveCount(0);
  await expect(date).toHaveValue("2026-11-02");
  await expect(amount).toHaveValue("");
  await expect(note).toHaveValue("");
  const saved = await storedLedger(page);
  expect(saved.transactions.find((tx) => tx.description === "Kept after failure")).toMatchObject({
    date: "2026-10-31",
    amount_cents: -3_333,
  });

  // The released pin must not leak into the next untouched draft.
  await amount.fill("1.00");
  await note.fill("Fresh after retry");
  await page.getByRole("button", { name: "Record this", exact: true }).click();
  // A cleared draft proves the write completed before the ledger is read.
  await expect(note).toHaveValue("");
  const afterFresh = await storedLedger(page);
  expect(afterFresh.transactions.find((tx) => tx.description === "Fresh after retry")).toMatchObject({
    date: "2026-11-02",
    amount_cents: -100,
  });
});

test("a date typed after a failed draft wins over the preserved implicit date", async ({ page }) => {
  await installDuskClock(page);
  await seedSyntheticLedger(page);
  await openMoney(page);

  const date = page.getByLabel("Date", { exact: true });
  const amount = page.getByRole("textbox", { name: "Amount ($)", exact: true });
  const note = page.getByLabel("Note", { exact: true });
  await amount.fill("7");
  await note.fill("Changed after failure");

  await holdLedgerLock(page);
  try {
    await page.getByRole("button", { name: "Record this", exact: true }).click();
    await expect.poll(() => queuedWrites(page)).toBe(1);
    await page.clock.runFor(20_000);
    await failNextLedgerWrite(page);
  } finally {
    await releaseLedgerLock(page);
  }

  await expect(page.getByText("Not saved", { exact: true })).toBeVisible();
  await expect(date).toHaveValue("2026-10-31");

  // The failed draft's preserved date does not override a new explicit choice.
  await date.fill("2026-11-10");
  await page.clock.setSystemTime(new Date("2026-11-02T08:00:00-05:00"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(date).toHaveValue("2026-11-10");

  await holdLedgerLock(page);
  try {
    await page.getByRole("button", { name: "Record this", exact: true }).click();
    await expect.poll(() => queuedWrites(page)).toBe(1);
    await expect(date).toHaveValue("2026-11-10");
  } finally {
    await releaseLedgerLock(page);
  }

  await expect(note).toHaveValue("");
  const saved = await storedLedger(page);
  expect(saved.transactions.find((tx) => tx.description === "Changed after failure")).toMatchObject({
    date: "2026-11-10",
    amount_cents: -700,
  });
});

test("a queued scheduled payday keeps its communicated date through failure and retry", async ({ page }) => {
  await installDuskClock(page);
  await seedSyntheticLedger(page);
  await openMoney(page);

  const date = page.getByLabel("Date", { exact: true });
  const payday = page.getByLabel("Next payday", { exact: true });
  const name = page.getByLabel("Name", { exact: true });
  const takeHome = page.getByRole("textbox", { name: "Take-home amount ($)", exact: true });
  await name.fill("Job");
  await takeHome.fill("1900");
  const originalRaw = await storedRaw(page);

  await holdLedgerLock(page);
  try {
    await page.getByRole("button", { name: "Add income", exact: true }).click();
    await expect.poll(() => queuedWrites(page)).toBe(1);
    await expect(payday).toBeDisabled();
    await expect(payday).toHaveValue("2026-10-31");
    await page.clock.runFor(20_000);
    await expect(payday).toHaveValue("2026-10-31");
    // The transaction form's untouched date is a separate default.
    await expect(date).toHaveValue("2026-11-01");
    await failNextLedgerWrite(page);
  } finally {
    await releaseLedgerLock(page);
  }

  await expect(page.getByText("Not saved", { exact: true })).toBeVisible();
  await expect(payday).toHaveValue("2026-10-31");
  await expect(name).toHaveValue("Job");
  await expect(takeHome).toHaveValue("1900");
  expect(await storedRaw(page)).toBe(originalRaw);

  await page.clock.setSystemTime(new Date("2026-11-02T08:00:00-05:00"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(payday).toHaveValue("2026-10-31");
  await expect(date).toHaveValue("2026-11-02");

  await holdLedgerLock(page);
  try {
    await page.getByRole("button", { name: "Add income", exact: true }).click();
    await expect.poll(() => queuedWrites(page)).toBe(1);
    await expect(page.getByText("Saving your ledger change", { exact: true })).toBeVisible();
    await expect(payday).toHaveValue("2026-10-31");
  } finally {
    await releaseLedgerLock(page);
  }

  await expect(page.getByText("Saving your ledger change", { exact: true })).toHaveCount(0);
  await expect(payday).toHaveValue("2026-11-02");
  await expect(name).toHaveValue("");
  const saved = await storedLedger(page);
  expect(saved.incomes).toMatchObject([{ name: "Job", next_payday: "2026-10-31" }]);
});

test("a queued balance match keeps its communicated date in the preview and stored adjustment", async ({ page }) => {
  await installDuskClock(page);
  const ledger = syntheticLedger();
  ledger.current_balance_cents = 120_000;
  ledger.transactions.push({
    id: "tx-future", amount_cents: 20_000, category: "Income", type: "Income",
    date: "2026-11-01", description: "Synthetic receipt after cutoff",
  });
  await seedSyntheticLedger(page, ledger);
  await openMoney(page);

  const balance = page.getByLabel("Balance you want recorded ($)");
  await balance.fill("900");
  const dated = page.getByText("This will add an adjustment of -$100.00 dated Oct 31, 2026.", { exact: true });
  const cashToday = page.getByRole("heading", { name: "What you have" }).locator("..");
  await expect(dated).toBeVisible();
  const originalRaw = await storedRaw(page);

  await holdLedgerLock(page);
  try {
    await page.getByRole("button", { name: "Reconcile Ledger", exact: true }).click();
    await expect.poll(() => queuedWrites(page)).toBe(1);
    await expect(page.getByText("Saving your ledger change", { exact: true })).toBeVisible();
    await page.clock.runFor(20_000);
    await expect(cashToday.getByText("$1,200.00", { exact: true })).toBeVisible();
    await expect(dated).toBeVisible();
    await failNextLedgerWrite(page);
  } finally {
    await releaseLedgerLock(page);
  }

  await expect(page.getByText("Not saved", { exact: true })).toBeVisible();
  await expect(balance).toHaveValue("900");
  await expect(dated).toBeVisible();
  expect(await storedRaw(page)).toBe(originalRaw);

  await page.clock.setSystemTime(new Date("2026-11-02T08:00:00-05:00"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(dated).toBeVisible();

  await holdLedgerLock(page);
  try {
    await page.getByRole("button", { name: "Reconcile Ledger", exact: true }).click();
    await expect.poll(() => queuedWrites(page)).toBe(1);
    await expect(dated).toBeVisible();
  } finally {
    await releaseLedgerLock(page);
  }

  // The new adjustment row proves the write completed before storage is read.
  await expect(page.getByText("Balance reconciliation adjustment", { exact: true })).toBeVisible();
  const saved = await storedLedger(page);
  expect(saved.current_balance_cents).toBe(110_000);
  expect(saved.transactions.slice(0, 2)).toEqual(ledger.transactions);
  expect(saved.transactions.find((tx) => tx.description === "Balance reconciliation adjustment")).toMatchObject({
    date: "2026-10-31",
    amount_cents: -10_000,
  });
});

test("the starter ledger keeps its communicated payday and opening as-of through failure and retry", async ({ page }) => {
  await installDuskClock(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Enter my own numbers" }).click();

  const balance = page.getByLabel("Money you have now ($)");
  const payday = page.getByLabel("Next payday", { exact: true });
  const name = page.getByLabel("Paycheck name");
  const dated = page.getByText("Opening balance date: Oct 31, 2026.", { exact: true });
  await balance.fill("500");
  await name.fill("Job");
  await page.getByLabel("Take-home amount ($)").fill("1900");
  await expect(payday).toHaveValue("2026-10-31");
  expect(await storedRaw(page)).toBeNull();

  await holdLedgerLock(page);
  try {
    await page.getByRole("button", { name: "Save and show my plan" }).click();
    await expect.poll(() => queuedWrites(page)).toBe(1);
    await expect(payday).toBeDisabled();
    await expect(payday).toHaveValue("2026-10-31");
    await page.clock.runFor(20_000);
    await expect(payday).toHaveValue("2026-10-31");
    await expect(dated).toBeVisible();
    await failNextLedgerWrite(page);
  } finally {
    await releaseLedgerLock(page);
  }

  await expect(page.getByText("Not saved", { exact: true })).toBeVisible();
  await expect(payday).toHaveValue("2026-10-31");
  await expect(dated).toBeVisible();
  await expect(balance).toHaveValue("500");
  await expect(name).toHaveValue("Job");
  expect(await storedRaw(page)).toBeNull();

  await page.clock.setSystemTime(new Date("2026-11-02T08:00:00-05:00"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(payday).toHaveValue("2026-10-31");

  await holdLedgerLock(page);
  try {
    await page.getByRole("button", { name: "Save and show my plan" }).click();
    await expect.poll(() => queuedWrites(page)).toBe(1);
    await expect(page.getByText("Saving your ledger change", { exact: true })).toBeVisible();
    await expect(payday).toHaveValue("2026-10-31");
  } finally {
    await releaseLedgerLock(page);
  }

  await expect(page.getByText(/Demo data — not your finances/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Save and show my plan" })).toHaveCount(0);
  const saved = await storedLedger(page);
  expect(saved.transactions.find((tx) => tx.description === "Opening balance")).toMatchObject({
    date: "2026-10-31",
    amount_cents: 50_000,
  });
  expect(saved.incomes).toMatchObject([{ name: "Job", next_payday: "2026-10-31" }]);

  // The successful implicit submission released both pins, so other fresh date
  // defaults follow the live local day rather than the starter form's old date.
  await openMoney(page);
  await expect(page.getByLabel("Next payday", { exact: true })).toHaveValue("2026-11-02");
  await expect(page.getByLabel("Date", { exact: true })).toHaveValue("2026-11-02");
});

test("invalid starter data does not pin an opening date before there is a write", async ({ page }) => {
  await installDuskClock(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Enter my own numbers" }).click();
  const balance = page.getByLabel("Money you have now ($)");
  const payday = page.getByLabel("Next payday", { exact: true });
  const save = page.getByRole("button", { name: "Save and show my plan" });
  await balance.fill("500");
  await page.getByLabel("Paycheck name").fill("Synthetic job");
  await page.getByLabel("Take-home amount ($)").fill("1900");
  await payday.fill("");
  await save.click();
  await expect(page.getByRole("alert").filter({ hasText: "must be a valid date" })).toBeVisible();
  expect(await storedRaw(page)).toBeNull();

  await page.clock.runFor(20_000);
  await expect(page.getByText("Opening balance date: Oct 31, 2026.", { exact: true })).toHaveCount(0);
  await balance.fill("750");
  await payday.fill("2026-11-15");
  await save.click();
  await expect(save).toHaveCount(0);
  const saved = await storedLedger(page);
  expect(saved.transactions).toMatchObject([{ amount_cents: 75_000, type: "Adjustment", date: "2026-11-01" }]);
  expect(saved.incomes).toMatchObject([{ name: "Synthetic job", next_payday: "2026-11-15" }]);
});

test("an explicit transaction date survives successful saves and later days", async ({ page }) => {
  await installDuskClock(page);
  await seedSyntheticLedger(page);
  await openMoney(page);

  const date = page.getByLabel("Date", { exact: true });
  const amount = page.getByRole("textbox", { name: "Amount ($)", exact: true });
  const note = page.getByLabel("Note", { exact: true });
  await date.fill("2026-11-20");
  await amount.fill("5");
  await note.fill("Explicit once");
  await page.getByRole("button", { name: "Record this", exact: true }).click();
  await expect(note).toHaveValue("");
  await expect(date).toHaveValue("2026-11-20");

  await page.clock.runFor(20_000);
  await expect(date).toHaveValue("2026-11-20");
  await page.clock.setSystemTime(new Date("2026-11-05T08:00:00-05:00"));
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(date).toHaveValue("2026-11-20");

  await amount.fill("6");
  await note.fill("Explicit twice");
  await page.getByRole("button", { name: "Record this", exact: true }).click();
  await expect(note).toHaveValue("");
  await expect(date).toHaveValue("2026-11-20");

  const saved = await storedLedger(page);
  for (const description of ["Explicit once", "Explicit twice"]) {
    expect(saved.transactions.find((tx) => tx.description === description)?.date).toBe("2026-11-20");
  }
});
