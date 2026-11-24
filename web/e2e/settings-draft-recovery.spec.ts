import { expect, test, type Dialog, type Page } from "@playwright/test";

import { DEFAULT_ASSUMPTIONS, type Assumptions } from "../src/lib/assumptions";
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
const ADVANCED_DRAFT_STATUS = /Unsaved settings draft/;
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

/** Adds one supported monthly bill so Advanced has a visible Technical result. */
function scheduledLedger(): LedgerState {
  const ledger = syntheticLedger();
  return {
    ...ledger,
    payments: [
      {
        id: "payment-synthetic",
        name: "Synthetic bill",
        amount_cents: 25_000,
        recurrence: "Monthly",
        due_day: 20,
        is_auto_withdraw: false,
      },
    ],
  };
}

async function seedLedger(page: Page, ledger: LedgerState): Promise<void> {
  await page.addInitScript(
    ({ key, state }) => localStorage.setItem(key, JSON.stringify(state)),
    { key: LEDGER_STORAGE_KEY, state: ledger }
  );
  await page.goto("/");
}

function seedSyntheticLedger(page: Page): Promise<void> {
  return seedLedger(page, syntheticLedger());
}

function seedScheduledLedger(page: Page): Promise<void> {
  return seedLedger(page, scheduledLedger());
}

async function seedSavedSettings(page: Page, assumptions: Assumptions): Promise<void> {
  await page.addInitScript(
    ({ key, values }) => localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, values })),
    { key: ASSUMPTIONS_STORAGE_KEY, values: assumptions }
  );
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

/**
 * Let the real write land, then fail the verification read once. A later explicit
 * reread is still possible, so the test cannot rely on storage staying broken.
 */
async function failSettingsVerificationAfterWrite(page: Page): Promise<void> {
  await page.evaluate((assumptionsKey) => {
    const originalGet = Storage.prototype.getItem;
    const originalSet = Storage.prototype.setItem;
    const local = window.localStorage;
    let wrote = false;
    let verificationFailed = false;
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      const result = originalSet.call(this, key, value);
      if (this === local && key === assumptionsKey) {
        wrote = true;
        Storage.prototype.setItem = originalSet;
      }
      return result;
    };
    Storage.prototype.getItem = function (this: Storage, key: string) {
      if (this === local && key === assumptionsKey && wrote && !verificationFailed) {
        verificationFailed = true;
        Storage.prototype.getItem = originalGet;
        throw new DOMException("Synthetic settings verification failure", "UnknownError");
      }
      return originalGet.call(this, key);
    };
  }, ASSUMPTIONS_STORAGE_KEY);
}

/**
 * Mutate the settings key, report a failed write, then refuse the rollback too.
 * The next explicit reread works, so only the write/rollback path is faulty.
 */
async function failSettingsRollbackAfterMutation(page: Page): Promise<void> {
  await page.evaluate((assumptionsKey) => {
    const originalSet = Storage.prototype.setItem;
    const originalRemove = Storage.prototype.removeItem;
    const local = window.localStorage;
    let phase: "write" | "rollback" | "done" = "write";
    function restore(): void {
      phase = "done";
      Storage.prototype.setItem = originalSet;
      Storage.prototype.removeItem = originalRemove;
    }
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      if (this === local && key === assumptionsKey) {
        if (phase === "write") {
          phase = "rollback";
          originalSet.call(this, key, value);
          throw new DOMException("Synthetic settings write failure after mutation", "QuotaExceededError");
        }
        if (phase === "rollback") {
          restore();
          throw new DOMException("Synthetic settings rollback refusal", "SecurityError");
        }
      }
      return originalSet.call(this, key, value);
    };
    Storage.prototype.removeItem = function (this: Storage, key: string) {
      if (this === local && key === assumptionsKey && phase === "rollback") {
        restore();
        throw new DOMException("Synthetic settings rollback refusal", "SecurityError");
      }
      return originalRemove.call(this, key);
    };
  }, ASSUMPTIONS_STORAGE_KEY);
}

/**
 * Suppress the app's settings storage listener in this page only. A local,
 * early capture listener records that the native event arrived, then stops it
 * before the bubble listener registered after hydration can run.
 */
async function suppressSettingsStorageEvents(page: Page): Promise<void> {
  await page.addInitScript((assumptionsKey) => {
    const marker = window as Window & { __suppressedSettingsEvents?: number };
    marker.__suppressedSettingsEvents = 0;
    window.addEventListener(
      "storage",
      (event) => {
        if (event.key !== assumptionsKey) return;
        marker.__suppressedSettingsEvents = (marker.__suppressedSettingsEvents ?? 0) + 1;
        event.stopImmediatePropagation();
      },
      true
    );
  }, ASSUMPTIONS_STORAGE_KEY);
}

