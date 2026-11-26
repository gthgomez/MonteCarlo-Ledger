import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { randomBytes } from "node:crypto";

import { DEFAULT_ASSUMPTIONS } from "../src/lib/assumptions";
import { ASSUMPTIONS_STORAGE_KEY } from "../src/lib/assumptions-persistence";
import { BUDGET_TARGETS_KEY } from "../src/lib/budget-targets";
import { LEDGER_STORAGE_KEY } from "../src/lib/persistence";
import { VAULT_ID_STORAGE_KEY } from "../src/lib/sync-state";
import { SAMPLE_LEDGER_STATE } from "../src/lib/types";
import { failNextLedgerWrite } from "./helpers/ledger-lock";

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
/** Local-only durable guard written in the same bundle as a vault restore. */
const SETTINGS_REVIEW_KEY = "montecarlo_settings_review_v1";

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
    ({ ledgerKey, ledger }) => {
      localStorage.setItem(ledgerKey, JSON.stringify(ledger));
      localStorage.removeItem("montecarlo_demo_mode_v1");
    },
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

function storedReview(page: Page): Promise<string | null> {
  return page.evaluate((key) => localStorage.getItem(key), SETTINGS_REVIEW_KEY);
}

async function expectReviewGate(page: Page, visible = true): Promise<void> {
  const heading = page.getByRole("heading", { name: "Financial settings were not recovered" });
  if (visible) {
    await expect(heading).toBeVisible();
    await expect(page.getByText(/Cautious amount to spend/)).toHaveCount(0);
  } else {
    await expect(heading).toHaveCount(0);
    await expect(page.getByText(/Cautious amount to spend/).first()).toBeVisible();
  }
}

/** Make a fresh ledger-only vault, like a Python/older-Web push without a settings profile. */
async function pushLedgerOnlyVault(page: Page, vaultId: string): Promise<void> {
  await page.evaluate((key) => localStorage.setItem(key, "{not-json"), ASSUMPTIONS_STORAGE_KEY);
  await page.reload();
  await push(page, vaultId);
}

async function pullAndRestore(page: Page, vaultId: string): Promise<void> {
  await pull(page, vaultId);
  await confirmDemoReplacementIfAsked(page);
}

/** Fail one durable-guard write in this synthetic browser context. */
async function failNextReviewWrite(page: Page): Promise<void> {
  await page.evaluate((reviewKey) => {
    const original = Storage.prototype.setItem;
    const local = window.localStorage;
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      if (this === local && key === reviewKey) {
        Storage.prototype.setItem = original;
        throw new DOMException("Synthetic review write failure", "QuotaExceededError");
      }
      return original.call(this, key, value);
    };
  }, SETTINGS_REVIEW_KEY);
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

async function failNextBudgetWrite(page: Page): Promise<void> {
  await page.evaluate((budgetKey) => {
    const original = Storage.prototype.setItem;
    const local = window.localStorage;
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      if (this === local && key === budgetKey) {
        Storage.prototype.setItem = original;
        throw new DOMException("Synthetic budget write failure", "QuotaExceededError");
      }
      return original.call(this, key, value);
    };
  }, BUDGET_TARGETS_KEY);
}

const SETTINGS_WRITE_LOCK = "montecarlo-financial-settings-write";
interface SettingsLockHarness {
  releaseTestSettingsLock?: () => void;
}

async function holdSettingsLock(page: Page): Promise<void> {
  await page.evaluate(
    (name) =>
      new Promise<void>((acquired) => {
        const harness = window as Window & SettingsLockHarness;
        const hold = new Promise<void>((release) => {
          harness.releaseTestSettingsLock = release;
        });
        void navigator.locks.request(name, () => {
          acquired();
          return hold;
        });
      }),
    SETTINGS_WRITE_LOCK
  );
}

async function releaseSettingsLock(page: Page): Promise<void> {
  await page.evaluate(() => {
    const harness = window as Window & SettingsLockHarness;
    const release = harness.releaseTestSettingsLock;
    delete harness.releaseTestSettingsLock;
    release?.();
  });
}

