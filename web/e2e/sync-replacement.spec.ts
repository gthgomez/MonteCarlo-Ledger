import { expect, test, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";

import { LEDGER_LOCK_NAME } from "../src/lib/persistence";
import { SAMPLE_LEDGER_STATE, type LedgerState } from "../src/lib/types";

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
    test.setTimeout(90_000);
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
