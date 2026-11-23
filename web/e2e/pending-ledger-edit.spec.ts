import { expect, test, type Page } from "@playwright/test";

import { LEDGER_LOCK_NAME, LEDGER_STORAGE_KEY } from "../src/lib/persistence";
import type { LedgerState } from "../src/lib/types";

/**
 * Ordinary-edit draft safety.
 *
 * Every test uses the real Web Locks implementation and a synthetic ledger that
 * is seeded into this test's isolated browser context. No vault, network route,
 * real ledger, or fixed sleep is involved.
 */

interface PendingLedgerHarness {
  releasePendingLedgerLock?: () => void;
}

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
  await page.goto("/");
  await page.evaluate(
    ({ key, state }) => localStorage.setItem(key, JSON.stringify(state)),
    { key: LEDGER_STORAGE_KEY, state: syntheticLedger() }
  );
  await page.reload();
}

async function openMoney(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Money", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Amount ($)", exact: true })).toBeVisible();
}

async function holdLedgerLock(page: Page): Promise<void> {
  await page.evaluate(
    (name) =>
      new Promise<void>((acquired) => {
        const harness = window as Window & PendingLedgerHarness;
        const hold = new Promise<void>((release) => {
          harness.releasePendingLedgerLock = release;
        });
        void navigator.locks.request(name, () => {
          acquired();
          return hold;
        });
      }),
    LEDGER_LOCK_NAME
  );
}

async function releaseLedgerLock(page: Page): Promise<void> {
  await page.evaluate(() => {
    const harness = window as Window & PendingLedgerHarness;
    const release = harness.releasePendingLedgerLock;
    delete harness.releasePendingLedgerLock;
    release?.();
  });
}

/** Dispatch the native event the browser fires for a close or reload. */
async function dispatchBeforeUnload(page: Page): Promise<{ defaultPrevented: boolean; dispatchResult: boolean }> {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    const dispatchResult = window.dispatchEvent(event);
    return { defaultPrevented: event.defaultPrevented, dispatchResult };
  });
}

function storedRaw(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), LEDGER_STORAGE_KEY);
}

function queuedWrites(page: Page): Promise<number> {
  return page.evaluate(
    async (name) => (await navigator.locks.query()).pending?.filter((lock) => lock.name === name).length ?? 0,
    LEDGER_LOCK_NAME
  );
}

function recordForm(page: Page) {
  return page.locator("form").filter({ has: page.getByRole("button", { name: "Record this" }) });
}