async function installStorageOrderRecorder(page: Page): Promise<void> {
  await page.evaluate(
    ({ ledgerKey, reviewKey }) => {
      const harness = window as Window & { __storageOps?: string[] };
      const ops: string[] = [];
      harness.__storageOps = ops;
      const originalSet = Storage.prototype.setItem;
      const originalRemove = Storage.prototype.removeItem;
      Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
        if (key === ledgerKey || key === reviewKey) ops.push(`set:${key}`);
        return originalSet.call(this, key, value);
      };
      Storage.prototype.removeItem = function (this: Storage, key: string) {
        if (key === ledgerKey || key === reviewKey) ops.push(`remove:${key}`);
        return originalRemove.call(this, key);
      };
    },
    { ledgerKey: LEDGER_STORAGE_KEY, reviewKey: SETTINGS_REVIEW_KEY }
  );
}

function storageOps(page: Page): Promise<string[]> {
  return page.evaluate(
    () => (window as Window & { __storageOps?: string[] }).__storageOps ?? []
  );
}

function syntheticGuard(
  vaultId: string,
  ledgerRevision: number,
  token: string,
  reason: "missing" | "unreadable" | "settings-pending" = "missing"
): Record<string, unknown> {
  return {
    vaultId,
    ledgerRevision,
    token,
    reason,
    recordedAt: "2026-11-24T10:00:00.000Z",
  };
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
    // A compatible applied profile clears its restore guard; a reload must not
    // re-open the review gate or lose the recovered settings.
    expect(await storedReview(deviceB.page)).toBeNull();
    await deviceB.page.reload();
    await expect(deviceB.page.getByText(/45-day estimate keeps \$300\.00 as your reserve/)).toBeVisible();
    await expect(deviceB.page.getByText(/Cautious amount to spend/).first()).toBeVisible();
  } finally {
    await deviceB.context.close();
  }
});

test("an older vault without settings withholds guidance, survives reload, and needs an explicit review", async ({ page, browser }) => {
  await seedSavedLedger(page);
  // Make the settings unreadable so the push contains the ledger only, like a
  // vault created before the settings profile existed.
  const vaultId = uniqueVaultId();
  await pushLedgerOnlyVault(page, vaultId);

  const deviceB = await newDevice(browser);
  try {
    await pullAndRestore(deviceB.page, vaultId);
    await expectReviewGate(deviceB.page);
    // The guard is durable and part of the restore, not just React state.
    expect(await storedReview(deviceB.page)).not.toBeNull();

    await closeSync(deviceB.page);
    await deviceB.page.reload();
    await expectReviewGate(deviceB.page);
    expect(await storedReview(deviceB.page)).not.toBeNull();

    // Navigation and a reload must re-show the review, not silently open guidance.
    await deviceB.page.getByRole("button", { name: "Advanced" }).click();
    await expectReviewGate(deviceB.page);
    await deviceB.page.getByRole("button", { name: "Home" }).click();
    await expectReviewGate(deviceB.page);
    await deviceB.page.reload();
    await expectReviewGate(deviceB.page);

    // The explicit review saves the values shown now and clears only this guard.
    await deviceB.page.getByRole("button", { name: "Use the settings shown now" }).click();
    await expectReviewGate(deviceB.page, false);
    expect(await storedReview(deviceB.page)).toBeNull();
    await deviceB.page.reload();
    await expectReviewGate(deviceB.page, false);
  } finally {
    await deviceB.context.close();
  }
});

test("existing saved settings are kept but not trusted after a ledger-only restore", async ({ page, browser }) => {
  await seedSavedLedger(page);
  const vaultId = uniqueVaultId();
  await pushLedgerOnlyVault(page, vaultId);

  const deviceB = await newDevice(browser);
  try {
    const saved = { ...DEFAULT_ASSUMPTIONS, horizonDays: 30, reserveCents: 12_345 };
    await deviceB.page.evaluate(
      ({ key, values }) => localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, values })),
      { key: ASSUMPTIONS_STORAGE_KEY, values: saved }
    );
    await deviceB.page.reload();

    await pullAndRestore(deviceB.page, vaultId);
    await expectReviewGate(deviceB.page);
    // The local record is preserved for the review, not silently used as guidance.
    await expect.poll(async () => (await readAssumptions(deviceB.page))?.values?.reserveCents).toBe(12_345);
    await expect.poll(async () => (await readAssumptions(deviceB.page))?.values?.horizonDays).toBe(30);

    await closeSync(deviceB.page);
    await deviceB.page.reload();
    await expectReviewGate(deviceB.page);
    await deviceB.page.getByRole("button", { name: "Use the settings shown now" }).click();
    await expectReviewGate(deviceB.page, false);
    expect(await storedReview(deviceB.page)).toBeNull();
  } finally {
    await deviceB.context.close();
  }
});

