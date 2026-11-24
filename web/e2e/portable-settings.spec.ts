import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";

import { ASSUMPTIONS_STORAGE_KEY } from "../src/lib/assumptions-persistence";
import { BUDGET_TARGETS_KEY } from "../src/lib/budget-targets";
import { LEDGER_STORAGE_KEY } from "../src/lib/persistence";
import { VAULT_ID_STORAGE_KEY } from "../src/lib/sync-state";
import { SAMPLE_LEDGER_STATE } from "../src/lib/types";

/**
 * Portable financial-settings recovery.
 *
 * A vault is more than its records. These cases prove that the reserve and plan
 * window travel with the encrypted plan, that an older vault without a settings
 * profile withholds guidance instead of substituting zero reserve, and that a
 * wrong passphrase never replaces the good ledger.
 */

const PASSPHRASE = "synthetic portable-settings passphrase";
const BASE_URL = "http://127.0.0.1:3100";

function uniqueVaultId(): string {
  return `e2e-settings-${Date.now()}-${randomBytes(4).toString("hex")}`;
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

async function fillVaultForm(page: Page, vaultId: string, passphrase = PASSPHRASE): Promise<void> {
  await page.getByLabel("Vault Identifier").fill(vaultId);
  await page.getByLabel("Vault Secret Passphrase").fill(passphrase);
}

async function push(page: Page, vaultId: string): Promise<void> {
  await openSync(page);
  await fillVaultForm(page, vaultId);
  await page.getByRole("button", { name: "Push (Upload)" }).click();
  await expect(
    page.getByText(/Successfully pushed|Pushed the ledger/)
  ).toBeVisible();
  await closeSync(page);
}

async function pull(page: Page, vaultId: string, passphrase = PASSPHRASE): Promise<void> {
  await openSync(page);
  await fillVaultForm(page, vaultId, passphrase);
  await page.getByRole("button", { name: "Pull (Download)" }).click();
}

async function confirmDemoReplacementIfAsked(page: Page): Promise<void> {
  const confirm = page.getByRole("button", { name: "Replace local ledger with the vault" });
  const appeared = await confirm
    .waitFor({ state: "visible", timeout: 2000 })
    .then(() => true)
    .catch(() => false);
  if (appeared) await confirm.click();
}

async function readAssumptions(page: Page): Promise<any> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  }, ASSUMPTIONS_STORAGE_KEY);
}

async function seedSavedLedger(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(
    ({ ledgerKey, ledger }) => localStorage.setItem(ledgerKey, JSON.stringify(ledger)),
    { ledgerKey: LEDGER_STORAGE_KEY, ledger: SAMPLE_LEDGER_STATE }
  );
  await page.reload();
}

async function newDevice(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: BASE_URL, viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.goto("/");
  return { context, page };
}

test("a recovered vault restores the reserve, plan window, and recommendation inputs", async ({ page, browser }) => {
  await seedSavedLedger(page);
  // Device A: change decision-critical settings through the visible form, then push.
  await page.getByRole("button", { name: "Advanced" }).click();
  await page.getByLabel(/Plan window/).fill("45");
  await page.getByLabel(/Reserve to subtract/).fill("300");
  await page.getByRole("button", { name: "Update results" }).click();
  await expect.poll(async () => (await readAssumptions(page))?.values?.horizonDays).toBe(45);
  await expect.poll(async () => (await readAssumptions(page))?.values?.reserveCents).toBe(30000);

  const vaultId = uniqueVaultId();
  await push(page, vaultId);

  // Device B: a completely fresh browser profile recovers both records and settings.
  const deviceB = await newDevice(browser);
  try {
    await pull(deviceB.page, vaultId);
    await confirmDemoReplacementIfAsked(deviceB.page);
    await expect(deviceB.page.getByText(/Successfully pulled.*Recovered financial settings/)).toBeVisible();
    await expect(deviceB.page.getByText("Financial settings recovered")).toBeVisible();
    await expect.poll(async () => (await readAssumptions(deviceB.page))?.values?.horizonDays).toBe(45);
    await expect.poll(async () => (await readAssumptions(deviceB.page))?.values?.reserveCents).toBe(30000);
    await expect.poll(async () =>
      deviceB.page.evaluate((key) => localStorage.getItem(key) !== null, BUDGET_TARGETS_KEY)
    ).toBe(true);

    await closeSync(deviceB.page);
    await deviceB.page.getByRole("button", { name: "Home" }).click();
    await expect(deviceB.page.getByText(/45-day estimate keeps \$300\.00 as your reserve/)).toBeVisible();
    await expect(deviceB.page.getByText(/Cautious amount to spend/)).toBeVisible();
  } finally {
    await deviceB.context.close();
  }
});

test("an older vault without settings withholds guidance and requires an explicit choice", async ({ page, browser }) => {
  await seedSavedLedger(page);
  // Make the settings unreadable so the push contains the ledger only, like a
  // vault created before the settings profile existed.
  await page.evaluate((key) => localStorage.setItem(key, "{not-json"), ASSUMPTIONS_STORAGE_KEY);
  await page.reload();
  const vaultId = uniqueVaultId();
  await push(page, vaultId);

  const deviceB = await newDevice(browser);
  try {
    await pull(deviceB.page, vaultId);
    await confirmDemoReplacementIfAsked(deviceB.page);
    await expect(
      deviceB.page.getByRole("heading", { name: "Financial settings were not recovered" })
    ).toBeVisible();
    await expect(deviceB.page.getByText(/No spending recommendation or risk estimate is shown/)).toBeVisible();
    await expect(deviceB.page.getByText(/Cautious amount to spend/)).toHaveCount(0);

    // The user can deliberately keep the values shown now; that saves them and
    // closes the gate. No recovery claim is made.
    await closeSync(deviceB.page);
    await deviceB.page.getByRole("button", { name: "Use the settings shown now" }).click();
    await expect(deviceB.page.getByRole("heading", { name: "Financial settings were not recovered" })).toHaveCount(0);
    await expect(deviceB.page.getByText(/Cautious amount to spend/)).toBeVisible();
  } finally {
    await deviceB.context.close();
  }
});

test("a wrong passphrase does not replace the recovered ledger", async ({ page, browser }) => {
  await seedSavedLedger(page);
  const vaultId = uniqueVaultId();
  await push(page, vaultId);
  const goodLedger = await page.evaluate((key) => localStorage.getItem(key), LEDGER_STORAGE_KEY);

  const deviceB = await newDevice(browser);
  try {
    await deviceB.page.evaluate(
      ({ ledgerKey, vaultKey, ledger }) => {
        localStorage.setItem(ledgerKey, ledger!);
        localStorage.setItem(vaultKey, "existing-local-vault");
      },
      { ledgerKey: LEDGER_STORAGE_KEY, vaultKey: VAULT_ID_STORAGE_KEY, ledger: goodLedger }
    );
    const before = await deviceB.page.evaluate((key) => localStorage.getItem(key), LEDGER_STORAGE_KEY);
    await pull(deviceB.page, vaultId, "wrong synthetic passphrase");
    await confirmDemoReplacementIfAsked(deviceB.page);
    await expect(deviceB.page.getByText(/Wrong passphrase|Failed to pull|not found/i)).toBeVisible();
    const after = await deviceB.page.evaluate((key) => localStorage.getItem(key), LEDGER_STORAGE_KEY);
    expect(after).toBe(before);
    await expect(deviceB.page.getByRole("heading", { name: "Financial settings were not recovered" })).toHaveCount(0);
  } finally {
    await deviceB.context.close();
  }
});
