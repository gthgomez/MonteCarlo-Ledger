import { expect, test, type Dialog, type Page } from "@playwright/test";

import { DEFAULT_ASSUMPTIONS } from "../src/lib/assumptions";
import { ASSUMPTIONS_STORAGE_KEY } from "../src/lib/assumptions-persistence";
import { LEDGER_STORAGE_KEY } from "../src/lib/persistence";
import type { LedgerState } from "../src/lib/types";
import { failNextLedgerWrite } from "./helpers/ledger-lock";

/**
 * Settings and reconciliation draft safety.
 *
 * Every test seeds a synthetic ledger in this test's isolated browser context.
 * The sibling updates are real storage events for synthetic values; no vault,
 * network route, real ledger, or fixed sleep is involved.
 */

test.use({ locale: "en-US", timezoneId: "UTC" });

const AS_OF = "2026-11-15";
const RESERVE_LABEL = "Reserve to subtract from the chosen low point ($)";
const SEED_LABEL = "Seed";
const PLAN_WINDOW_LABEL = "Plan window (days, 1–730)";
const ADVANCED_DRAFT_STATUS = /Unsaved settings: the values you changed here are not applied yet/;
const APPLIED_STATUS = /These fields match the applied settings used by results/;

function syntheticLedger(): LedgerState {
  return {
    version: "2.0",
    updated_at: "2026-11-01T00:00:00.000Z",
    current_balance_cents: 100_000,
    incomes: [],
    payments: [],
    transactions: [
      {
        id: "tx-opening",
        amount_cents: 100_000,
        category: "Adjustment",
        type: "Adjustment",
        date: "2026-11-01",
        description: "Opening balance",
      },
    ],
    bill_occurrences: [],
    liabilities: [],
  };
}

async function seedSyntheticLedger(page: Page): Promise<void> {
  await page.addInitScript(
    ({ key, ledger }) => localStorage.setItem(key, JSON.stringify(ledger)),
    { key: LEDGER_STORAGE_KEY, ledger: syntheticLedger() }
  );
  await page.goto("/");
}

async function openMoney(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Money", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Amount ($)", exact: true })).toBeVisible();
}

async function openAdvanced(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await expect(page.getByLabel(RESERVE_LABEL)).toBeVisible();
}

function storedRaw(page: Page, key: string): Promise<string | null> {
  return page.evaluate((storageKey) => localStorage.getItem(storageKey), key);
}

async function storedAssumptions(page: Page): Promise<{ schemaVersion: number; values: Record<string, number> } | null> {
  const raw = await storedRaw(page, ASSUMPTIONS_STORAGE_KEY);
  return raw === null ? null : JSON.parse(raw);
}

/** Fail one real settings write in this synthetic browser context. */
async function failNextSettingsWrite(page: Page): Promise<void> {
  await page.evaluate((assumptionsKey) => {
    const original = Storage.prototype.setItem;
    const local = window.localStorage;
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      if (this === local && key === assumptionsKey) {
        Storage.prototype.setItem = original;
        throw new DOMException("Synthetic settings write failure", "QuotaExceededError");
      }
      return original.call(this, key, value);
    };
  }, ASSUMPTIONS_STORAGE_KEY);
}