test("a failed explicit review save keeps the durable guard", async ({ page, browser }) => {
  await seedSavedLedger(page);
  const vaultId = uniqueVaultId();
  await pushLedgerOnlyVault(page, vaultId);

  const deviceB = await newDevice(browser);
  try {
    await pullAndRestore(deviceB.page, vaultId);
    await closeSync(deviceB.page);
    await deviceB.page.reload();
    await expectReviewGate(deviceB.page);

    await failNextSettingsWrite(deviceB.page);
    await deviceB.page.getByRole("button", { name: "Use the settings shown now" }).click();
    await expect(
      deviceB.page.getByText(/Financial settings could not be saved|previous saved settings were verified/i)
    ).toBeVisible();
    await expectReviewGate(deviceB.page);
    expect(await storedReview(deviceB.page)).not.toBeNull();

    await deviceB.page.reload();
    await expectReviewGate(deviceB.page);
    await deviceB.page.getByRole("button", { name: "Use the settings shown now" }).click();
    await expectReviewGate(deviceB.page, false);
    expect(await storedReview(deviceB.page)).toBeNull();
  } finally {
    await deviceB.context.close();
  }
});

test("a failed settings apply during restore keeps the ledger but not guidance", async ({ page, browser }) => {
  await seedSavedLedger(page);
  const vaultId = uniqueVaultId();
  await push(page, vaultId);

  const deviceB = await newDevice(browser);
  try {
    await failNextSettingsWrite(deviceB.page);
    await pullAndRestore(deviceB.page, vaultId);
    await expect(
      deviceB.page.getByText(/recovered financial settings could not be saved|settings need review/i).first()
    ).toBeVisible();
    await expectReviewGate(deviceB.page);
    expect(await storedReview(deviceB.page)).not.toBeNull();

    await closeSync(deviceB.page);
    await deviceB.page.reload();
    await expectReviewGate(deviceB.page);
    await deviceB.page.getByRole("button", { name: "Use the settings shown now" }).click();
    await expectReviewGate(deviceB.page, false);
    expect(await storedReview(deviceB.page)).toBeNull();
  } finally {
    await deviceB.context.close();
  }
});

test("a local replacement clears the review guard only after the ledger is verified", async ({ page }) => {
  await seedSavedLedger(page);
  const guard = syntheticGuard("synthetic-import-vault", 3, "synthetic-import-token");
  await page.evaluate(
    ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
    { key: SETTINGS_REVIEW_KEY, value: guard }
  );
  await page.reload();
  await expectReviewGate(page);

  await installStorageOrderRecorder(page);
  await openSync(page);
  await page.getByRole("button", { name: "Local JSON Backup" }).click();
  const incoming = {
    ...(JSON.parse(JSON.stringify(SAMPLE_LEDGER_STATE)) as typeof SAMPLE_LEDGER_STATE),
    updated_at: "2026-11-25T00:00:00.000Z",
  };
  await page.locator('input[type="file"]').setInputFiles({
    name: "replacement.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(incoming)),
  });
  await expect(page.getByText("Successfully imported ledger backup file!")).toBeVisible();

  const ops = await storageOps(page);
  const ledgerIndex = ops.indexOf(`set:${LEDGER_STORAGE_KEY}`);
  const reviewIndex = ops.indexOf(`remove:${SETTINGS_REVIEW_KEY}`);
  expect(ledgerIndex).toBeGreaterThanOrEqual(0);
  expect(reviewIndex).toBeGreaterThanOrEqual(0);
  expect(ledgerIndex).toBeLessThan(reviewIndex);
  expect(await storedReview(page)).toBeNull();
  await closeSync(page);
});

