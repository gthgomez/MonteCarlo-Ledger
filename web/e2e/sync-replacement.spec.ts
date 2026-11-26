import { expect, test, type Dialog, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import { LEDGER_LOCK_NAME } from "../src/lib/persistence";
import { SAMPLE_LEDGER_STATE, type LedgerState } from "../src/lib/types";
import {
  failNextLedgerWrite,
  holdLedgerLock,
  queuedWrites,
  releaseLedgerLock,
} from "./helpers/ledger-lock";

/**
 * Focused replacement-safety regressions.
 *
 * The suite runs against the loopback test server pinned to its in-memory vault
 * store by playwright.config.ts. Every vault id/snapshot is synthetic and isolated
 * to the test that creates it.
 */

const LEDGER_STORAGE_KEY = "montecarlo_ledger_state_v2";
const VAULT_ID_STORAGE_KEY = "montecarlo_vault_id";
const PASSPHRASE = "synthetic sync-replacement passphrase";

function uniqueVaultId(): string {
  return `e2e-replacement-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

async function openSync(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Cloud Vault/ }).click();
  await expect(
    page.getByRole("dialog", { name: "Cloud Vault & CLI Synchronization" })
  ).toBeVisible();
}

async function closeSync(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Close synchronization" }).click();
  await expect(
    page.getByRole("dialog", { name: "Cloud Vault & CLI Synchronization" })
  ).toHaveCount(0);
}

async function fillVaultForm(page: Page, vaultId: string): Promise<void> {
  await page.getByLabel("Vault Identifier").fill(vaultId);
  await page.getByLabel("Vault Secret Passphrase").fill(PASSPHRASE);
}

async function createSyntheticVault(page: Page, vaultId: string): Promise<void> {
  await openSync(page);
  await fillVaultForm(page, vaultId);
  // A demo push explicitly confirms that the sample is not the person's ledger.
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Push (Upload)" }).click();
  await expect(
    page.getByText(/Successfully pushed encrypted snapshot to Cloud Vault \(rev 1\)!/)
  ).toBeVisible();
  await closeSync(page);
}

function validImportState(): LedgerState {
  return {
    ...(JSON.parse(JSON.stringify(SAMPLE_LEDGER_STATE)) as LedgerState),
    updated_at: "2026-11-22T12:00:00.000Z",
  };
}

function syntheticLedger(
  payments: LedgerState["payments"],
  updatedAt = "2026-11-01T00:00:00.000Z"
): LedgerState {
  return {
    version: "2.0",
    updated_at: updatedAt,
    current_balance_cents: 100_000,
    incomes: [],
    payments,
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

/** The bill that will be moved and then replaced by an unrelated payment. */
function powerLedger(): LedgerState {
  return syntheticLedger([
    { id: "pmt-1", name: "Power", amount_cents: 10_000, recurrence: "Monthly", due_day: 23 },
  ]);
}

/**
 * An independent snapshot that reuses the same payment ID and recurrence slot
 * as the bill whose move draft is retained in this tab.
 */
function rentImportState(): LedgerState {
  return syntheticLedger(
    [{ id: "pmt-1", name: "Rent", amount_cents: 50_000, recurrence: "Monthly", due_day: 23 }],
    "2026-11-24T00:10:00.000Z"
  );
}

async function seedSyntheticLedger(page: Page, state: LedgerState): Promise<void> {
  await page.goto("/");
  await page.evaluate(
    ({ key, ledger }) => localStorage.setItem(key, JSON.stringify(ledger)),
    { key: LEDGER_STORAGE_KEY, ledger: state }
  );
  await page.reload();
}

function storedRaw(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), LEDGER_STORAGE_KEY);
}

async function openImportTab(page: Page): Promise<void> {
  await openSync(page);
  await page.getByRole("button", { name: "Local JSON Backup" }).click();
}

/** Choose the backup file and answer the native discard confirmation. */
async function importBackup(
  page: Page,
  state: LedgerState,
  answer: "accept" | "dismiss"
): Promise<{ type: string; message: string }> {
  // Answer the native confirmation as it appears; the file change event stays
  // blocked until the dialog is settled.
  const answered = page.waitForEvent("dialog", { timeout: 5_000 }).then(async (dialog) => {
    const result = { type: dialog.type(), message: dialog.message() };
    if (answer === "accept") await dialog.accept();
    else await dialog.dismiss();
    return result;
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: "replacement.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(state)),
  });
  return answered;
}

test.describe("replacement safety", () => {
  test("a normal edit in another tab survives a delayed vault restore", async ({
    page,
    context,
  }) => {
    test.setTimeout(60_000);
    const vaultId = uniqueVaultId();
    await page.goto("/");
    await createSyntheticVault(page, vaultId);

    // Hold the vault payload request so the test controls when the restore resolves.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let seen!: () => void;
    const requestSeen = new Promise<void>((resolve) => {
      seen = resolve;
    });
    await page.route(new RegExp(`/api/vault/${vaultId}$`), async (route) => {
      if (route.request().method() === "GET") {
        seen();
        await gate;
      }
      await route.continue();
    });

    const otherTab = await context.newPage();
    await otherTab.goto("/");

    await openSync(page);
    await fillVaultForm(page, vaultId);
    await page.getByRole("button", { name: "Pull (Download)" }).click();
    await requestSeen;

    // A normal user edit in a second tab, not a direct storage write.
    await otherTab.getByRole("button", { name: "Enter my own numbers" }).click();
    await otherTab.getByLabel("Money you have now ($)").fill("4321");
    await otherTab.getByRole("button", { name: "Save and show my plan" }).click();
    await expect(otherTab.getByText(/You have \$4,321\.00 recorded/)).toBeVisible();
    const editedRaw = await otherTab.evaluate(
      (key) => localStorage.getItem(key),
      LEDGER_STORAGE_KEY
    );
    expect(editedRaw).not.toBeNull();

    release();
    await expect(
      page.getByRole("alert").filter({ hasText: "restore was not persisted" })
    ).toBeVisible();
    await expect(page.getByText(/Successfully pulled/)).toHaveCount(0);
    expect(
      await page.evaluate((key) => localStorage.getItem(key), LEDGER_STORAGE_KEY)
    ).toBe(editedRaw);

    await otherTab.reload();
    await expect(otherTab.getByText(/You have \$4,321\.00 recorded/)).toBeVisible();
    await otherTab.close();
  });

  test("closing during a pull cancels a restore queued behind the write lock", async ({
    page,
  }) => {
    const vaultId = uniqueVaultId();
    await page.goto("/");
    await createSyntheticVault(page, vaultId);

    // Use the real browser lock to hold the restore after it decrypts, without
    // modifying the vault protocol or trying to instrument WebCrypto.
    await page.evaluate((name) => new Promise<void>((acquired) => {
      const harness = window as Window & { releaseTestLedgerLock?: () => void };
      const hold = new Promise<void>((release) => { harness.releaseTestLedgerLock = release; });
      void navigator.locks.request(name, () => {
        acquired();
        return hold;
      });
    }), LEDGER_LOCK_NAME);
    const restoreQueued = () => page.evaluate(async (name) =>
      (await navigator.locks.query()).pending?.some((lock) => lock.name === name),
    LEDGER_LOCK_NAME);
    try {
      await openSync(page);
      await fillVaultForm(page, vaultId);
      await page.getByRole("button", { name: "Pull (Download)" }).click();
      await expect.poll(restoreQueued).toBe(true);
      await closeSync(page);
      await expect.poll(restoreQueued).toBe(false);
    } finally {
      await page.evaluate(() => {
        (window as Window & { releaseTestLedgerLock?: () => void }).releaseTestLedgerLock?.();
      });
    }
    expect(
      await page.evaluate((key) => localStorage.getItem(key), LEDGER_STORAGE_KEY)
    ).toBeNull();

    // The page is usable after cancelling, and a normal edit still persists.
    await page.getByRole("button", { name: "Enter my own numbers" }).click();
    await page.getByLabel("Money you have now ($)").fill("777");
    await page.getByRole("button", { name: "Save and show my plan" }).click();
    await expect(page.getByText(/You have \$777\.00 recorded/)).toBeVisible();
    expect(
      await page.evaluate((key) => localStorage.getItem(key), LEDGER_STORAGE_KEY)
    ).not.toBeNull();
  });

  test("a successful push keeps the generated vault id across reload and an isolated browser", async ({
    page,
    browser,
  }) => {
    await page.goto("/");

    // A new profile with a real local ledger but no synchronization history yet.
    await page.getByRole("button", { name: "Enter my own numbers" }).click();
    await page.getByLabel("Money you have now ($)").fill("1234");
    await page.getByRole("button", { name: "Save and show my plan" }).click();
    await expect(page.getByText(/You have \$1,234\.00 recorded/)).toBeVisible();

    // Do not fill the id: this is the unguessable default generated for a new profile.
    await openSync(page);
    const vaultId = await page.getByLabel("Vault Identifier").inputValue();
    expect(vaultId).toMatch(/^vault-[0-9a-f]{32}$/);
    await page.getByLabel("Vault Secret Passphrase").fill(PASSPHRASE);
    await page.getByRole("button", { name: "Push (Upload)" }).click();
    await expect(
      page.getByText(/Successfully pushed encrypted snapshot to Cloud Vault \(rev 1\)!/)
    ).toBeVisible();
    await closeSync(page);
    expect(
      await page.evaluate((key) => localStorage.getItem(key), VAULT_ID_STORAGE_KEY)
    ).toBe(vaultId);

    await page.reload();
    // The saved id is hydrated after the first render and reopens Sync pre-filled.
    await expect(
      page.getByRole("button", { name: `Cloud Vault ${vaultId}` })
    ).toBeVisible();
    await openSync(page);
    await expect(page.getByLabel("Vault Identifier")).toHaveValue(vaultId);
    await closeSync(page);

    // A separate browser context has none of this profile's storage. The saved id
    // and passphrase alone recover the encrypted snapshot.
    const origin = new URL(page.url()).origin;
    const isolated = await browser.newContext({ baseURL: origin });
    try {
      const isolatedPage = await isolated.newPage();
      await isolatedPage.goto("/");
      await openSync(isolatedPage);
      await isolatedPage.getByLabel("Vault Identifier").fill(vaultId);
      await isolatedPage.getByLabel("Vault Secret Passphrase").fill(PASSPHRASE);
      await isolatedPage.getByRole("button", { name: "Pull (Download)" }).click();
      // A fresh profile starts from the in-memory demo ledger, which a pull must not
      // replace without confirmation.
      await expect(
        isolatedPage.getByText(/This device has ledger edits that were never synchronized/)
      ).toBeVisible();
      await isolatedPage
        .getByRole("button", { name: "Replace local ledger with the vault" })
        .click();
      await expect(
        isolatedPage.getByText(/Successfully pulled, decrypted and saved vault \(rev 1\)!/)
      ).toBeVisible();
      expect(
        await isolatedPage.evaluate(
          (key) => localStorage.getItem(key),
          VAULT_ID_STORAGE_KEY
        )
      ).toBe(vaultId);
    } finally {
      await isolated.close();
    }
  });

  for (const order of ["valid then invalid", "invalid then valid"] as const) {
    test(`import status and stored ledger stay consistent (${order})`, async ({
      page,
    }) => {
      const valid = validImportState();
      const invalid = { version: "2.0" };
      const input = page.locator('input[type="file"]');

      await page.goto("/");
      await openSync(page);
      await page.getByRole("button", { name: "Local JSON Backup" }).click();

      const importValid = async () => {
        await input.setInputFiles({
          name: "valid-ledger.json",
          mimeType: "application/json",
          buffer: Buffer.from(JSON.stringify(valid)),
        });
      };
      const importInvalid = async () => {
        await input.setInputFiles({
          name: "invalid-ledger.json",
          mimeType: "application/json",
          buffer: Buffer.from(JSON.stringify(invalid)),
        });
      };
      const success = page.getByText("Successfully imported ledger backup file!");
      const rejection = page
        .getByRole("alert")
        .filter({ hasText: "Import rejected (your current ledger is unchanged):" });

      if (order === "valid then invalid") {
        expect(
          await page.evaluate((key) => localStorage.getItem(key), LEDGER_STORAGE_KEY)
        ).toBeNull();
        await importValid();
        await expect(success).toBeVisible();
        await expect(rejection).toHaveCount(0);
        const stored = await page.evaluate(
          (key) => localStorage.getItem(key),
          LEDGER_STORAGE_KEY
        );
        expect(JSON.parse(stored ?? "null").updated_at).toBe(valid.updated_at);

        await importInvalid();
        await expect(rejection).toBeVisible();
        await expect(success).toHaveCount(0);
        // Validation failed before any replace, so the valid import is untouched.
        expect(
          await page.evaluate((key) => localStorage.getItem(key), LEDGER_STORAGE_KEY)
        ).toBe(stored);
      } else {
        await importInvalid();
        await expect(rejection).toBeVisible();
        await expect(success).toHaveCount(0);
        expect(
          await page.evaluate((key) => localStorage.getItem(key), LEDGER_STORAGE_KEY)
        ).toBeNull();

        await importValid();
        await expect(success).toBeVisible();
        await expect(rejection).toHaveCount(0);
        const stored = await page.evaluate(
          (key) => localStorage.getItem(key),
          LEDGER_STORAGE_KEY
        );
        expect(JSON.parse(stored ?? "null").updated_at).toBe(valid.updated_at);
      }
    });
  }
});

test.describe("uncertain replacement recovery", () => {
  test.use({ locale: "en-US", timezoneId: "UTC" });

  test("an unverified rollback keeps the incoming vault bytes and prior export", async ({
    page,
    browser,
  }) => {
    test.setTimeout(90_000);
    const SYNC_STORAGE_KEY = "montecarlo_vault_sync_v1";
    const SETTINGS_REVIEW_KEY = "montecarlo_settings_review_v1";

    await page.goto("/");

    // A genuine previously saved local ledger, written through the ordinary
    // starter form. It must stay distinct from the incoming vault snapshot.
    await page.getByRole("button", { name: "Enter my own numbers" }).click();
    await page.getByLabel("Money you have now ($)").fill("2500");
    await page.getByRole("button", { name: "Save and show my plan" }).click();
    await expect(page.getByText(/You have \$2,500\.00 recorded/)).toBeVisible();
    const priorRaw = await storedRaw(page);
    expect(priorRaw).not.toBeNull();

    // Keep one real submitted-but-failed draft: the write really reaches storage
    // once while the lock is held, then fails.
    await page.getByRole("button", { name: "Money", exact: true }).click();
    await holdLedgerLock(page);
    try {
      await page.getByLabel("Amount ($)", { exact: true }).fill("12.34");
      await page.getByLabel("Note").fill("Draft to keep");
      await failNextLedgerWrite(page);
      await page.getByRole("button", { name: "Record this" }).click();
      await expect(page.getByText("Saving your ledger change", { exact: true })).toBeVisible();
      await expect.poll(() => queuedWrites(page)).toBe(1);
      expect(await storedRaw(page)).toBe(priorRaw);
    } finally {
      await releaseLedgerLock(page);
    }
    await expect(page.getByText("Saving your ledger change", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Not saved", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Amount ($)", { exact: true })).toHaveValue("12.34");
    await expect(page.getByLabel("Note")).toHaveValue("Draft to keep");

    // The incoming snapshot comes from the real loopback memory vault and WebCrypto,
    // created by ordinary controls in an isolated profile with its own storage.
    const origin = new URL(page.url()).origin;
    const vaultId = uniqueVaultId();
    const source = await browser.newContext({ baseURL: origin });
    let incomingExpected: string;
    try {
      const sourcePage = await source.newPage();
      await sourcePage.goto("/");
      await sourcePage.getByRole("button", { name: "Enter my own numbers" }).click();
      await sourcePage.getByLabel("Money you have now ($)").fill("7777");
      await sourcePage.getByRole("button", { name: "Save and show my plan" }).click();
      await expect(sourcePage.getByText(/You have \$7,777\.00 recorded/)).toBeVisible();
      await openSync(sourcePage);
      await fillVaultForm(sourcePage, vaultId);
      await sourcePage.getByRole("button", { name: "Push (Upload)" }).click();
      await expect(
        sourcePage.getByText(
          /Successfully pushed encrypted snapshot to Cloud Vault \(rev 1\)!/
        )
      ).toBeVisible();
      await closeSync(sourcePage);
      const sourceRaw = await storedRaw(sourcePage);
      expect(sourceRaw).not.toBeNull();
      incomingExpected = sourceRaw as string;
    } finally {
      await source.close();
    }

    // Fail the actual post-ledger vault-id write, then refuse exactly the rollback
    // to the previous ledger bytes. Storage therefore really keeps the incoming raw.
    await page.evaluate(
      ({ ledgerKey, vaultKey, previousRaw }) => {
        const original = Storage.prototype.setItem;
        const local = window.localStorage;
        const harness = window as unknown as {
          __syncReplacementWrites?: Array<{ key: string; value: string; blocked: boolean }>;
        };
        harness.__syncReplacementWrites = [];
        Storage.prototype.setItem = function (key: string, value: string) {
          let blocked = false;
          if (this === local) {
            if (key === vaultKey) blocked = true;
            else if (key === ledgerKey && value === previousRaw) blocked = true;
            harness.__syncReplacementWrites!.push({ key, value, blocked });
          }
          if (blocked) {
            throw new DOMException("Synthetic uncertain rollback", "QuotaExceededError");
          }
          return original.call(this, key, value);
        };
      },
      {
        ledgerKey: LEDGER_STORAGE_KEY,
        vaultKey: VAULT_ID_STORAGE_KEY,
        previousRaw: priorRaw,
      }
    );

    await openSync(page);
    await fillVaultForm(page, vaultId);
    await page.getByRole("button", { name: "Pull (Download)" }).click();
    // This profile has never synchronized, so the pull must be explicitly confirmed
    // and discarding the failed draft authorized only if replacement succeeds.
    await expect(
      page.getByText(/This device has ledger edits that were never synchronized/)
    ).toBeVisible();
    const discard = page.waitForEvent("dialog");
    await page.getByRole("button", { name: "Replace local ledger with the vault" }).click();
    await (await discard).accept();

    const uncertain = page
      .getByRole("dialog")
      .getByRole("alert")
      .filter({ hasText: "Vault decrypted, but the saved ledger could not be verified" });
    await expect(uncertain).toBeVisible();
    await expect(uncertain).toContainText(/some or all of the change may have persisted/i);
    await expect(uncertain).toContainText(/close sync to keep a copy/i);
    await expect(uncertain).not.toContainText(/restore was not persisted/i);
    await expect(page.getByText(/Successfully pulled/)).toHaveCount(0);

    // New destructive starts are disabled, but the uncertain result stays visible.
    await expect(page.getByRole("button", { name: "Push (Upload)" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Pull (Download)" })).toBeDisabled();
    await page.getByRole("button", { name: "Local JSON Backup" }).click();
    await expect(page.locator('input[type="file"]')).toBeDisabled();
    await page.getByRole("button", { name: "Encrypted vault" }).click();
    await expect(uncertain).toBeVisible();

    // The incoming raw really is durable; only the rollback was refused.
    const incomingRaw = await storedRaw(page);
    expect(incomingRaw).toBe(incomingExpected);
    expect(incomingRaw).not.toBe(priorRaw);
    expect(await page.evaluate((key) => localStorage.getItem(key), VAULT_ID_STORAGE_KEY)).toBeNull();
    expect(await page.evaluate((key) => localStorage.getItem(key), SYNC_STORAGE_KEY)).toBeNull();
    const guardRaw = await page.evaluate((key) => localStorage.getItem(key), SETTINGS_REVIEW_KEY);
    expect(JSON.parse(guardRaw ?? "null")).toMatchObject({
      vaultId,
      ledgerRevision: 1,
      reason: "settings-pending",
    });

    type InjectedWrite = { key: string; value: string; blocked: boolean };
    const writes = (): Promise<InjectedWrite[]> =>
      page.evaluate(() => {
        const harness = window as unknown as {
          __syncReplacementWrites?: InjectedWrite[];
        };
        return harness.__syncReplacementWrites ?? [];
      });
    expect(await writes()).toEqual([
      { key: SETTINGS_REVIEW_KEY, value: guardRaw, blocked: false },
      { key: LEDGER_STORAGE_KEY, value: incomingExpected, blocked: false },
      { key: VAULT_ID_STORAGE_KEY, value: vaultId, blocked: true },
      { key: LEDGER_STORAGE_KEY, value: priorRaw, blocked: true },
    ]);

    await closeSync(page);

    // The parent keeps the uncertain state after closing; the old view is not
    // presented as a current estimate and the failed draft is retained.
    await expect(
      page.getByRole("heading", { name: "Saved ledger could not be verified" })
    ).toBeVisible();
    await expect(
      page.getByRole("alert").filter({ hasText: "Some or all of the last change may have persisted" })
    ).toBeVisible();
    const cash = page.getByRole("heading", { name: "What you have", exact: true }).locator("..");
    await expect(cash.getByText(/The current cash summary is unavailable/)).toBeVisible();
    await expect(cash.getByText(/\$2,500\.00/)).toHaveCount(0);
    await expect(cash.getByText(/\$7,777\.00/)).toHaveCount(0);
    await expect(page.getByText(/Safe to spend/)).toHaveCount(0);
    await expect(page.getByText(/Successfully pulled/)).toHaveCount(0);
    await expect(page.getByLabel("Amount ($)", { exact: true })).toHaveValue("12.34");
    await expect(page.getByLabel("Note")).toHaveValue("Draft to keep");
    await expect(page.getByText("Not saved", { exact: true })).toBeVisible();

    // The offered export is the exact previous non-null raw bytes, not the bytes
    // this failed replacement left behind.
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export previous ledger" }).click();
    const download = await downloadPromise;
    const downloadedPath = await download.path();
    expect(downloadedPath).not.toBeNull();
    const exported = await readFile(downloadedPath as string, "utf8");
    expect(exported).toBe(priorRaw);
    expect(exported).not.toBe(incomingRaw);
    expect(download.suggestedFilename()).toMatch(/previous/);
    // Reading/exporting the previous bytes itself must not touch storage.
    expect((await writes()).length).toBe(4);

    // Sticky uncertainty: a focus/storage freshness check must not retract the
    // banner or write anything while the tab still holds the older view.
    const writeCount = (await writes()).length;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(
      page.getByRole("heading", { name: "Saved ledger could not be verified" })
    ).toBeVisible();
    await expect(
      page.getByRole("alert").filter({ hasText: "Some or all of the last change may have persisted" })
    ).toBeVisible();
    expect(await storedRaw(page)).toBe(incomingRaw);
    expect((await writes()).length).toBe(writeCount);

    // Retrying an ordinary edit cannot touch this uncertain store. A native
    // close/reload is guarded as well, while this tab retains the previous copy.
    await page.getByRole("button", { name: "Record this" }).click();
    await expect(page.getByLabel("Note")).toHaveValue("Draft to keep");
    expect((await writes()).length).toBe(writeCount);
    expect(await page.evaluate(() => {
      const event = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(event);
      return event.defaultPrevented;
    })).toBe(true);

    const reload = page.getByRole("button", { name: "Reload saved ledger" });
    const [declined] = await Promise.all([
      page.waitForEvent("dialog", { timeout: 5_000 }).then(async (dialog) => {
        const message = dialog.message();
        await dialog.dismiss();
        return message;
      }),
      reload.click(),
    ]);
    expect(declined).toMatch(/export the previous ledger.*copy any drafts/i);
    await expect(page.getByLabel("Note")).toHaveValue("Draft to keep");

    await Promise.all([
      page.waitForEvent("dialog", { timeout: 5_000 }).then((dialog) => dialog.accept()),
      reload.click(),
    ]);
    await expect(page.getByRole("heading", { name: "Saved ledger could not be verified" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Financial settings were not recovered" })).toBeVisible();
    await expect(cash.getByText("$7,777.00", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Note")).toHaveValue("");
    expect(await storedRaw(page)).toBe(incomingRaw);
  });

  test("an uncertain import is not reported as an unchanged ledger", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Enter my own numbers" }).click();
    await page.getByLabel("Money you have now ($)").fill("2500");
    await page.getByRole("button", { name: "Save and show my plan" }).click();
    await expect(page.getByText(/You have \$2,500\.00 recorded/)).toBeVisible();
    const priorRaw = await storedRaw(page);
    expect(priorRaw).not.toBeNull();

    const incoming = validImportState();
    // A real import writes the ledger, then fails verification. The rollback to the
    // exact previous bytes is refused, so the incoming value stays durable.
    await page.evaluate(
      ({ ledgerKey, previousRaw }) => {
        const originalSet = Storage.prototype.setItem;
        const originalGet = Storage.prototype.getItem;
        const local = window.localStorage;
        let mismatchNextRead = false;
        Storage.prototype.setItem = function (key: string, value: string) {
          if (this === local && key === ledgerKey) {
            if (value === previousRaw) {
              throw new DOMException("Synthetic rollback refusal", "QuotaExceededError");
            }
            originalSet.call(this, key, value);
            mismatchNextRead = true;
            return;
          }
          originalSet.call(this, key, value);
        };
        Storage.prototype.getItem = function (key: string) {
          if (this === local && key === ledgerKey && mismatchNextRead) {
            mismatchNextRead = false;
            return "synthetic verification mismatch";
          }
          return originalGet.call(this, key);
        };
      },
      { ledgerKey: LEDGER_STORAGE_KEY, previousRaw: priorRaw }
    );

    await openImportTab(page);
    await page.locator('input[type="file"]').setInputFiles({
      name: "uncertain-import.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(incoming)),
    });

    const uncertain = page
      .getByRole("dialog")
      .getByRole("alert")
      .filter({ hasText: "Import result is uncertain." });
    await expect(uncertain).toBeVisible();
    await expect(uncertain).toContainText(/some or all of the change may have persisted/i);
    await expect(uncertain).not.toContainText(/current ledger is unchanged/i);
    await expect(uncertain).not.toContainText(/Import could not be saved/i);
    await expect(page.getByText(/Successfully imported/)).toHaveCount(0);
    const stored = await storedRaw(page);
    expect(stored).not.toBe(priorRaw);
    expect(JSON.parse(stored ?? "null").updated_at).toBe(incoming.updated_at);
    await expect(page.locator('input[type="file"]')).toBeDisabled();
  });
});

test.describe("snapshot-local identity reuse", () => {
  test.use({ locale: "en-US", timezoneId: "UTC" });

  test("a verified replacement cannot inherit a failed move draft that reuses bill IDs", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.clock.install({ time: new Date("2026-11-23T23:59:00.000Z") });
    await page.clock.pauseAt(new Date("2026-11-23T23:59:30.000Z"));
    const original = powerLedger();
    await seedSyntheticLedger(page, original);
    const originalRaw = await storedRaw(page);

    await page.getByRole("button", { name: "Bills", exact: true }).click();
    const powerRow = page.getByRole("listitem", { name: "Power due Nov 23, 2026", exact: true });
    const powerDate = powerRow.getByLabel("New date for Power due Nov 23, 2026");
    const keptMove = page.getByRole("listitem", {
      name: "Kept move for Power, original slot Nov 23, 2026",
      exact: true,
    });
    const keptDate = keptMove.getByLabel(
      "New date for kept move of Power, original slot Nov 23, 2026"
    );
    await expect(powerDate).toHaveValue("2026-11-23");

    // Genuine one-shot storage failure: the write reaches localStorage's setItem
    // once and is rejected, so the move is a submitted failed draft, not a mock.
    await powerDate.fill("2026-12-03");
    await holdLedgerLock(page);
    try {
      await powerRow.getByRole("button", { name: "Move", exact: true }).click();
      await expect(page.getByText("Saving your ledger change", { exact: true })).toBeVisible();
      await expect.poll(() => queuedWrites(page)).toBe(1);
      expect(await storedRaw(page)).toBe(originalRaw);

      // Cross midnight while the write is queued. The original slot leaves the
      // projection, so the submitted move is retained in its own fallback list.
      await page.clock.runFor(60_000);
      await expect(page.getByText("Saving your ledger change", { exact: true })).toBeVisible();
      await expect(powerRow).toHaveCount(0);
      await expect(keptMove).toBeVisible();
      await expect(keptDate).toHaveValue("2026-12-03");
      await failNextLedgerWrite(page);
    } finally {
      await releaseLedgerLock(page);
    }
    await expect(page.getByText("Saving your ledger change", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Not saved", { exact: true })).toBeVisible();
    await expect(keptMove).toBeVisible();
    await expect(keptDate).toHaveValue("2026-12-03");
    expect(await storedRaw(page)).toBe(originalRaw);

    // Declining the replacement's discard confirmation must not queue any write
    // and must leave both the exact raw ledger and the submitted draft intact.
    await openImportTab(page);
    await holdLedgerLock(page);
    try {
      const declined = await importBackup(page, rentImportState(), "dismiss");
      expect(declined.type).toBe("confirm");
      expect(declined.message).toMatch(/not saved.*discard/i);
      await expect(
        page.getByRole("alert").filter({ hasText: "Replacement cancelled" })
      ).toBeVisible();
      await expect(page.getByText(/Successfully imported/)).toHaveCount(0);
      expect(await storedRaw(page)).toBe(originalRaw);
      expect(await queuedWrites(page)).toBe(0);
    } finally {
      await releaseLedgerLock(page);
    }
    await closeSync(page);
    await expect(keptMove).toBeVisible();
    await expect(keptDate).toHaveValue("2026-12-03");
    await expect(page.getByText("Not saved", { exact: true })).toBeVisible();

    // Accepting the discard is not enough: a confirmed storage failure keeps the
    // same draft and marker, and reports that the previous data is intact.
    await openImportTab(page);
    await failNextLedgerWrite(page);
    const failed = await importBackup(page, rentImportState(), "accept");
    expect(failed.type).toBe("confirm");
    const importFailure = page.getByRole("dialog").getByRole("alert").filter({
      hasText: "Import could not be saved:",
    });
    await expect(importFailure).toBeVisible();
    await expect(importFailure).toContainText(/previous saved data is intact/i);
    await expect(page.getByText(/Successfully imported/)).toHaveCount(0);
    expect(await storedRaw(page)).toBe(originalRaw);
    await closeSync(page);
    await expect(keptMove).toBeVisible();
    await expect(keptDate).toHaveValue("2026-12-03");
    await expect(page.getByText("Not saved", { exact: true })).toBeVisible();

    // A verified retry replaces the ledger. The replacement reuses pmt-1 and the
    // monthly slot, so only a remounted editor subtree can keep the old draft
    // from targeting the new bill.
    await openImportTab(page);
    const accepted = await importBackup(page, rentImportState(), "accept");
    expect(accepted.type).toBe("confirm");
    await expect(page.getByText("Successfully imported ledger backup file!")).toBeVisible();
    const importedRaw = await storedRaw(page);
    expect(importedRaw).not.toBe(originalRaw);
    const imported = JSON.parse(importedRaw ?? "null");
    expect(imported).toEqual(rentImportState());
    // The replacement is the independent Rent snapshot: the old move was not
    // applied and no charge was posted.
    expect(imported.current_balance_cents).toBe(100_000);
    expect(imported.payments).toEqual([
      { id: "pmt-1", name: "Rent", amount_cents: 50_000, recurrence: "Monthly", due_day: 23 },
    ]);
    expect(imported.bill_occurrences).toEqual([]);
    expect(imported.transactions).toEqual(original.transactions);

    await closeSync(page);
    // The same section stays open and now shows the replacement's ordinary view.
    await expect(page.getByRole("button", { name: "Bills", exact: true })).toHaveAttribute(
      "aria-current",
      "page"
    );
    await expect(keptMove).toHaveCount(0);
    const rentRow = page.getByRole("listitem", { name: "Rent due Dec 23, 2026", exact: true });
    await expect(rentRow).toBeVisible();
    await expect(rentRow.getByLabel("New date for Rent due Dec 23, 2026")).toHaveValue("2026-12-23");
    await expect(page.getByText("Not saved", { exact: true })).toHaveCount(0);

    // The failed-draft marker is gone with the verified replacement, so ordinary
    // navigation no longer warns about a draft that the old subtree held.
    let navigationPrompt: string | null = null;
    const onDialog = async (dialog: Dialog) => {
      navigationPrompt = dialog.message();
      await dialog.dismiss();
    };
    page.on("dialog", onDialog);
    try {
      await page.getByRole("button", { name: "Home", exact: true }).click();
      await expect(page.getByRole("button", { name: "Home", exact: true })).toHaveAttribute(
        "aria-current",
        "page"
      );
    } finally {
      page.off("dialog", onDialog);
    }
    expect(navigationPrompt).toBeNull();
    expect(await storedRaw(page)).toBe(importedRaw);
  });
});