test.describe("settings draft safety", () => {
  test.beforeEach(async ({ page }) => {
    await page.clock.install({ time: new Date(`${AS_OF}T12:00:00.000Z`) });
  });

  test("a failed settings save keeps its exact reserve while pristine fields follow a sibling update", async ({ page, context }) => {
    await seedSyntheticLedger(page);
    await openAdvanced(page);

    const reserve = page.getByLabel(RESERVE_LABEL);
    const seed = page.getByLabel(SEED_LABEL, { exact: true });
    const planWindow = page.getByLabel(PLAN_WINDOW_LABEL);
    await expect(reserve).toHaveValue("0.00");
    await expect(seed).toHaveValue("42");
    await reserve.fill("500");

    await failNextSettingsWrite(page);
    await page.getByRole("button", { name: "Update results" }).click();

    const saveAlert = page.getByRole("alert").filter({ hasText: /Financial settings could not be saved/ });
    await expect(saveAlert).toBeVisible();
    await expect(reserve).toHaveValue("500");
    expect(await storedRaw(page, ASSUMPTIONS_STORAGE_KEY)).toBeNull();

    // A valid update from a real sibling tab refreshes applied values only.
    const sibling = await context.newPage();
    await sibling.goto("/");
    const siblingValues = {
      ...DEFAULT_ASSUMPTIONS,
      horizonDays: 120,
      seed: 777,
      reserveCents: 25_000,
    };
    await sibling.evaluate(
      ({ key, values }) => localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, values })),
      { key: ASSUMPTIONS_STORAGE_KEY, values: siblingValues }
    );

    await expect(page.getByText("Financial settings were updated in another tab.", { exact: true })).toBeVisible();
    await expect(planWindow).toHaveValue("120");
    await expect(seed).toHaveValue("777");
    await expect(reserve).toHaveValue("500");
    await expect(saveAlert).toBeVisible();
    await expect(page.getByText(ADVANCED_DRAFT_STATUS)).toBeVisible();

    const siblingStored = await storedAssumptions(sibling);
    expect(siblingStored?.values.reserveCents).toBe(25_000);
    expect(siblingStored?.values.seed).toBe(777);

    // Applying a sibling update must not clear the failed-draft guard either.
    const [leaveMessage] = await Promise.all([
      page.waitForEvent("dialog", { timeout: 5_000 }).then(async (dialog) => {
        const message = dialog.message();
        await dialog.dismiss();
        return message;
      }),
      page.getByRole("button", { name: "Home", exact: true }).click(),
    ]);
    expect(leaveMessage).toMatch(/not saved.*discard/i);
    await expect(page.getByRole("button", { name: "Advanced", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(reserve).toHaveValue("500");

    // An intentional retry is the only operation that clears this draft marker
    // and applies the values, including the sibling's untouched fields.
    await page.getByRole("button", { name: "Update results" }).click();
    await expect(saveAlert).toHaveCount(0);
    await expect(reserve).toHaveValue("500.00");
    await expect(page.getByText(APPLIED_STATUS)).toBeVisible();

    const durable = await storedAssumptions(page);
    expect(durable?.values).toMatchObject({ horizonDays: 120, seed: 777, reserveCents: 50_000 });
    expect(await storedRaw(page, LEDGER_STORAGE_KEY)).not.toBeNull();
    await sibling.close();
  });

  test("the default settings button requires confirmation and clears the draft only after success", async ({ page }) => {
    await seedSyntheticLedger(page);
    await openAdvanced(page);

    const reserve = page.getByLabel(RESERVE_LABEL);
    const applyDefaults = page.getByRole("button", { name: "Use the default assumptions" });
    await reserve.fill("500");

    // Declining the confirmation leaves the meaningful draft and storage alone.
    const [declined] = await Promise.all([
      page.waitForEvent("dialog").then(async (dialog) => {
        const message = dialog.message();
        await dialog.dismiss();
        return message;
      }),
      applyDefaults.click(),
    ]);
    expect(declined).toMatch(/discards the unsaved settings/i);
    await expect(reserve).toHaveValue("500");
    await expect(page.getByText(ADVANCED_DRAFT_STATUS)).toBeVisible();
    expect(await storedRaw(page, ASSUMPTIONS_STORAGE_KEY)).toBeNull();

    // A failed attempt keeps the draft too, even after the confirmation.
    await failNextSettingsWrite(page);
    await Promise.all([
      page.waitForEvent("dialog").then((dialog) => dialog.accept()),
      applyDefaults.click(),
    ]);
    const saveAlert = page.getByRole("alert").filter({ hasText: /Financial settings could not be saved/ });
    await expect(saveAlert).toBeVisible();
    await expect(reserve).toHaveValue("500");
    await expect(page.getByText(ADVANCED_DRAFT_STATUS)).toBeVisible();
    expect(await storedRaw(page, ASSUMPTIONS_STORAGE_KEY)).toBeNull();

    // Only a successful retry clears the draft and shows the applied defaults.
    await Promise.all([
      page.waitForEvent("dialog").then((dialog) => dialog.accept()),
      applyDefaults.click(),
    ]);
    await expect(saveAlert).toHaveCount(0);
    await expect(reserve).toHaveValue("0.00");
    await expect(page.getByText(APPLIED_STATUS)).toBeVisible();
    const durable = await storedAssumptions(page);
    expect(durable?.schemaVersion).toBe(1);
    expect(durable?.values.reserveCents).toBe(DEFAULT_ASSUMPTIONS.reserveCents);
  });

  test("global settings recovery preserves a failed draft until explicit discard", async ({ page, context }) => {
    await seedSyntheticLedger(page);
    await openAdvanced(page);

    const reserve = page.getByLabel(RESERVE_LABEL);
    const seed = page.getByLabel(SEED_LABEL, { exact: true });
    await reserve.fill("500");
    await failNextSettingsWrite(page);
    await page.getByRole("button", { name: "Update results" }).click();
    const saveAlert = page.getByRole("alert").filter({ hasText: /Financial settings could not be saved/ });
    await expect(saveAlert).toBeVisible();

    // Unreadable settings from the sibling produce the real global recovery
    // surface without touching the ledger or this Advanced draft.
    const sibling = await context.newPage();
    await sibling.goto("/");
    await sibling.evaluate(
      (key) => localStorage.setItem(key, '{"schemaVersion":99,"values":{}}'),
      ASSUMPTIONS_STORAGE_KEY
    );
    const settingsError = page.getByRole("heading", { name: "Financial Settings Not Loaded" });
    await expect(settingsError).toBeVisible();
    await expect(reserve).toHaveValue("500");
    await expect(saveAlert).toBeVisible();
    await expect(page.getByText(ADVANCED_DRAFT_STATUS)).toBeVisible();

    // Reload protection must keep this draft when the confirmation is declined.
    const [reloadMessage] = await Promise.all([
      page.waitForEvent("dialog").then(async (dialog) => {
        const message = dialog.message();
        await dialog.dismiss();
        return message;
      }),
      page.getByRole("link", { name: "Retry", exact: true }).click(),
    ]);
    expect(reloadMessage).toMatch(/discards.*draft/i);
    await expect(page.getByRole("button", { name: "Advanced", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(reserve).toHaveValue("500");
    await expect(saveAlert).toBeVisible();

    // The separate global recovery button applies defaults but must preserve
    // both the typed field and the failed-draft state.
    await page.getByRole("button", { name: "Use default financial assumptions" }).click();
    await expect(settingsError).toHaveCount(0);
    await expect(reserve).toHaveValue("500");
    await expect(seed).toHaveValue("42");
    await expect(saveAlert).toBeVisible();
    await expect(page.getByText(ADVANCED_DRAFT_STATUS)).toBeVisible();
    const recovered = await storedAssumptions(page);
    expect(recovered?.values.reserveCents).toBe(DEFAULT_ASSUMPTIONS.reserveCents);

    // Explicit discard clears this form back to applied values without writing.
    const beforeDiscard = await storedRaw(page, ASSUMPTIONS_STORAGE_KEY);
    const ledgerBeforeDiscard = await storedRaw(page, LEDGER_STORAGE_KEY);
    await page.getByRole("button", { name: "Discard settings draft" }).click();
    await expect(reserve).toHaveValue("0.00");
    await expect(saveAlert).toHaveCount(0);
    await expect(page.getByText(APPLIED_STATUS)).toBeVisible();
    expect(await storedRaw(page, ASSUMPTIONS_STORAGE_KEY)).toBe(beforeDiscard);
    expect(await storedRaw(page, LEDGER_STORAGE_KEY)).toBe(ledgerBeforeDiscard);

    // The discarded draft no longer holds navigation.
    let navigationPrompt: string | null = null;
    const onDialog = async (dialog: Dialog) => {
      navigationPrompt = dialog.message();
      await dialog.dismiss();
    };
    page.on("dialog", onDialog);
    try {
      await page.getByRole("button", { name: "Home", exact: true }).click();
      await expect(page.getByRole("button", { name: "Home", exact: true })).toHaveAttribute("aria-current", "page");
    } finally {
      page.off("dialog", onDialog);
    }
    expect(navigationPrompt).toBeNull();
    await sibling.close();
  });
});

test.describe("reconciliation preview availability", () => {
  test("a settings failure blocks reconciliation without changing the saved $1,000 ledger", async ({ page, context }) => {
    await page.clock.install({ time: new Date(`${AS_OF}T12:00:00.000Z`) });
    await seedSyntheticLedger(page);
    await openMoney(page);

    const target = page.getByLabel("Balance you want recorded ($)");
    const reconcile = page.getByRole("button", { name: "Reconcile Ledger", exact: true });
    const reconcilePanel = page.getByRole("heading", { name: "Match your balance", exact: true }).locator("..");
    await expect(target).toHaveValue("1000.00");
    await expect(reconcile).toBeEnabled();
    await expect(reconcilePanel.getByText(/This will add an adjustment/)).toHaveCount(0);

    // Real unreadable settings from a sibling tab remove the checked cash basis.
    const sibling = await context.newPage();
    await sibling.goto("/");
    await sibling.evaluate(
      (key) => localStorage.setItem(key, '{"schemaVersion":99,"values":{}}'),
      ASSUMPTIONS_STORAGE_KEY
    );
    const settingsError = page.getByRole("heading", { name: "Financial Settings Not Loaded" });
    await expect(settingsError).toBeVisible();
    await expect(target).toHaveValue("1000.00");
    await expect(target).toHaveAttribute("readonly", "");
    await expect(reconcile).toBeDisabled();
    await expect(reconcilePanel.getByText(/no adjustment preview can be shown/i)).toBeVisible();
    await expect(reconcilePanel.getByText(/This will add an adjustment/)).toHaveCount(0);

    // Money editing still works while the settings failure is present.
    await page.getByRole("textbox", { name: "Amount ($)", exact: true }).fill("50");
    await page.getByLabel("Note", { exact: true }).fill("Synthetic separate expense");
    await page.getByRole("button", { name: "Record this", exact: true }).click();
    await expect(page.getByText("Synthetic separate expense", { exact: true })).toBeVisible();
    await expect(target).toHaveValue("1000.00");
    await expect(reconcile).toBeDisabled();
    await expect(reconcilePanel.getByText(/This will add an adjustment/)).toHaveCount(0);

    const rawAfterExpense = await storedRaw(page, LEDGER_STORAGE_KEY);
    expect(rawAfterExpense).not.toBeNull();
    const savedAfterExpense = JSON.parse(rawAfterExpense ?? "null");
    expect(savedAfterExpense.current_balance_cents).toBe(95_000);
    expect(savedAfterExpense.transactions).toHaveLength(2);

    // A programmatic submit bypasses the disabled control but must hit the
    // handler's availability check before any adjustment is built.
    const reconcileForm = page.locator("form").filter({ has: reconcile });
    await reconcileForm.evaluate((form) => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await expect(
      page.getByRole("alert").filter({ hasText: /Reconcile was not submitted because the current cash summary/i })
    ).toBeVisible();
    expect(await storedRaw(page, LEDGER_STORAGE_KEY)).toBe(rawAfterExpense);
    await expect(target).toHaveValue("1000.00");
    const stillSaved = JSON.parse((await storedRaw(page, LEDGER_STORAGE_KEY)) ?? "null");
    expect(stillSaved.current_balance_cents).toBe(95_000);
    expect(stillSaved.transactions).toHaveLength(2);

    // Global recovery restores the verified preview from the raw $950 basis.
    await page.getByRole("button", { name: "Use default financial assumptions" }).click();
    await expect(settingsError).toHaveCount(0);
    await expect(target).toBeEnabled();
    await expect(reconcile).toBeEnabled();
    await expect(target).toHaveValue("1000.00");
    await expect(
      reconcilePanel.getByText("This will add an adjustment of $50.00 dated Nov 15, 2026.", { exact: true })
    ).toBeVisible();
    expect(await storedRaw(page, LEDGER_STORAGE_KEY)).toBe(rawAfterExpense);

    // A failed write pins the date; the pin must not allow even a preview
    // when a later failure invalidates the cash summary.
    await failNextLedgerWrite(page);
    await reconcile.click();
    await expect(reconcilePanel.getByRole("alert").filter({ hasText: /previous saved data is intact/i })).toBeVisible();
    expect(await storedRaw(page, LEDGER_STORAGE_KEY)).toBe(rawAfterExpense);
    await sibling.evaluate(
      (key) => localStorage.setItem(key, '{"schemaVersion":99,"values":{}}'),
      ASSUMPTIONS_STORAGE_KEY
    );
    await expect(settingsError).toBeVisible();
    await expect(reconcile).toBeDisabled();
    await expect(target).toHaveValue("1000.00");
    await expect(reconcilePanel.getByText(/This will add an adjustment/)).toHaveCount(0);
    await page.getByRole("button", { name: "Use default financial assumptions" }).click();
    await expect(settingsError).toHaveCount(0);
    await expect(reconcilePanel.getByText(/adjustment of \$50\.00 dated Nov 15, 2026/)).toBeVisible();

    // No adjustment is written when the typed balance already matches.
    await target.fill("950.00");
    await expect(
      reconcilePanel.getByText("This already matches the recorded balance. No adjustment will be added.", { exact: true })
    ).toBeVisible();
    await reconcile.click();
    await expect(page.getByRole("alert").filter({ hasText: /already matches the recorded balance/i })).toBeVisible();
    expect(await storedRaw(page, LEDGER_STORAGE_KEY)).toBe(rawAfterExpense);
    await sibling.close();
  });
});