test("an explicit review cannot overwrite settings after a newer guard appears", async ({ page }) => {
  await seedSavedLedger(page);
  const older = syntheticGuard("older-review-vault", 2, "older-review-token");
  await page.evaluate(
    ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
    { key: SETTINGS_REVIEW_KEY, value: older }
  );
  await page.reload();
  await expectReviewGate(page);

  // Same-document write: the page still holds the older identity it displayed.
  const newer = syntheticGuard("newer-review-vault", 3, "newer-review-token", "settings-pending");
  await page.evaluate(
    ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
    { key: SETTINGS_REVIEW_KEY, value: newer }
  );
  await page.getByRole("button", { name: "Use the settings shown now" }).click();
  await expect(page.getByText(/newer vault restore replaced/i).first()).toBeVisible();
  expect(await readAssumptions(page)).toBeNull();
  expect(await storedReview(page)).toBe(JSON.stringify(newer));
  await expectReviewGate(page);

  await page.reload();
  await expectReviewGate(page);
});

test("guard storage events adopt a missing gate and preserve a known one", async ({ page }) => {
  await seedSavedLedger(page);
  const sibling = await page.context().newPage();
  await sibling.goto("/");

  const first = syntheticGuard("event-review-vault-one", 3, "event-review-token-one");
  await sibling.evaluate(
    ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
    { key: SETTINGS_REVIEW_KEY, value: first }
  );
  await expectReviewGate(page);
  // Let the recovery-status ref settle before the replacing event.
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
  );

  const second = syntheticGuard("event-review-vault-two", 4, "event-review-token-two");
  await sibling.evaluate(
    ({ key, value }) => localStorage.setItem(key, JSON.stringify(value)),
    { key: SETTINGS_REVIEW_KEY, value: second }
  );
  await page.getByRole("button", { name: "Use the settings shown now" }).click();
  await expect(page.getByText(/newer vault restore replaced/i).first()).toBeVisible();
  expect(await readAssumptions(page)).toBeNull();
  expect(await storedReview(page)).toBe(JSON.stringify(second));
  await expectReviewGate(page);
});

test("a target save failure keeps the restore guard", async ({ page, browser }) => {
  await seedSavedLedger(page);
  const vaultId = uniqueVaultId();
  await push(page, vaultId);

  const deviceB = await newDevice(browser);
  try {
    await failNextBudgetWrite(deviceB.page);
    await pullAndRestore(deviceB.page, vaultId);
    await expect(
      deviceB.page.getByText(/financial settings need review|could not be saved/i).first()
    ).toBeVisible();
    await expectReviewGate(deviceB.page);
    expect(await storedReview(deviceB.page)).not.toBeNull();

    await closeSync(deviceB.page);
    await deviceB.page.reload();
    await expectReviewGate(deviceB.page);
    await deviceB.page.getByRole("button", { name: "Use the settings shown now" }).click();
    await expectReviewGate(deviceB.page, false);
    expect(await storedReview(deviceB.page)).toBeNull();
  } finally {
    await deviceB.context.close();
  }
});

test("a restored ledger gates guidance immediately while its profile is still applying", async ({ page, browser }) => {
  await seedSavedLedger(page);
  const vaultId = uniqueVaultId();
  await push(page, vaultId);

  const deviceB = await newDevice(browser);
  try {
    await holdSettingsLock(deviceB.page);
    await pull(deviceB.page, vaultId);
    await confirmDemoReplacementIfAsked(deviceB.page);
    // The ledger is saved and the pending gate is live while saveAssumptions
    // waits for the settings lock.
    await expectReviewGate(deviceB.page);
    await expect(deviceB.page.getByText(/Recovered financial settings/)).toHaveCount(0);
  } finally {
    await releaseSettingsLock(deviceB.page);
  }
  await expect(deviceB.page.getByText(/Recovered financial settings/).first()).toBeVisible();
  await closeSync(deviceB.page);
});

test("a mismatched profile is reviewed, and the next push re-pairs from observed ancestry", async ({ page, browser }) => {
  await seedSavedLedger(page);
  const vaultId = uniqueVaultId();
  await push(page, vaultId);
  // Advance the ledger without a settings profile, like a Python/older-Web push.
  await pushLedgerOnlyVault(page, vaultId);

  const deviceB = await newDevice(browser);
  try {
    await pullAndRestore(deviceB.page, vaultId);
    await expect(
      deviceB.page.getByText(/bound to ledger revision 1|saved for ledger revision 1/).first()
    ).toBeVisible();
    await expectReviewGate(deviceB.page);

    await closeSync(deviceB.page);
    await deviceB.page.getByRole("button", { name: "Use the settings shown now" }).click();
    await expectReviewGate(deviceB.page, false);

    // The mismatched profile still recorded its settings-object ancestry, so the
    // explicit review can re-pair on the next push without a forced conflict.
    await openSync(deviceB.page);
    await fillVaultForm(deviceB.page, vaultId);
    await deviceB.page.getByRole("button", { name: "Push (Upload)" }).click();
    await expect(deviceB.page.getByText(/Successfully pushed encrypted snapshot/)).toBeVisible();
    await expect(deviceB.page.getByText(/Financial settings saved/)).toBeVisible();
    await closeSync(deviceB.page);
  } finally {
    await deviceB.context.close();
  }
});

