import { expect, test, type Dialog, type Page } from "@playwright/test";

import { LEDGER_STORAGE_KEY } from "../src/lib/persistence";
import type { LedgerState } from "../src/lib/types";
import {
  failNextLedgerWrite,
  holdLedgerLock,
  queuedWrites,
  releaseLedgerLock,
} from "./helpers/ledger-lock";

/**
 * Ordinary-edit draft safety.
 *
 * Every test uses the real Web Locks implementation and a synthetic ledger that
 * is seeded into this test's isolated browser context. No vault, network route,
 * real ledger, or fixed sleep is involved.
 */

test.use({ locale: "en-US", timezoneId: "UTC" });

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

  test("a failed forecast keeps recorded-debt editing and the failed balance draft", async ({ page }) => {
    await page.clock.install({ time: new Date("2026-11-15T12:00:00.000Z") });
    const ledger = syntheticLedger([
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
        balance_cents: 0,
        apr_basis_points: 10_000,
        min_payment_cents: 0,
        due_day_of_month: 12,
      },
    ]);
    await seedSyntheticLedger(page, ledger);
    const originalRaw = await storedRaw(page);
    expect(originalRaw).not.toBeNull();

    await page.getByRole("button", { name: "Plan", exact: true }).click();
    await page.getByRole("tab", { name: "How do I pay off debt?" }).click();
    // The seeded ledger initially evaluates: the real payoff comparison exists.
    await expect(page.getByText("Payoff Strategy")).toBeVisible();

    // Keep an unrelated add-debt draft in the same pane so the test can prove a
    // failed forecast does not reset the rest of the Plan form state.
    await page.getByLabel("Debt name").fill("Draft not saved");
    await page.getByLabel("Amount still owed ($)").fill("250");

    const rowA = page.locator("li").filter({ hasText: "Card A" });
    const rowB = page.locator("li").filter({ hasText: "Card B" });
    const balanceA = page.getByLabel("Lender balance for Card A ($)");
    const balanceB = page.getByLabel("Lender balance for Card B ($)");

    // A typed balance fails a real durable write. Its value and failure marker
    // must stay with Card A through everything below.
    await page.getByRole("button", { name: "Update balance for Card A" }).click();
    await balanceA.fill("4321.09");
    await holdLedgerLock(page);
    try {
      await rowA.getByRole("button", { name: "Save balance" }).click();
      await expect(page.getByText("Saving your ledger change", { exact: true })).toBeVisible();
      await expect.poll(() => queuedWrites(page)).toBe(1);
      await failNextLedgerWrite(page);
    } finally {
      await releaseLedgerLock(page);
    }
    await expect(page.getByText("Saving your ledger change", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Not saved", { exact: true })).toBeVisible();
    await expect(balanceA).toHaveValue("4321.09");
    await expect(rowA.getByRole("alert")).toContainText(/ledger change failed/i);
    expect(await storedRaw(page)).toBe(originalRaw);

    // A successful, unrelated durable debt edit makes the real engine reject the
    // ledger. The page must keep this same Plan pane mounted and show its error.
    await page.getByRole("button", { name: "Update balance for Card B" }).click();
    await balanceB.fill("1000");
    await rowB.getByRole("button", { name: "Save balance" }).click();
    await expect(page.getByRole("heading", { name: "Calculation Failed", exact: true })).toBeVisible();
    await expect(page.getByText("MONEY_OVERFLOW").first()).toBeVisible();

    // No decision tab, comparison, payoff, amortization, or risk output may be
    // shown while the ledger cannot be evaluated.
    await expect(page.getByRole("tablist", { name: "Decisions" })).toHaveCount(0);
    for (const unavailable of [
      "Payoff Strategy",
      "Months to Payoff",
      "Total Interest Paid",
      "Total paid",
      "Chance of running short",
      "How this changes the plan",
      "Lowest point if the schedule is exact",
      "Ending balance if the schedule is exact",
      "Cautious amount to spend",
      "If that amount leaves the account monthly",
    ]) {
      await expect(page.getByText(unavailable, { exact: true })).toHaveCount(0);
    }

    // Recorded-debt editing remains the accessible surface, and the add-debt
    // draft survived the forecast failure.
    await expect(page.getByRole("button", { name: "Update balance for Card A" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Update balance for Card B" })).toBeVisible();
    await expect(page.getByText("Plan comparisons unavailable")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Recorded debts", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Add debt" })).toBeVisible();
    await expect(page.getByLabel("Debt name")).toHaveValue("Draft not saved");
    await expect(page.getByLabel("Amount still owed ($)")).toHaveValue("250");

    // Only Card B's exact recorded balance changed; cash and Card A did not.
    const failedRaw = await storedRaw(page);
    expect(failedRaw).not.toBe(originalRaw);
    const failed = JSON.parse(failedRaw ?? "null");
    expect(failed.current_balance_cents).toBe(100_000);
    expect(failed.transactions).toEqual(ledger.transactions);
    expect(failed.liabilities).toMatchObject([
      {
        id: "debt-a",
        balance_cents: 120_000,
        apr_basis_points: 1_999,
        min_payment_cents: 5_000,
        due_day_of_month: 5,
      },
      {
        id: "debt-b",
        balance_cents: 100_000,
        apr_basis_points: 10_000,
        min_payment_cents: 0,
        due_day_of_month: 12,
      },
    ]);

    // Card A's failed draft and message are still exactly what the person typed.
    await page.getByRole("button", { name: "Update balance for Card A" }).click();
    await expect(balanceA).toHaveValue("4321.09");
    await expect(rowA.getByRole("alert")).toContainText(/ledger change failed/i);

    // Ordinary navigation still protects the failed draft in this mode.
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
    await expect(page.getByRole("heading", { name: "Calculation Failed", exact: true })).toBeVisible();
    await expect(balanceA).toHaveValue("4321.09");

    // Repair Card B through the same pane. The forecast and its payoff results
    // return, while Card A's draft and marker are untouched.
    await page.getByRole("button", { name: "Update balance for Card B" }).click();
    await balanceB.fill("0");
    await rowB.getByRole("button", { name: "Save balance" }).click();
    await expect(page.getByRole("heading", { name: "Calculation Failed", exact: true })).toHaveCount(0);
    await expect(page.getByRole("tablist", { name: "Decisions" })).toBeVisible();
    await expect(page.getByText("Payoff Strategy")).toBeVisible();
    await expect(page.getByText("Months to Payoff")).toBeVisible();
    await expect(page.getByText("Total Interest Paid")).toBeVisible();
    await expect(page.getByLabel("Debt name")).toHaveValue("Draft not saved");

    await page.getByRole("button", { name: "Update balance for Card A" }).click();
    await expect(balanceA).toHaveValue("4321.09");
    await expect(rowA.getByRole("alert")).toContainText(/ledger change failed/i);

    // Cancel is still row-scoped: it discards Card A's draft and marker but not
    // the add-debt draft or Card B's successfully repaired balance.
    await rowA.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(balanceA).toHaveCount(0);
    await expect(page.getByLabel("Debt name")).toHaveValue("Draft not saved");

    const repairedRaw = await storedRaw(page);
    const repaired = JSON.parse(repairedRaw ?? "null");
    expect(repaired.current_balance_cents).toBe(100_000);
    expect(repaired.transactions).toEqual(ledger.transactions);
    expect(repaired.liabilities).toMatchObject([
      { id: "debt-a", balance_cents: 120_000 },
      { id: "debt-b", balance_cents: 0 },
    ]);

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
    expect(await storedRaw(page)).toBe(repairedRaw);
  });

  test("a move submitted near midnight keeps its pinned date while pending and after failure", async ({ page }) => {
    await page.clock.install({ time: new Date("2026-11-23T23:59:00.000Z") });
    await page.clock.pauseAt(new Date("2026-11-23T23:59:30.000Z"));
    const ledger = syntheticLedger();
    ledger.payments = [
      { id: "rent", name: "Rent", amount_cents: 50_000, recurrence: "Monthly", due_day: 23 },
      { id: "internet", name: "Internet", amount_cents: 7_500, recurrence: "Monthly", due_day: 26 },
    ];
    await seedSyntheticLedger(page, ledger);
    const originalRaw = await storedRaw(page);
    await page.getByRole("button", { name: "Bills", exact: true }).click();

    const originalRow = page.getByRole("listitem", { name: "Rent due Nov 23, 2026", exact: true });
    const originalDate = originalRow.getByLabel("New date for Rent due Nov 23, 2026");
    const keptMove = page.getByRole("listitem", {
      name: "Kept move for Rent, original slot Nov 23, 2026",
      exact: true,
    });
    const keptDate = keptMove.getByLabel("New date for kept move of Rent, original slot Nov 23, 2026");
    const movedRow = page.getByRole("listitem", { name: "Rent due Dec 3, 2026", exact: true });
    const schedule = page.getByRole("heading", { name: "Payments coming up" }).locator("..");
    // Unedited default: the row offers its own due date, not a later day.
    await expect(originalDate).toHaveValue("2026-11-23");
    await expect(schedule.getByText(/Nov 23, 2026/)).toBeVisible();
    await expect(movedRow).toHaveCount(0);

    await holdLedgerLock(page);
    try {
      await originalRow.getByRole("button", { name: "Move", exact: true }).click();
      await expect(page.getByText("Saving your ledger change", { exact: true })).toBeVisible();
      await expect.poll(() => queuedWrites(page)).toBe(1);
      expect(await storedRaw(page)).toBe(originalRaw);

      // Cross midnight while the write is still queued. The projected row for
      // the old slot expires, but the move editor and its pinned date do not.
      await page.clock.runFor(60_000);
      await expect(page.getByText("Saving your ledger change", { exact: true })).toBeVisible();
      await expect(originalRow).toHaveCount(0);
      await expect(keptMove).toBeVisible();
      await expect(keptDate).toBeDisabled();
      await expect(keptDate).toHaveValue("2026-11-23");
      await expect(keptMove).toContainText("New date 2026-11-23");
      await expect(keptMove).toContainText("not saved");
      await expect(schedule.getByText(/Nov 23, 2026/)).toHaveCount(0);
      await expect(movedRow).toHaveCount(0);
      expect(await storedRaw(page)).toBe(originalRaw);

      await failNextLedgerWrite(page);
    } finally {
      await releaseLedgerLock(page);
    }

    // The one-shot storage failure keeps the exact move draft and does not
    // create an occurrence, transaction, balance change, or forecast row.
    await expect(page.getByText("Saving your ledger change", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Not saved", { exact: true })).toBeVisible();
    await expect(keptMove).toBeVisible();
    await expect(keptDate).toHaveValue("2026-11-23");
    await expect(schedule.getByText(/Nov 23, 2026/)).toHaveCount(0);
    await expect(movedRow).toHaveCount(0);
    expect(await storedRaw(page)).toBe(originalRaw);

    // Retry uses the stable original slot. Changing only the destination keeps
    // the original date on the occurrence and adds no cash transaction.
    await keptDate.fill("2026-12-03");
    await keptMove.getByRole("button", { name: "Move", exact: true }).click();
    await expect(keptMove).toHaveCount(0);
    await expect(page.getByText("Not saved", { exact: true })).toHaveCount(0);
    await expect(movedRow).toBeVisible();
    await expect(movedRow.getByLabel("New date for Rent due Dec 3, 2026")).toHaveValue("2026-12-03");
    await expect(schedule.getByText(/Dec 3, 2026/)).toBeVisible();

    const savedRaw = await storedRaw(page);
    expect(savedRaw).not.toBe(originalRaw);
    const saved = JSON.parse(savedRaw ?? "null");
    expect(saved.current_balance_cents).toBe(100_000);
    expect(saved.transactions).toHaveLength(1);
    expect(saved.bill_occurrences).toEqual([
      {
        id: "occ-1",
        payment_id: "rent",
        due_date: "2026-12-03",
        paid: false,
        original_due_date: "2026-11-23",
        is_user_modified: true,
      },
    ]);
  });

  test("ordinary Mark paid requires discarding only its own move draft and keeps a sibling guard", async ({ page }) => {
    await page.clock.install({ time: new Date("2026-11-15T12:00:00.000Z") });
    const ledger = syntheticLedger([
      {
        id: "debt-a",
        name: "Card A",
        balance_cents: 120_000,
        apr_basis_points: 1_999,
        min_payment_cents: 5_000,
        due_day_of_month: 5,
      },
    ]);
    ledger.payments = [
      { id: "rent", name: "Rent", amount_cents: 50_000, recurrence: "Monthly", due_day: 20 },
      { id: "power", name: "Power", amount_cents: 10_000, recurrence: "Monthly", due_day: 21 },
    ];
    await seedSyntheticLedger(page, ledger);
    const originalRaw = await storedRaw(page);
    await page.getByRole("button", { name: "Bills", exact: true }).click();

    const rentRow = page.getByRole("listitem", { name: "Rent due Nov 20, 2026", exact: true });
    const powerRow = page.getByRole("listitem", { name: "Power due Nov 21, 2026", exact: true });
    const rentDate = rentRow.getByLabel("New date for Rent due Nov 20, 2026");
    const powerDate = powerRow.getByLabel("New date for Power due Nov 21, 2026");

    // Two independent failed moves in the same pane. A failure on Power must
    // not erase Rent's move draft or its own marker.
    await rentDate.fill("2026-11-25");
    await holdLedgerLock(page);
    try {
      await rentRow.getByRole("button", { name: "Move", exact: true }).click();
      await expect(page.getByText("Saving your ledger change", { exact: true })).toBeVisible();
      await expect.poll(() => queuedWrites(page)).toBe(1);
      await failNextLedgerWrite(page);
    } finally {
      await releaseLedgerLock(page);
    }
    await expect(page.getByText("Saving your ledger change", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Not saved", { exact: true })).toBeVisible();
    await expect(rentDate).toHaveValue("2026-11-25");
    expect(await storedRaw(page)).toBe(originalRaw);

    await powerDate.fill("2026-11-26");
    await holdLedgerLock(page);
    try {
      await powerRow.getByRole("button", { name: "Move", exact: true }).click();
      await expect(page.getByText("Saving your ledger change", { exact: true })).toBeVisible();
      await expect.poll(() => queuedWrites(page)).toBe(1);
      await failNextLedgerWrite(page);
    } finally {
      await releaseLedgerLock(page);
    }
    await expect(page.getByText("Saving your ledger change", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Not saved", { exact: true })).toBeVisible();
    await expect(rentDate).toHaveValue("2026-11-25");
    await expect(powerDate).toHaveValue("2026-11-26");
    expect(await storedRaw(page)).toBe(originalRaw);

    // Declining the discard confirmation leaves both the move draft and the
    // durable ledger untouched.
    const [declined] = await Promise.all([
      page.waitForEvent("dialog").then(async (dialog) => {
        const result = { type: dialog.type(), message: dialog.message() };
        await dialog.dismiss();
        return result;
      }),
      rentRow.getByRole("button", { name: "Mark paid" }).click(),
    ]);
    expect(declined.type).toBe("confirm");
    expect(declined.message).toMatch(/moved date|move draft/i);
    await expect(rentDate).toHaveValue("2026-11-25");
    expect(await storedRaw(page)).toBe(originalRaw);

    // Accepting a settlement that then fails keeps the move draft for retry.
    await holdLedgerLock(page);
    try {
      const [failedPaid] = await Promise.all([
        page.waitForEvent("dialog").then(async (dialog) => {
          const type = dialog.type();
          await dialog.accept();
          return type;
        }),
        rentRow.getByRole("button", { name: "Mark paid" }).click(),
      ]);
      expect(failedPaid).toBe("confirm");
      await expect(page.getByText("Saving your ledger change", { exact: true })).toBeVisible();
      await expect.poll(() => queuedWrites(page)).toBe(1);
      await failNextLedgerWrite(page);
    } finally {
      await releaseLedgerLock(page);
    }
    await expect(page.getByText("Saving your ledger change", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Not saved", { exact: true })).toBeVisible();
    await expect(rentRow).toBeVisible();
    await expect(rentDate).toHaveValue("2026-11-25");
    expect(await storedRaw(page)).toBe(originalRaw);

    // A successful settlement clears only Rent's draft. Power's draft and its
    // navigation guard survive.
    const [accepted] = await Promise.all([
      page.waitForEvent("dialog").then(async (dialog) => {
        const type = dialog.type();
        await dialog.accept();
        return type;
      }),
      rentRow.getByRole("button", { name: "Mark paid" }).click(),
    ]);
    expect(accepted).toBe("confirm");
    await expect(rentRow).toHaveCount(0);
    await expect(powerDate).toHaveValue("2026-11-26");

    const paidRaw = await storedRaw(page);
    expect(paidRaw).not.toBe(originalRaw);
    const paid = JSON.parse(paidRaw ?? "null");
    expect(paid.current_balance_cents).toBe(50_000);
    expect(paid.transactions).toHaveLength(2);
    expect(paid.transactions[1]).toMatchObject({
      id: "tx-2",
      amount_cents: -50_000,
      type: "Expense",
      date: "2026-11-15",
      description: "Rent",
    });
    expect(paid.bill_occurrences).toEqual([
      {
        id: "occ-1",
        payment_id: "rent",
        due_date: "2026-11-20",
        paid: true,
        transaction_id: "tx-2",
        original_due_date: "2026-11-20",
        is_user_modified: false,
      },
    ]);

    const [siblingGuard] = await Promise.all([
      page.waitForEvent("dialog").then(async (dialog) => {
        const type = dialog.type();
        await dialog.dismiss();
        return type;
      }),
      page.getByRole("button", { name: "Home", exact: true }).click(),
    ]);
    expect(siblingGuard).toBe("confirm");
    await expect(page.getByRole("button", { name: "Bills", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(powerDate).toHaveValue("2026-11-26");
    expect(await storedRaw(page)).toBe(paidRaw);

    // Cancel is per slot: it discards only Power's marker and draft.
    await powerRow.getByRole("button", { name: "Cancel move" }).click();
    await expect(powerDate).toHaveValue("2026-11-21");
    await expect(powerRow.getByRole("button", { name: "Cancel move" })).toHaveCount(0);
    expect(await storedRaw(page)).toBe(paidRaw);

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

    const final = JSON.parse((await storedRaw(page)) ?? "null");
    expect(final.bill_occurrences).toEqual(paid.bill_occurrences);
    expect(final.payments).toEqual(ledger.payments);
    expect(final.liabilities).toEqual(ledger.liabilities);
  });

  test("an ordinary Mark paid attempt keeps its slot and posting date after midnight", async ({ page }) => {
    await page.clock.install({ time: new Date("2026-11-23T23:59:00.000Z") });
    await page.clock.pauseAt(new Date("2026-11-23T23:59:30.000Z"));
    const ledger = syntheticLedger();
    ledger.payments = [
      { id: "rent", name: "Rent", amount_cents: 50_000, recurrence: "Monthly", due_day: 23 },
      { id: "power", name: "Power", amount_cents: 10_000, recurrence: "Monthly", due_day: 24 },
    ];
    await seedSyntheticLedger(page, ledger);
    const originalRaw = await storedRaw(page);
    await page.getByRole("button", { name: "Bills", exact: true }).click();

    const schedule = page.getByRole("heading", { name: "Payments coming up" }).locator("..");
    const rentRow = page.getByRole("listitem", { name: "Rent due Nov 23, 2026", exact: true });
    const keptPayment = page.getByRole("listitem", {
      name: "Kept payment for Rent, original slot Nov 23, 2026",
      exact: true,
    });
    const keptPostingDate = keptPayment.getByLabel(
      "Posting date for kept payment of Rent, original slot Nov 23, 2026"
    );
    await expect(rentRow).toBeVisible();
    await expect(schedule.getByText(/Nov 23, 2026/)).toBeVisible();

    await holdLedgerLock(page);
    try {
      // No move or link draft: the attempt itself must carry the exact slot and
      // posting date while its write is outstanding.
      await rentRow.getByRole("button", { name: "Mark paid", exact: true }).click();
      await expect(page.getByText("Saving your ledger change", { exact: true })).toBeVisible();
      await expect.poll(() => queuedWrites(page)).toBe(1);
      expect(await storedRaw(page)).toBe(originalRaw);

      // Cross midnight while the write still waits. The recurring row leaves the
      // projection, but the retained attempt keeps the original dates disabled.
      await page.clock.runFor(60_000);
      await expect(page.getByText("Saving your ledger change", { exact: true })).toBeVisible();
      await expect(rentRow).toHaveCount(0);
      await expect(keptPayment).toBeVisible();
      await expect(keptPayment).toContainText("Saving this payment attempt");
      await expect(keptPostingDate).toBeDisabled();
      await expect(keptPostingDate).toHaveValue("2026-11-23");
      await expect(keptPayment.getByRole("button", { name: "Retry Mark paid", exact: true })).toBeDisabled();
      await expect(schedule.getByText(/Nov 23, 2026/)).toHaveCount(0);
      expect(await storedRaw(page)).toBe(originalRaw);

      await failNextLedgerWrite(page);
    } finally {
      await releaseLedgerLock(page);
    }

    // The one-shot failure keeps the exact attempt without adding an occurrence,
    // expense, balance change, or forecast row.
    await expect(page.getByText("Saving your ledger change", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Not saved", { exact: true })).toBeVisible();
    await expect(keptPayment).toBeVisible();
    await expect(keptPayment).toContainText("Payment attempt not saved");
    await expect(keptPostingDate).toBeDisabled();
    await expect(keptPostingDate).toHaveValue("2026-11-23");
    await expect(page.getByRole("button", { name: "Retry Mark paid", exact: true })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Retry Mark paid", exact: true })).toBeEnabled();
    await expect(schedule.getByText(/Nov 23, 2026/)).toHaveCount(0);
    await expect(schedule.getByText(/Dec 23, 2026/)).toBeVisible();
    expect(await storedRaw(page)).toBe(originalRaw);
    const failed = JSON.parse((await storedRaw(page)) ?? "null");
    expect(failed.current_balance_cents).toBe(100_000);
    expect(failed.transactions).toHaveLength(1);
    expect(failed.bill_occurrences).toEqual([]);

    // Declining the native section guard keeps the section and the attempt.
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
    await expect(page.getByRole("button", { name: "Bills", exact: true })).toHaveAttribute("aria-current", "page");
    await expect(keptPayment).toBeVisible();

    // A sibling attempt on Power fails too. Cancelling only Power's attempt must
    // leave Rent's retained attempt and its guard untouched.
    const powerRow = page.getByRole("listitem", { name: "Power due Nov 24, 2026", exact: true });
    await expect(powerRow).toBeVisible();
    await holdLedgerLock(page);
    try {
      await powerRow.getByRole("button", { name: "Mark paid", exact: true }).click();
      await expect(page.getByText("Saving your ledger change", { exact: true })).toBeVisible();
      await expect.poll(() => queuedWrites(page)).toBe(1);
      await failNextLedgerWrite(page);
    } finally {
      await releaseLedgerLock(page);
    }
    await expect(page.getByText("Saving your ledger change", { exact: true })).toHaveCount(0);
    await expect(powerRow.getByText(/Payment attempt not saved/)).toBeVisible();
    await expect(powerRow).toContainText("2026-11-24");
    await powerRow.getByRole("button", { name: "Cancel payment attempt", exact: true }).click();
    await expect(powerRow.getByText(/Payment attempt not saved/)).toHaveCount(0);
    await expect(powerRow.getByRole("button", { name: "Cancel payment attempt", exact: true })).toHaveCount(0);
    await expect(keptPayment).toBeVisible();
    await expect(page.getByRole("button", { name: "Retry Mark paid", exact: true })).toHaveCount(1);
    expect(await storedRaw(page)).toBe(originalRaw);

    // Rent's marker is independent of Power's cancelled one.
    const [remainingGuard] = await Promise.all([
      page.waitForEvent("dialog").then(async (dialog) => {
        const type = dialog.type();
        await dialog.dismiss();
        return type;
      }),
      page.getByRole("button", { name: "Home", exact: true }).click(),
    ]);
    expect(remainingGuard).toBe("confirm");
    await expect(page.getByRole("button", { name: "Bills", exact: true })).toHaveAttribute("aria-current", "page");

    // Retry the exact original slot and posting date. Only now is one debit
    // posted, dated the day the person originally submitted Mark paid.
    await keptPayment.getByRole("button", { name: "Retry Mark paid", exact: true }).click();
    await expect(keptPayment).toHaveCount(0);
    await expect(page.getByText("Saving your ledger change", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Not saved", { exact: true })).toHaveCount(0);

    const paidRaw = await storedRaw(page);
    expect(paidRaw).not.toBe(originalRaw);
    const paid = JSON.parse(paidRaw ?? "null");
    expect(paid.current_balance_cents).toBe(50_000);
    expect(paid.transactions).toHaveLength(2);
    expect(paid.transactions[1]).toMatchObject({
      id: "tx-2",
      amount_cents: -50_000,
      type: "Expense",
      date: "2026-11-23",
      description: "Rent",
    });
    expect(paid.transactions.filter((tx: { description?: string }) => tx.description === "Power")).toHaveLength(0);
    expect(paid.bill_occurrences).toEqual([
      {
        id: "occ-1",
        payment_id: "rent",
        due_date: "2026-11-23",
        paid: true,
        transaction_id: "tx-2",
        original_due_date: "2026-11-23",
        is_user_modified: false,
      },
    ]);

    // Success removes the native handler and leaves no phantom navigation guard.
    const afterSuccessUnload = await dispatchBeforeUnload(page);
    expect(afterSuccessUnload.defaultPrevented).toBe(false);
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
    expect(await storedRaw(page)).toBe(paidRaw);
  });
});
