import { expect, test, type Dialog, type Page } from "@playwright/test";

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

function syntheticLedger(liabilities: LedgerState["liabilities"] = []): LedgerState {
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
    liabilities,
  };
}

async function seedSyntheticLedger(page: Page, state: LedgerState = syntheticLedger()): Promise<void> {
  await page.goto("/");
  await page.evaluate(
    ({ key, ledger }) => localStorage.setItem(key, JSON.stringify(ledger)),
    { key: LEDGER_STORAGE_KEY, ledger: state }
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

    // Section navigation cannot silently unmount the failed draft. Rejecting the
    // confirmation keeps this tab in Money with the exact submitted values and
    // the same saved-warning notice.
    const plan = page.getByRole("button", { name: "Plan", exact: true });
    const [declined] = await Promise.all([
      page.waitForEvent("dialog").then(async (dialog) => {
        const result = { type: dialog.type(), message: dialog.message() };
        await dialog.dismiss();
        return result;
      }),
      plan.click(),
    ]);
    expect(declined.type).toBe("confirm");
    expect(declined.message).toMatch(/not saved.*discard/i);
    await expect(page.getByRole("button", { name: "Money", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(page.getByText("Not saved", { exact: true })).toBeVisible();
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

    // Only accepting the discard lets this route change and clear the draft;
    // it never changes the ledger that the other tab saved.
    const [accepted] = await Promise.all([
      page.waitForEvent("dialog").then(async (dialog) => {
        const type = dialog.type();
        await dialog.accept();
        return type;
      }),
      plan.click(),
    ]);
    expect(accepted).toBe("confirm");
    await expect(plan).toHaveAttribute("aria-current", "page");
    await openMoney(page);
    await expect(amount).toHaveValue("");
    await expect(note).toHaveValue("");
    expect(await storedRaw(page)).toBe(siblingRaw);

    // An explicit reload proves only the sibling's durable edit was kept.
    await page.reload();
    await expect(page.getByText("Sibling update", { exact: true })).toBeVisible();
    await expect(page.getByText("Not saved note", { exact: true })).toHaveCount(0);
    // The failed draft was retained only in the tab's component state; it is not
    // a new durable store, so a fresh load starts from the valid ledger.
    await expect(page.getByRole("textbox", { name: "Amount ($)", exact: true })).toHaveValue("");
    expect(await storedRaw(page)).toBe(siblingRaw);
  });

  test("a pending debt save disables Plan's decision tabs", async ({ page }) => {
    await seedSyntheticLedger(page);
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await page.getByRole("tab", { name: "How do I pay off debt?" }).click();
    await page.getByLabel("Debt name").fill("Pending card");
    await page.getByLabel("Amount still owed ($)").fill("500");
    await page.getByLabel("Interest rate (%)").fill("21.99");
    await page.getByLabel("Minimum payment ($)").fill("25");
    await page.getByLabel(/Usual payment day/).fill("15");
    const originalRaw = await storedRaw(page);

    await holdLedgerLock(page);
    try {
      await page.getByRole("button", { name: "Add debt" }).click();
      await expect(page.getByText("Saving your ledger change", { exact: true })).toBeVisible();
      for (const label of [
        "Can I afford a purchase?",
        "What if payday is late?",
        "What if a bill changes?",
        "What if I set money aside?",
        "How do I pay off debt?",
      ]) {
        await expect(page.getByRole("tab", { name: label })).toBeDisabled();
      }
      // The form draft is still only in memory while the write is outstanding.
      expect(await storedRaw(page)).toBe(originalRaw);
    } finally {
      await releaseLedgerLock(page);
    }
  await expect(page.getByText("Saving your ledger change", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "Can I afford a purchase?" })).toBeEnabled();
    const saved = JSON.parse((await storedRaw(page)) ?? "null");
    expect(saved.liabilities).toMatchObject([{ name: "Pending card", balance_cents: 50_000, min_payment_cents: 2_500 }]);
  });

  test("a failed balance draft survives editor switches and its Cancel clears only its marker", async ({ page, context }) => {
    await seedSyntheticLedger(
      page,
      syntheticLedger([
        {
          id: "debt-a",
          name: "Card A",
          balance_cents: 120_000,
          apr_basis_points: 1_999,
          min_payment_cents: 5_000,
          due_day_of_month: 5,
        },
        {
          id: "debt-b",
          name: "Card B",
          balance_cents: 80_000,
          apr_basis_points: 1_499,
          min_payment_cents: 3_000,
          due_day_of_month: 12,
        },
      ])
    );
    const originalRaw = await storedRaw(page);
    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await page.getByRole("tab", { name: "How do I pay off debt?" }).click();
    await expect(page.getByRole("button", { name: "Update balance for Card A" })).toBeVisible();

    // The sibling tab only advances the durable ledger. Neither debt changes,
    // so this tab's snapshot becomes stale without touching either draft.
    const sibling = await context.newPage();
    await sibling.goto("/");
    await openMoney(sibling);
    await sibling.getByRole("textbox", { name: "Amount ($)", exact: true }).fill("12.34");
    await sibling.getByLabel("Note", { exact: true }).fill("Sibling advance");
    await sibling.getByRole("button", { name: "Record this" }).click();
    await expect(sibling.getByText("Sibling advance", { exact: true })).toBeVisible();
    const siblingRaw = await storedRaw(sibling);
    expect(siblingRaw).not.toBe(originalRaw);

    // Saving a balance now is a real stale conflict: the durable raw moved after
    // this tab read it, so the submitted draft must survive the failure.
    const balanceA = page.getByLabel("Lender balance for Card A ($)");
    await page.getByRole("button", { name: "Update balance for Card A" }).click();
    await balanceA.fill("4321.09");
    await page.getByRole("button", { name: "Save balance" }).click();
    await expect(page.getByText("Not saved", { exact: true })).toBeVisible();
    await expect(page.getByText(/stored ledger changed in another tab/i).first()).toBeVisible();
    await expect(balanceA).toHaveValue("4321.09");
    expect(await storedRaw(page)).toBe(siblingRaw);

    // The failed draft still blocks ordinary section navigation.
    const [declined] = await Promise.all([
      page.waitForEvent("dialog").then(async (dialog) => {
        const result = { type: dialog.type(), message: dialog.message() };
        await dialog.dismiss();
        return result;
      }),
      page.getByRole("button", { name: "Home", exact: true }).click(),
    ]);
    expect(declined.type).toBe("confirm");
    expect(declined.message).toMatch(/not saved.*discard/i);
    await expect(page.getByRole("button", { name: "Plan", exact: true })).toHaveAttribute("aria-current", "page");

    // Reopening/switching is not a discard. Keep two independent failed
    // drafts, so the test can distinguish clearing one marker from clearing all.
    const balanceB = page.getByLabel("Lender balance for Card B ($)");
    const rowA = page.locator("li").filter({ hasText: "Card A" });
    const rowB = page.locator("li").filter({ hasText: "Card B" });
    const switchDialogs: string[] = [];
    const onSwitchDialog = async (dialog: Dialog) => {
      switchDialogs.push(dialog.message());
      await dialog.dismiss();
    };
    page.on("dialog", onSwitchDialog);
    try {
      await page.getByRole("button", { name: "Update balance for Card A" }).click();
      await expect(balanceA).toHaveValue("4321.09");
      await page.getByRole("button", { name: "Update balance for Card B" }).click();
      await balanceB.fill("77.77");
      await rowB.getByRole("button", { name: "Save balance" }).click();
      await expect(rowB.getByRole("alert")).toContainText(/changed in another tab/i);
      await page.getByRole("button", { name: "Update balance for Card A" }).click();
      await expect(balanceA).toHaveValue("4321.09");
      await expect(rowA.getByRole("alert")).toContainText(/changed in another tab/i);
      await page.getByRole("button", { name: "Update balance for Card B" }).click();
      await expect(balanceB).toHaveValue("77.77");
    } finally {
      page.off("dialog", onSwitchDialog);
    }
    expect(switchDialogs).toEqual([]);
    expect(await storedRaw(page)).toBe(siblingRaw);

    // Cancel A without clearing B's independent failed draft or its guard.
    await page.getByRole("button", { name: "Update balance for Card A" }).click();
    await rowA.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(balanceA).toHaveCount(0);
    await page.getByRole("button", { name: "Update balance for Card B" }).click();
    await expect(balanceB).toHaveValue("77.77");
    const [remainingGuard] = await Promise.all([
      page.waitForEvent("dialog").then(async (dialog) => {
        const type = dialog.type();
        await dialog.dismiss();
        return type;
      }),
      page.getByRole("button", { name: "Home", exact: true }).click(),
    ]);
    expect(remainingGuard).toBe("confirm");
    await expect(balanceB).toHaveValue("77.77");
    await rowB.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(balanceB).toHaveCount(0);

    // With both failures explicitly discarded, there is no phantom warning.
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

    // Discarding the failed draft did not touch the sibling's durable update or
    // either debt balance.
    expect(await storedRaw(page)).toBe(siblingRaw);
    const durable = JSON.parse(siblingRaw ?? "null");
    expect(durable.current_balance_cents).toBe(98_766);
    expect(durable.transactions.some((tx: { description?: string }) => tx.description === "Sibling advance")).toBe(true);
    expect(durable.liabilities).toMatchObject([
      { id: "debt-a", balance_cents: 120_000 },
      { id: "debt-b", balance_cents: 80_000 },
    ]);
    await sibling.close();
  });
});