test("a durable guard from an interrupted restore survives reload and clears only on review", async ({ page }) => {
  await seedSavedLedger(page);
  await page.evaluate(
    ({ key, guard }) => localStorage.setItem(key, JSON.stringify(guard)),
    {
      key: SETTINGS_REVIEW_KEY,
      guard: {
        vaultId: "synthetic-interrupted-vault",
        ledgerRevision: 4,
        token: "synthetic-review-token",
        reason: "settings-pending",
        recordedAt: "2026-11-24T10:00:00.000Z",
      },
    }
  );
  await page.reload();
  await expectReviewGate(page);
  expect(await storedReview(page)).not.toBeNull();

  await page.reload();
  await expectReviewGate(page);
  await page.getByRole("button", { name: "Use the settings shown now" }).click();
  await expectReviewGate(page, false);
  expect(await storedReview(page)).toBeNull();
});

test("a storage event from an unrelated settings write does not erase the durable guard", async ({ page, browser }) => {
  await seedSavedLedger(page);
  const vaultId = uniqueVaultId();
  await pushLedgerOnlyVault(page, vaultId);

  const deviceB = await newDevice(browser);
  try {
    await pullAndRestore(deviceB.page, vaultId);
    await closeSync(deviceB.page);
    await expectReviewGate(deviceB.page);

    // A sibling document changes the settings key without going through the
    // recovery path. The event must update values, not open the guidance gate.
    const sibling = await deviceB.context.newPage();
    await sibling.goto("/");
    await sibling.evaluate(
      ({ key, values }) => localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, values })),
      { key: ASSUMPTIONS_STORAGE_KEY, values: { ...DEFAULT_ASSUMPTIONS, reserveCents: 7_777 } }
    );
    await expect(deviceB.page.getByText(/\$77\.77/).first()).toBeVisible();
    await expectReviewGate(deviceB.page);
    expect(await storedReview(deviceB.page)).not.toBeNull();

    await deviceB.page.reload();
    await expectReviewGate(deviceB.page);
    await deviceB.page.getByRole("button", { name: "Use the settings shown now" }).click();
    await expectReviewGate(deviceB.page, false);
    expect(await storedReview(deviceB.page)).toBeNull();
  } finally {
    await deviceB.context.close();
  }
});

test("a restore whose durable review guard cannot be stored is not reported as success", async ({ page, browser }) => {
  await seedSavedLedger(page);
  const vaultId = uniqueVaultId();
  await push(page, vaultId);

  const deviceB = await newDevice(browser);
  try {
    const olderGuard = {
      vaultId: "older-synthetic-vault",
      ledgerRevision: 2,
      token: "older-review-token",
      reason: "missing",
      recordedAt: "2026-11-23T10:00:00.000Z",
    };
    const olderRaw = JSON.stringify(olderGuard);
    await deviceB.page.evaluate(
      ({ key, guard }) => localStorage.setItem(key, JSON.stringify(guard)),
      { key: SETTINGS_REVIEW_KEY, guard: olderGuard }
    );

    const before = await deviceB.page.evaluate((key) => localStorage.getItem(key), LEDGER_STORAGE_KEY);
    await failNextReviewWrite(deviceB.page);
    await pull(deviceB.page, vaultId);
    await confirmDemoReplacementIfAsked(deviceB.page);
    await expect(deviceB.page.getByText(/restore was not persisted|review could not be stored/i).first()).toBeVisible();
    await expect(deviceB.page.getByText(/Successfully pulled/)).toHaveCount(0);

    const after = await deviceB.page.evaluate((key) => localStorage.getItem(key), LEDGER_STORAGE_KEY);
    expect(after).toBe(before);
    // A verified failure restores the prior guard byte-for-byte.
    expect(await storedReview(deviceB.page)).toBe(olderRaw);
    await deviceB.page.reload();
    await expectReviewGate(deviceB.page);
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