function suppressedSettingsEvents(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as Window & { __suppressedSettingsEvents?: number }).__suppressedSettingsEvents ?? 0
  );
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

  test("a delayed settings storage event cannot let a stale draft overwrite a sibling's saved reserve", async ({ page, context }) => {
    await suppressSettingsStorageEvents(page);
    await seedScheduledLedger(page);
    await openAdvanced(page);

    const planWindow = page.getByLabel(PLAN_WINDOW_LABEL);
    const reserve = page.getByLabel(RESERVE_LABEL);
    const technical = page.getByRole("heading", { name: "Technical result" });
    await expect(technical).toBeVisible();
    await expect(reserve).toHaveValue("0.00");
    const ledgerBefore = await storedRaw(page, LEDGER_STORAGE_KEY);

    // B saves through the real Advanced controls. A receives the native event
    // but its early capture listener suppresses the app listener.
    const sibling = await context.newPage();
    await sibling.goto("/");
    await openAdvanced(sibling);
    const siblingReserve = sibling.getByLabel(RESERVE_LABEL);
    await siblingReserve.fill("500");
    await sibling.getByRole("button", { name: "Update results" }).click();
    await expect(siblingReserve).toHaveValue("500.00");

    const siblingRaw = await storedRaw(page, ASSUMPTIONS_STORAGE_KEY);
    expect(siblingRaw).not.toBeNull();
    expect(JSON.parse(siblingRaw ?? "{}").values.reserveCents).toBe(50_000);

    // Proving the event arrived prevents a timing race from masquerading as
    // suppression: A still shows its stale applied reserve and no update notice.
    await expect.poll(() => suppressedSettingsEvents(page)).toBeGreaterThanOrEqual(1);
    await expect(reserve).toHaveValue("0.00");
    await expect(page.getByText("Financial settings were updated in another tab.", { exact: true })).toHaveCount(0);

    // A edits only the window. Its reserve is pristine and comes from the stale
    // snapshot, so the submitted plan would silently replace B's $500 reserve.
    await planWindow.fill("120");
    await page.getByRole("button", { name: "Update results" }).click();

    expect(await storedRaw(page, ASSUMPTIONS_STORAGE_KEY)).toBe(siblingRaw);
    const conflict = page.getByRole("alert").filter({ hasText: /financial settings changed in another tab/i });
    await expect(conflict).toBeVisible();
    expect(await storedRaw(page, ASSUMPTIONS_STORAGE_KEY)).toBe(siblingRaw);
    await expect(planWindow).toHaveValue("120");
    await expect(reserve).toHaveValue("500.00");
    await expect(page.getByText(ADVANCED_DRAFT_STATUS)).toBeVisible();

    // The conflict path adopts the checked durable snapshot, so the visible
    // result follows B's reserve even though A never received the storage event.
    await expect(
      page.getByText("Reserve subtracted", { exact: true }).locator("..")
    ).toContainText("$500.00");
    expect(await storedRaw(page, LEDGER_STORAGE_KEY)).toBe(ledgerBefore);

    // An intentional retry merges A's dirty field onto that checked snapshot.
    await page.getByRole("button", { name: "Update results" }).click();
    await expect(conflict).toHaveCount(0);
    await expect(planWindow).toHaveValue("120");
    await expect(reserve).toHaveValue("500.00");
    const merged = await storedAssumptions(page);
    expect(merged?.values).toMatchObject({ horizonDays: 120, reserveCents: 50_000 });
    expect(await storedRaw(page, LEDGER_STORAGE_KEY)).toBe(ledgerBefore);

    // B receives the normal event path for A's completed save.
    await expect(sibling.getByLabel(PLAN_WINDOW_LABEL)).toHaveValue("120");
    await sibling.close();
  });

  test("a settings write whose verification read throws withholds the forecast until saved settings are reread", async ({ page }) => {
    await exerciseIndeterminateSettingsWrite(page, failSettingsVerificationAfterWrite);
  });

  test("a settings write that reports failure after mutating and refuses rollback stays uncertain until saved settings are reread", async ({ page }) => {
    await exerciseIndeterminateSettingsWrite(page, failSettingsRollbackAfterMutation);
  });
});