test.describe("ordinary ledger edit draft safety", () => {
  test("a pending edit keeps its draft, blocks a same-tab second save, and protects reload", async ({ page }) => {
    await seedSyntheticLedger(page);
    await openMoney(page);

    const amount = page.getByRole("textbox", { name: "Amount ($)", exact: true });
    const note = page.getByLabel("Note", { exact: true });
    await page.getByLabel("Category").fill("Pending");
    await amount.fill("42.50");
    await note.fill("Pending note");
    const originalRaw = await storedRaw(page);

    await holdLedgerLock(page);
    try {
      await page.getByRole("button", { name: "Record this" }).click();

      await expect(page.getByText("Saving your ledger change", { exact: true })).toBeVisible();
      await expect(amount).toHaveValue("42.50");
      await expect(note).toHaveValue("Pending note");
      await expect(page.getByRole("button", { name: "Record this" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Plan", exact: true })).toBeDisabled();
      await expect(page.getByRole("button", { name: /Cloud Vault/ })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Use sample" })).toBeDisabled();
      await expect(page.getByRole("button", { name: "Export", exact: true })).toBeEnabled();
      expect(await storedRaw(page)).toBe(originalRaw);

      // The native handler is registered while the write is actually outstanding.
      const beforeUnload = await dispatchBeforeUnload(page);
      expect(beforeUnload.defaultPrevented).toBe(true);
      expect(beforeUnload.dispatchResult).toBe(false);
      await Promise.all([
        page.waitForEvent("dialog").then(async (dialog) => {
          const type = dialog.type();
          await dialog.dismiss();
          expect(type).toBe("beforeunload");
        }),
        page.close({ runBeforeUnload: true }),
      ]);
      expect(page.isClosed()).toBe(false);

      // A programmatic second submission exercises the same synchronous guard as
      // a second click would; it must not queue a write or report success.
      await recordForm(page).evaluate((form) => {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      });
      await expect(page.getByRole("alert").filter({ hasText: "still being saved" })).toBeVisible();
      expect(await storedRaw(page)).toBe(originalRaw);
      await expect(amount).toHaveValue("42.50");
      await expect(note).toHaveValue("Pending note");
      // Exactly one legitimate write is queued behind the lock this test holds;
      // the rejected second submission did not queue another request.
      expect(await queuedWrites(page)).toBe(1);
    } finally {
      await releaseLedgerLock(page);
    }

    // Only the first, valid edit reaches storage, and only then are the fields
    // cleared. Exactly one transaction was added from this tab.
    await expect(page.getByText("Saving your ledger change", { exact: true })).toHaveCount(0);
    await expect(amount).toHaveValue("");
    await expect(note).toHaveValue("");
    const durable = JSON.parse((await storedRaw(page)) ?? "null");
    expect(durable.current_balance_cents).toBe(95_750);
    expect(durable.transactions).toHaveLength(2);
    expect(durable.transactions.filter((tx: { description?: string }) => tx.description === "Pending note")).toHaveLength(1);

    // Completion removes the native handler; it is not left armed.
    const afterUnload = await dispatchBeforeUnload(page);
    expect(afterUnload.defaultPrevented).toBe(false);
    expect(afterUnload.dispatchResult).toBe(true);
  });

  test("a stale commit keeps the durable sibling state and preserves the failed draft", async ({ page, context }) => {
    await seedSyntheticLedger(page);
    await openMoney(page);

    const amount = page.getByRole("textbox", { name: "Amount ($)", exact: true });
    const note = page.getByLabel("Note", { exact: true });
    await page.getByLabel("Category").fill("Stale");
    await amount.fill("78.90");
    await note.fill("Not saved note");
    const originalRaw = await storedRaw(page);
    const sibling = await context.newPage();
    await sibling.goto("/");
    await openMoney(sibling);
    await sibling.getByRole("textbox", { name: "Amount ($)", exact: true }).fill("11.11");
    await sibling.getByLabel("Note", { exact: true }).fill("Sibling update");

    await holdLedgerLock(page);
    try {
      // Both normal user edits saw the same initial ledger. Queue the sibling
      // first so it commits before this tab checks the snapshot it was shown.
      await sibling.getByRole("button", { name: "Record this" }).click();
      await expect.poll(() => queuedWrites(page)).toBe(1);
      await page.getByRole("button", { name: "Record this" }).click();
      await expect.poll(() => queuedWrites(page)).toBe(2);
      await expect(page.getByText("Saving your ledger change", { exact: true })).toBeVisible();
      await expect(amount).toHaveValue("78.90");
      await expect(note).toHaveValue("Not saved note");
      expect(await storedRaw(page)).toBe(originalRaw);
    } finally {
      await releaseLedgerLock(page);
    }

    await expect(sibling.getByText("Sibling update", { exact: true })).toBeVisible();
    const siblingRaw = await storedRaw(sibling);
    await sibling.close();
    expect(siblingRaw).not.toBe(originalRaw);
    await expect(page.getByText("Saving your ledger change", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Not saved", { exact: true })).toBeVisible();
    await expect(page.getByText(/stored ledger changed in another tab/i).first()).toBeVisible();
    // The failed form keeps the submitted amount and note for a retry.
    await expect(amount).toHaveValue("78.90");
    await expect(note).toHaveValue("Not saved note");
    expect(await storedRaw(page)).toBe(siblingRaw);

    const durable = JSON.parse(siblingRaw ?? "null");
    expect(durable.current_balance_cents).toBe(98_889);
    expect(durable.transactions.some((tx: { description?: string }) => tx.description === "Sibling update")).toBe(true);
    expect(durable.transactions.some((tx: { description?: string }) => tx.description === "Not saved note")).toBe(false);

    // Failure also removes the native handler rather than trapping the tab.
    const afterFailureUnload = await dispatchBeforeUnload(page);
    expect(afterFailureUnload.defaultPrevented).toBe(false);

    // An explicit reload proves the durable state is the sibling's, not a
    // partially applied or invented mix of both attempts.
    await page.reload();
    await expect(page.getByText("Sibling update", { exact: true })).toBeVisible();
    await expect(page.getByText("Not saved note", { exact: true })).toHaveCount(0);
    // The failed draft was retained only in the tab's component state; it is not
    // a new durable store, so a fresh load starts from the valid ledger.
    await expect(page.getByRole("textbox", { name: "Amount ($)", exact: true })).toHaveValue("");
    expect(await storedRaw(page)).toBe(siblingRaw);
  });
});