async function exerciseIndeterminateSettingsWrite(
  page: Page,
  installFault: (page: Page) => Promise<void>
): Promise<void> {
  const oldSettings = { ...DEFAULT_ASSUMPTIONS, reserveCents: 10_000 };
  await seedSavedSettings(page, oldSettings);
  await seedScheduledLedger(page);
  await openAdvanced(page);

  const planWindow = page.getByLabel(PLAN_WINDOW_LABEL);
  const reserve = page.getByLabel(RESERVE_LABEL);
  const technical = page.getByRole("heading", { name: "Technical result" });
  await expect(technical).toBeVisible();
  await expect(reserve).toHaveValue("100.00");
  await expect(
    page.getByText("Reserve subtracted", { exact: true }).locator("..")
  ).toContainText("$100.00");
  const ledgerBefore = await storedRaw(page, LEDGER_STORAGE_KEY);
  const oldRaw = await storedRaw(page, ASSUMPTIONS_STORAGE_KEY);

  await installFault(page);
  await reserve.fill("500");
  await page.getByRole("button", { name: "Update results" }).click();

  // The fault occurs after the store has changed. It is not a rejected input
  // or an ordinary failed write with a verified rollback.
  await expect.poll(async () => (await storedAssumptions(page))?.values.reserveCents).toBe(50_000);
  const settingsError = page.getByRole("heading", { name: "Financial Settings Not Loaded" });
  const uncertain = page.getByRole("alert").filter({ hasText: /some or all.*may have persisted/i });
  const keptDraft = page.getByRole("alert").filter({ hasText: /Your settings draft was kept/i });
  await expect(settingsError).toBeVisible();
  await expect(uncertain.first()).toBeVisible();
  await expect(keptDraft).toBeVisible();
  await expect(technical).toHaveCount(0);
  await expect(reserve).toHaveValue("500");
  await expect(page.getByText(ADVANCED_DRAFT_STATUS)).toBeVisible();
  expect(await storedRaw(page, LEDGER_STORAGE_KEY)).toBe(ledgerBefore);

  // The mutation may remain durable even though the outcome is unknown. It did
  // replace the old settings; the old assumptions cannot be used as a fallback.
  const durableRaw = await storedRaw(page, ASSUMPTIONS_STORAGE_KEY);
  expect(durableRaw).not.toBeNull();
  expect(durableRaw).not.toBe(oldRaw);
  expect(JSON.parse(durableRaw ?? "{}").values.reserveCents).toBe(50_000);

  // The explicit recovery read is non-writing and must not clear this draft.
  await planWindow.fill("120");
  await page.getByRole("button", { name: "Read saved settings", exact: true }).click();
  await expect(settingsError).toHaveCount(0);
  await expect(technical).toBeVisible();
  await expect(planWindow).toHaveValue("120");
  await expect(page.getByText(ADVANCED_DRAFT_STATUS)).toBeVisible();
  await expect(keptDraft).toBeVisible();
  await expect(
    page.getByText("Reserve subtracted", { exact: true }).locator("..")
  ).toContainText("$500.00");
  expect(await storedRaw(page, ASSUMPTIONS_STORAGE_KEY)).toBe(durableRaw);
  expect(await storedRaw(page, LEDGER_STORAGE_KEY)).toBe(ledgerBefore);
}

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

test("a held financial-settings lock keeps the editor pending and prevents navigation", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Advanced", exact: true }).click();
  await page.evaluate((name) => new Promise<void>((acquired) => {
    const harness = window as Window & { releaseTestSettingsLock?: () => void };
    const hold = new Promise<void>((release) => { harness.releaseTestSettingsLock = release; });
    void navigator.locks.request(name, () => {
      acquired();
      return hold;
    });
  }), "montecarlo-financial-settings-write");

  await page.getByLabel(RESERVE_LABEL).fill("400");
  await page.getByRole("button", { name: "Update results" }).click();
  await expect(page.getByText("Saving financial settings", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Home", exact: true })).toBeDisabled();

  // The queued write is not submitted twice and the editor stays on this section.
  await page.getByRole("button", { name: "Home", exact: true }).click({ force: true });
  await expect(page.getByRole("status").filter({ hasText: "Saving financial settings" })).toBeVisible();

  await page.evaluate(() => {
    const harness = window as Window & { releaseTestSettingsLock?: () => void };
    harness.releaseTestSettingsLock?.();
  });
  await expect.poll(async () => page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw).values?.reserveCents;
  }, ASSUMPTIONS_STORAGE_KEY)).toBe(40000);
  await expect(page.getByText(APPLIED_STATUS)).toBeVisible();
});
