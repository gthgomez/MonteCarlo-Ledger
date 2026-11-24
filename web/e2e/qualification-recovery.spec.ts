import { expect, test, type Page } from "@playwright/test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  QUALIFICATION_PYTHON_ENV,
  qualificationPythonEnv,
  runQualificationPython,
} from "./helpers/qualification-python";

/**
 * W2 recovery qualification: Web → vault HTTP routes → real Python sync/SQLite
 * → fresh Web client.
 *
 * This is intentionally opt-in. Set MC_QUALIFICATION_PYTHON to an absolute
 * interpreter path (with this checkout and `cryptography` importable). Without
 * it the test is reported as skipped, so a Web-only lane does not claim it.
 *
 * Beyond the happy path, the same synthetic vault proves that a stale origin
 * tab cannot push over Python's newer revision, and that an authenticated
 * restore whose durable bundle write fails leaves the previous ledger, vault
 * identity and revision ancestry unchanged.
 *
 * The server is the Playwright-managed loopback build with
 * VAULT_MEMORY_STORE=1 and empty Turso overrides (see playwright.config.ts).
 * Every assertion below is about one synthetic one-time vault; the temporary
 * SQLite file is disposable and no existing ledger, env file, credential, or
 * external endpoint is read.
 */

const DESKTOP_ONLY = "Recovery qualification runs once on the desktop project.";

const LEDGER_STORAGE_KEY = "montecarlo_ledger_state_v2";
const SYNC_STORAGE_KEY = "montecarlo_vault_sync_v1";
const VAULT_ID_STORAGE_KEY = "montecarlo_vault_id";
const THEME_STORAGE_KEY = "mc-theme";
const ASSUMPTIONS_STORAGE_KEY = "montecarlo_financial_assumptions";
const BUDGET_STORAGE_KEY = "montecarlo_budget_targets_v1";

const AS_OF = "2028-02-01";
const AS_OF_INSTANT = new Date(`${AS_OF}T12:00:00.000Z`);
const SYNTHETIC_PASSPHRASE = "mc-w2-synthetic-qualification-passphrase";
const SYNTHETIC_WRONG_PASSPHRASE = "mc-w2-synthetic-wrong-passphrase";
const EDIT_DESCRIPTION = "MC-W2 qualification edit";
const EDIT_AMOUNT_CENTS = -2_500;

const INCOME_ID = "income-paycheck";
const INCOME_AMOUNT_CENTS = 100_000;
const INCOME_LAST_PAYDAY = "2028-01-08";
const INCOME_NEXT_PAYDAY = "2028-02-08";

/**
 * Synthetic household based on testdata/household/vault-payment-identity.json.
 * It adds a monthly income and a paid occurrence whose due date moved from its
 * original slot, so the round trip must preserve income/payment/transaction/
 * occurrence linkage, not just row counts.
 *
 * Hand-derived values (all cents, asOf 2028-02-01, 90-day window):
 *   opening (Adjustment, 2028-01-31)            +180,000
 *   February rent (Expense, 2028-02-01)          -60,000
 *   opening cash                                120,000
 *   synthetic paycheck (Income, 8th monthly)    +100,000 x 3
 *   car payment (15th monthly)                   -50,000 x 3
 *   rent payment (5th monthly, Feb slot paid)    -60,000 x 2
 *
 * Exact running balances:
 *   2028-02-08  220,000
 *   2028-02-15  170,000
 *   2028-03-05  110,000
 *   2028-03-08  210,000
 *   2028-03-15  160,000
 *   2028-04-05  100,000  <- exact low (rent lands before the 8th paycheck)
 *   2028-04-08  200,000
 *   2028-04-15  150,000
 *
 * The linked car-loan minimum is covered by the car bill slots, so it adds no
 * second outflow. The Python edit posts -2,500 on 2028-02-01:
 *   restored opening cash 117,500, restored exact low 97,500.
 */
function syntheticHousehold() {
  return {
    version: "2.2",
    current_balance_cents: 120_000,
    incomes: [
      {
        id: INCOME_ID,
        name: "Synthetic paycheck",
        amount_cents: INCOME_AMOUNT_CENTS,
        frequency: "Monthly",
        last_payday: INCOME_LAST_PAYDAY,
        next_payday: INCOME_NEXT_PAYDAY,
      },
    ],
    payments: [
      {
        id: "payment-car",
        name: "Car loan",
        amount_cents: 50_000,
        recurrence: "Monthly",
        due_day: 15,
      },
      {
        id: "payment-rent",
        name: "Rent",
        amount_cents: 60_000,
        recurrence: "Monthly",
        due_day: 5,
      },
    ],
    transactions: [
      {
        id: "opening",
        type: "Adjustment",
        amount_cents: 180_000,
        date: "2028-01-31",
      },
      {
        id: "tx-rent-paid",
        type: "Expense",
        amount_cents: -60_000,
        date: "2028-02-01",
        category: "Housing",
        description: "February rent",
      },
    ],
    bill_occurrences: [
      {
        id: "occ-rent-feb",
        payment_id: "payment-rent",
        due_date: "2028-02-07",
        original_due_date: "2028-02-05",
        paid: true,
        transaction_id: "tx-rent-paid",
        is_user_modified: true,
      },
    ],
    liabilities: [
      {
        id: "debt-car",
        name: "Car loan",
        balance_cents: 300_000,
        apr_basis_points: 0,
        min_payment_cents: 50_000,
        due_day_of_month: 15,
        linked_payment_id: "payment-car",
      },
      {
        id: "10",
        name: "Archived",
        balance_cents: 45_000,
        apr_basis_points: 0,
        min_payment_cents: 8_000,
        is_active: false,
      },
    ],
  };
}

async function readStorage(page: Page, key: string): Promise<string | null> {
  return page.evaluate((storageKey) => localStorage.getItem(storageKey), key);
}

async function readLedger(page: Page): Promise<any> {
  const raw = await readStorage(page, LEDGER_STORAGE_KEY);
  return raw === null ? null : JSON.parse(raw);
}

function moneyNow(page: Page) {
  return page
    .getByRole("heading", { name: "Money available now" })
    .locator("..")
    .locator("p")
    .first();
}

function exactLow(page: Page) {
  return page
    .getByRole("heading", { name: "Lowest point if the schedule is exact" })
    .locator("..")
    .locator("p")
    .first();
}

function openSync(page: Page) {
  return page.getByRole("button", { name: /^Cloud Vault/ }).click();
}

function closeSync(page: Page) {
  return page.getByRole("button", { name: "Close synchronization" }).click();
}

async function fillVaultForm(page: Page, vaultId: string, passphrase: string) {
  await page.getByPlaceholder("e.g. personal-budget-vault").fill(vaultId);
  await page.getByPlaceholder("Enter secret passphrase").fill(passphrase);
}

function sortedIds(rows: Array<{ id: unknown }>): string[] {
  return rows.map((row) => String(row.id)).sort();
}

/**
 * Canonical user data of a supported snapshot.
 *
 * Every supported top-level field and every row field is compared exactly; only
 * two documented transformations are applied:
 *   1. Collections are ordered by stable identifier, because Python exports each
 *      collection with `ORDER BY id` while a Web ledger keeps its own order.
 *   2. `updated_at` is excluded here. It is export metadata: Python regenerates
 *      it on every export, and the encrypted payload is exported before a later
 *      metadata-only export. Timestamps are checked separately.
 *
 * This is deliberately not a "compare the fields we happen to remember" matcher:
 * an unexpected extra or missing row field fails the comparison.
 */
function canonicalSnapshot(snapshot: any) {
  const ordered = (rows: any[], collection: string) =>
    [...rows].sort((left, right) => {
      const a = String(left.id);
      const b = String(right.id);
      if (a === b) throw new Error(`${collection} contains duplicate id ${a}`);
      return a < b ? -1 : 1;
    });

  return {
    version: snapshot.version,
    current_balance_cents: snapshot.current_balance_cents,
    incomes: ordered(snapshot.incomes, "incomes"),
    payments: ordered(snapshot.payments, "payments"),
    transactions: ordered(snapshot.transactions, "transactions"),
    bill_occurrences: ordered(snapshot.bill_occurrences, "bill_occurrences"),
    liabilities: ordered(snapshot.liabilities, "liabilities"),
  };
}

function expectCanonicalSnapshotEqual(actual: any, expected: any, message: string): void {
  expect(canonicalSnapshot(actual), message).toEqual(canonicalSnapshot(expected));
}

/**
 * The supported Web→Python snapshot after Python records its documented defaults.
 *
 * Defaults applied by the Python restore path (not data loss):
 *   incomes.expected_amount omitted  -> null
 *   payments.due_date omitted        -> null
 *   payments.is_auto_withdraw omitted -> true
 *   transactions.category/description omitted -> null
 *   liabilities.kind omitted for an installment -> omitted again on export
 *   liabilities.is_active omitted when true -> omitted again on export
 *
 * String identifiers are preserved through `snapshot_id`, so the stable ids stay
 * the same across Web, Python, and the second Web client.
 */
function expectedBasePythonSnapshot() {
  return {
    version: "2.2",
    current_balance_cents: 120_000,
    incomes: [
      {
        id: INCOME_ID,
        name: "Synthetic paycheck",
        amount_cents: INCOME_AMOUNT_CENTS,
        frequency: "Monthly",
        last_payday: INCOME_LAST_PAYDAY,
        next_payday: INCOME_NEXT_PAYDAY,
        expected_amount: null,
      },
    ],
    payments: [
      {
        id: "payment-car",
        name: "Car loan",
        amount_cents: 50_000,
        due_day: 15,
        recurrence: "Monthly",
        due_date: null,
        is_auto_withdraw: true,
      },
      {
        id: "payment-rent",
        name: "Rent",
        amount_cents: 60_000,
        due_day: 5,
        recurrence: "Monthly",
        due_date: null,
        is_auto_withdraw: true,
      },
    ],
    transactions: [
      {
        id: "opening",
        amount_cents: 180_000,
        category: null,
        type: "Adjustment",
        date: "2028-01-31",
        description: null,
      },
      {
        id: "tx-rent-paid",
        amount_cents: -60_000,
        category: "Housing",
        type: "Expense",
        date: "2028-02-01",
        description: "February rent",
      },
    ],
    bill_occurrences: [
      {
        id: "occ-rent-feb",
        payment_id: "payment-rent",
        due_date: "2028-02-07",
        paid: true,
        transaction_id: "tx-rent-paid",
        original_due_date: "2028-02-05",
        is_user_modified: true,
      },
    ],
    liabilities: [
      {
        id: "10",
        name: "Archived",
        balance_cents: 45_000,
        apr_basis_points: 0,
        min_payment_cents: 8_000,
        is_active: false,
      },
      {
        id: "debt-car",
        name: "Car loan",
        balance_cents: 300_000,
        apr_basis_points: 0,
        min_payment_cents: 50_000,
        due_day_of_month: 15,
        linked_payment_id: "payment-car",
      },
    ],
  };
}

function expectedEditedPythonSnapshot(newTransactionId: number) {
  const base = expectedBasePythonSnapshot();
  return {
    ...base,
    current_balance_cents: 117_500,
    transactions: [
      ...base.transactions,
      {
        id: newTransactionId,
        amount_cents: EDIT_AMOUNT_CENTS,
        category: "Qualification",
        type: "Expense",
        date: AS_OF,
        description: EDIT_DESCRIPTION,
      },
    ],
  };
}

/**
 * Install a one-shot localStorage write failure for the isolated sync-ancestry
 * key. The pull still authenticates, downloads, decrypts and validates; only the
 * durable bundle commit fails. The single failure lets `applyLedgerBundle` roll
 * every touched key back, which is exactly the defensive behavior under test.
 */
async function failNextSyncStorageWrite(page: Page): Promise<void> {
  await page.evaluate((storageKey) => {
    (window as any).__mcQualificationWriteFailure = false;
    const original = Storage.prototype.setItem;
    let failed = false;
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      if (!failed && key === storageKey) {
        failed = true;
        (window as any).__mcQualificationWriteFailure = true;
        throw new DOMException("Synthetic qualification write failure", "QuotaExceededError");
      }
      return original.call(this, key, value);
    };
  }, SYNC_STORAGE_KEY);
}

test.describe("W2 Web → Python → fresh Web recovery", () => {
  test.use({ timezoneId: "UTC", locale: "en-US", colorScheme: "light" });

  test("real browser push, Python edit/push, stale-client conflict, fresh restore, repeat, and failed-restore nonreplacement", async ({
    browser,
    baseURL,
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", DESKTOP_ONLY);

    const configuredPython = process.env[QUALIFICATION_PYTHON_ENV]?.trim() ?? "";
    test.skip(
      !configuredPython,
      `Set ${QUALIFICATION_PYTHON_ENV} to an absolute Python interpreter path with this checkout and cryptography installed. ` +
        "Cross-interface recovery is opt-in so a Web-only run is reported as skipped, not passed."
    );
    test.setTimeout(120_000);
    page.setDefaultTimeout(10_000);

    // Refuse to send browser or Python traffic anywhere but the loopback test server.
    expect(baseURL).toBeTruthy();
    const loopback = new URL(String(baseURL));
    expect(loopback.protocol).toBe("http:");
    expect(loopback.hostname).toBe("127.0.0.1");
    expect(loopback.port).toBe("3100");
    const serverUrl = loopback.origin;

    expect(path.isAbsolute(configuredPython), `${QUALIFICATION_PYTHON_ENV} must be an absolute path`).toBe(true);
    const python = configuredPython;
    expect(fs.existsSync(python), `${QUALIFICATION_PYTHON_ENV} does not exist: ${python}`).toBe(
      true
    );

    const repoRoot = path.resolve(__dirname, "..", "..");
    const vaultId = `qual-w2-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-w2-recovery-"));
    const ledgerDbPath = path.join(tempDir, "qualification-recovery.db");
    const pythonEnv = qualificationPythonEnv({
      repoRoot,
      workingDirectory: tempDir,
      ledgerDbPath,
      passphrase: SYNTHETIC_PASSPHRASE,
    });

    try {
      // ---------------------------------------------------------------------
      // 1. First browser: real WebCrypto push through the vault HTTP routes.
      // ---------------------------------------------------------------------
      await test.step("first browser encrypts and pushes the synthetic ledger", async () => {
        await page.clock.install({ time: AS_OF_INSTANT });
        await page.addInitScript(
          ({ key, ledger }) => {
            if (localStorage.getItem(key) === null) {
              localStorage.setItem(key, JSON.stringify(ledger));
            }
          },
          { key: LEDGER_STORAGE_KEY, ledger: syntheticHousehold() }
        );
        await page.goto("/");

        await expect(moneyNow(page)).toHaveText("$1,200.00");
        await expect(page.getByText("Calculation Failed")).toHaveCount(0);
        // The paycheck is scheduled, not recorded: it must not change money now,
        // but it does enter the exact plan. Feb rent is already paid; three $500
        // car slots, two $600 rent slots and three $1,000 receipts remain.
        // The Apr 5 rent lands before the Apr 8 receipt, so the low is 100,000.
        await expect(exactLow(page)).toHaveText("$1,000.00");
        await expect(
          page.getByText(/On Apr 5, 2028, inside the 90-day plan\./)
        ).toBeVisible();
        await expect(
          page.getByText(/Scheduled income in that window is \$3,000\.00\./)
        ).toBeVisible();

        // Preferences really exist on the original browser and must not migrate.
        await page.getByRole("button", { name: "Use dark theme" }).click();
        expect(await readStorage(page, THEME_STORAGE_KEY)).toBe("dark");
        await page.getByRole("button", { name: "Advanced", exact: true }).click();
        const reserve = page.getByLabel("Reserve to subtract from the chosen low point ($)");
        await reserve.fill("525");
        await page.getByRole("button", { name: "Update results" }).click();
        // The settings lock resolves asynchronously. Canonical form values
        // appear only after the exact saved bytes have been verified.
        await expect(reserve).toHaveValue("525.00");
        const settingsRaw = await readStorage(page, ASSUMPTIONS_STORAGE_KEY);
        expect(JSON.parse(settingsRaw ?? "null")).toMatchObject({
          schemaVersion: 1,
          values: { reserveCents: 52_500 },
        });
        await page.getByRole("button", { name: "Budget", exact: true }).click();
        await page.getByLabel("Monthly spending target ($)").fill("200");
        await page.getByRole("button", { name: "Save target" }).click();
        expect(await readStorage(page, BUDGET_STORAGE_KEY)).not.toBeNull();

        await openSync(page);
        await fillVaultForm(page, vaultId, SYNTHETIC_PASSPHRASE);
        await page.getByRole("button", { name: "Push (Upload)" }).click();
        await expect(
          page.getByText(/Successfully pushed encrypted snapshot to Cloud Vault \(rev 1\)!/)
        ).toBeVisible();

        expect(await readStorage(page, VAULT_ID_STORAGE_KEY)).toBe(vaultId);
        const syncRaw = await readStorage(page, SYNC_STORAGE_KEY);
        expect(syncRaw).not.toBeNull();
        const syncMap = JSON.parse(syncRaw as string);
        expect(syncMap[vaultId]).toMatchObject({
          baseRevision: 1,
          snapshotVersion: "2.2",
        });

        // The passphrase is client-side only; no browser storage key may hold it.
        const storageDump = await page.evaluate(() =>
          Object.keys(localStorage)
            .map((key) => `${key}=${localStorage.getItem(key)}`)
            .join("\n")
        );
        expect(storageDump).not.toContain(SYNTHETIC_PASSPHRASE);
        await closeSync(page);
      });

      // ---------------------------------------------------------------------
      // 2. Real Python sync functions/CLI into a fresh temporary SQLite file.
      // ---------------------------------------------------------------------
      let pythonNewId = 0;
      let pushedSnapshot: any;
      await test.step("Python joins, pulls, edits the real ledger, and pushes revision 2", async () => {
        runQualificationPython(
          python,
          ["-c", "from monte_carlo_ledger import db_manager; db_manager.init_db()"],
          { cwd: tempDir, env: pythonEnv }
        );

        const joined = runQualificationPython(
          python,
          [
            "-m",
            "monte_carlo_ledger",
            "sync",
            "init",
            vaultId,
            "--server",
            serverUrl,
          ],
          { cwd: tempDir, env: pythonEnv }
        );
        expect(joined.stdout).toContain(`Vault initialized: ${vaultId} (rev 1)`);

        const pulled = runQualificationPython(
          python,
          ["-m", "monte_carlo_ledger", "sync", "pull"],
          { cwd: tempDir, env: pythonEnv }
        );
        // Fresh local ledger was empty, so the Web snapshot replaced nothing.
        expect(pulled.stdout).toContain("restored 2 transactions");
        expect(pulled.stdout).toContain("$1,200.00");

        const afterPull = runQualificationPython(
          python,
          ["-m", "monte_carlo_ledger", "export-snapshot", "--json"],
          { cwd: tempDir, env: pythonEnv }
        );
        const pulledSnapshot = JSON.parse(afterPull.stdout);
        expectCanonicalSnapshotEqual(
          pulledSnapshot,
          expectedBasePythonSnapshot(),
          "Python pull must preserve every supported Web field and its documented defaults"
        );
        expect(typeof pulledSnapshot.updated_at).toBe("string");
        expect(Number.isNaN(Date.parse(pulledSnapshot.updated_at))).toBe(false);
        // Reference identity is the reason this is not a row-count comparison.
        expect(pulledSnapshot.incomes[0]).toMatchObject({
          id: INCOME_ID,
          amount_cents: INCOME_AMOUNT_CENTS,
          frequency: "Monthly",
          last_payday: INCOME_LAST_PAYDAY,
          next_payday: INCOME_NEXT_PAYDAY,
        });
        const movedRent = pulledSnapshot.bill_occurrences.find(
          (row: any) => row.id === "occ-rent-feb"
        );
        expect(movedRent).toMatchObject({
          payment_id: "payment-rent",
          due_date: "2028-02-07",
          original_due_date: "2028-02-05",
          paid: true,
          transaction_id: "tx-rent-paid",
          is_user_modified: true,
        });
        expect(pulledSnapshot.liabilities.find((row: any) => row.id === "debt-car")).toMatchObject({
          linked_payment_id: "payment-car",
          due_day_of_month: 15,
        });

        // The sync config is non-secret and points only at the loopback server.
        const syncConfig = JSON.parse(
          fs.readFileSync(path.join(tempDir, ".ledger-sync.json"), "utf8")
        );
        expect(syncConfig.server_url).toBe(serverUrl);
        expect(syncConfig.vault_id).toBe(vaultId);
        expect(JSON.stringify(syncConfig)).not.toContain(SYNTHETIC_PASSPHRASE);

        // Real Python ledger write with a documented effect:
        // 120,000 opening cash - 2,500 expense = 117,500.
        const editScript = [
          "from monte_carlo_ledger import db_manager",
          `new_id = db_manager.add_transaction(${EDIT_AMOUNT_CENTS}, "Qualification", ${JSON.stringify(
            EDIT_DESCRIPTION
          )}, t_type="Expense", date_str="${AS_OF}")`,
          "print(new_id)",
        ].join("\n");
        const edited = runQualificationPython(python, ["-c", editScript], {
          cwd: tempDir,
          env: pythonEnv,
        });
        pythonNewId = Number(edited.stdout.trim());
        expect(Number.isInteger(pythonNewId)).toBe(true);
        expect(pythonNewId).toBeGreaterThan(0);

        const afterEdit = runQualificationPython(
          python,
          ["-m", "monte_carlo_ledger", "export-snapshot", "--json"],
          { cwd: tempDir, env: pythonEnv }
        );
        const editedSnapshot = JSON.parse(afterEdit.stdout);
        expectCanonicalSnapshotEqual(
          editedSnapshot,
          expectedEditedPythonSnapshot(pythonNewId),
          "The Python edit must add exactly one transaction with the expected fields"
        );
        const editedRows = editedSnapshot.transactions.filter(
          (row: any) => row.description === EDIT_DESCRIPTION
        );
        expect(editedRows).toHaveLength(1);

        const pushed = runQualificationPython(
          python,
          ["-m", "monte_carlo_ledger", "sync", "push"],
          { cwd: tempDir, env: pythonEnv }
        );
        expect(pushed.stdout).toContain("Pushed to vault: rev 2");

        const afterPush = runQualificationPython(
          python,
          ["-m", "monte_carlo_ledger", "export-snapshot", "--json"],
          { cwd: tempDir, env: pythonEnv }
        );
        pushedSnapshot = JSON.parse(afterPush.stdout);
        expectCanonicalSnapshotEqual(
          pushedSnapshot,
          expectedEditedPythonSnapshot(pythonNewId),
          "The pushed revision must contain the same canonical data as the local Python ledger"
        );
      });

      // ---------------------------------------------------------------------
      // 3. Stale origin client: its ancestry is still revision 1 after Python
      //    pushed revision 2. A push must be refused with a conflict, not
      //    overwrite the other client's update.
      // ---------------------------------------------------------------------
      await test.step("stale first browser cannot overwrite Python revision 2", async () => {
        const beforeLedger = await readStorage(page, LEDGER_STORAGE_KEY);
        const beforeSync = await readStorage(page, SYNC_STORAGE_KEY);
        expect(JSON.parse(beforeSync as string)[vaultId]).toMatchObject({
          baseRevision: 1,
        });

        await openSync(page);
        await fillVaultForm(page, vaultId, SYNTHETIC_PASSPHRASE);
        await page.getByRole("button", { name: "Push (Upload)" }).click();
        await expect(
          page.getByText(
            "This vault changed on another device since your last sync. Pull the latest revision before pushing; your local ledger has not been overwritten."
          )
        ).toBeVisible();
        await expect(
          page.getByText(/Successfully pushed encrypted snapshot to Cloud Vault/)
        ).toHaveCount(0);

        // The conflict is local to the attempt: the stale client keeps its own
        // ledger, selected vault and ancestry, and never overwrites revision 2.
        expect(await readStorage(page, LEDGER_STORAGE_KEY)).toBe(beforeLedger);
        expect(await readStorage(page, VAULT_ID_STORAGE_KEY)).toBe(vaultId);
        expect(await readStorage(page, SYNC_STORAGE_KEY)).toBe(beforeSync);
        await closeSync(page);
      });

      // ---------------------------------------------------------------------
      // 4. Second, clean browser: decrypt, confirm replacement, restore.
      // ---------------------------------------------------------------------
      const secondContext = await browser.newContext({
        baseURL: serverUrl,
        timezoneId: "UTC",
        locale: "en-US",
        colorScheme: "light",
      });
      const secondPage = await secondContext.newPage();
      secondPage.setDefaultTimeout(10_000);
      try {
        await secondPage.clock.install({ time: AS_OF_INSTANT });
        await secondPage.goto("/");
        await expect(secondPage.getByText(/Demo data — not your finances/)).toBeVisible();

        await test.step("fresh browser restores the Python revision exactly once", async () => {
          await openSync(secondPage);
          await fillVaultForm(secondPage, vaultId, SYNTHETIC_PASSPHRASE);

          // This clean client has local demo edits the vault has never seen. A pull
          // must ask before replacing them, and must not touch the local ledger yet.
          await secondPage.getByRole("button", { name: "Pull (Download)" }).click();
          await expect(
            secondPage.getByText(/This device has ledger edits that were never synchronized/)
          ).toBeVisible();
          // The demo ledger is in memory only; a pull that asks for confirmation
          // must not have written a replacement ledger or vault identity yet.
          expect(await readStorage(secondPage, LEDGER_STORAGE_KEY)).toBeNull();
          expect(await readStorage(secondPage, VAULT_ID_STORAGE_KEY)).toBeNull();

          await secondPage
            .getByRole("button", { name: "Replace local ledger with the vault" })
            .click();
          await expect(
            secondPage.getByText(
              /Successfully pulled, decrypted and saved vault \(rev 2\)!/
            )
          ).toBeVisible();
          await closeSync(secondPage);

          await expect(moneyNow(secondPage)).toHaveText("$1,175.00");
          await expect(secondPage.getByText("Calculation Failed")).toHaveCount(0);

          const restored = await readLedger(secondPage);
          expectCanonicalSnapshotEqual(
            restored,
            expectedEditedPythonSnapshot(pythonNewId),
            "Python→fresh Web restore must preserve every supported field and stable reference"
          );
          expectCanonicalSnapshotEqual(
            restored,
            pushedSnapshot,
            "The fresh Web snapshot must match the Python revision's supported fields"
          );
          expect(typeof restored.updated_at).toBe("string");
          expect(Number.isNaN(Date.parse(restored.updated_at))).toBe(false);

          // The Python edit appears once, with its own stable id and full fields.
          const editRows = restored.transactions.filter(
            (row: any) => row.description === EDIT_DESCRIPTION
          );
          expect(editRows).toHaveLength(1);
          expect(editRows[0]).toMatchObject({
            id: pythonNewId,
            amount_cents: EDIT_AMOUNT_CENTS,
            type: "Expense",
            date: AS_OF,
            category: "Qualification",
            description: EDIT_DESCRIPTION,
          });

          // Stable links: the moved/paid occurrence points at the restored payment
          // and transaction ids, and the car debt points at the restored car bill.
          const restoredPaymentIds = new Set(
            restored.payments.map((row: any) => String(row.id))
          );
          const restoredTransactionIds = new Set(
            restored.transactions.map((row: any) => String(row.id))
          );
          const restoredMovedRent = restored.bill_occurrences.find(
            (row: any) => row.id === "occ-rent-feb"
          );
          expect(restoredMovedRent).toMatchObject({
            payment_id: "payment-rent",
            due_date: "2028-02-07",
            original_due_date: "2028-02-05",
            paid: true,
            transaction_id: "tx-rent-paid",
            is_user_modified: true,
          });
          expect(restoredPaymentIds.has(String(restoredMovedRent.payment_id))).toBe(true);
          expect(restoredTransactionIds.has(String(restoredMovedRent.transaction_id))).toBe(true);
          const restoredCarDebt = restored.liabilities.find(
            (row: any) => row.id === "debt-car"
          );
          expect(restoredCarDebt).toMatchObject({
            linked_payment_id: "payment-car",
            due_day_of_month: 15,
            min_payment_cents: 50_000,
          });
          expect(restoredPaymentIds.has(String(restoredCarDebt.linked_payment_id))).toBe(true);

          // Shared records and portable financial settings came back; the theme
          // preference stayed local to the first browser.
          expect(await readStorage(secondPage, THEME_STORAGE_KEY)).toBeNull();
          expect(JSON.parse((await readStorage(secondPage, ASSUMPTIONS_STORAGE_KEY)) ?? "null")).toMatchObject({
            schemaVersion: 1,
            values: { reserveCents: 52_500 },
          });
          expect(JSON.parse((await readStorage(secondPage, BUDGET_STORAGE_KEY)) ?? "null")).toMatchObject({
            monthlyLimitCents: 20_000,
          });
          await expect(
            secondPage.getByRole("button", { name: "Use dark theme" })
          ).toBeVisible();
          expect(await readStorage(secondPage, VAULT_ID_STORAGE_KEY)).toBe(vaultId);
          const syncRaw = await readStorage(secondPage, SYNC_STORAGE_KEY);
          expect(JSON.parse(syncRaw as string)[vaultId]).toMatchObject({
            baseRevision: 2,
          });

          // The one posted $25 expense lowers the exact low from $1,000.00 to
          // $975.00. The first profile's reserve is local, so its modeled
          // spending result may differ, but this deterministic low must not.
          await expect(exactLow(secondPage)).toHaveText("$975.00");
          await expect(
            secondPage.getByText(/On Apr 5, 2028, inside the 90-day plan\./)
          ).toBeVisible();
        });

        await test.step("reload and repeat pull do not duplicate records", async () => {
          await secondPage.reload();
          await expect(moneyNow(secondPage)).toHaveText("$1,175.00");
          const beforeReload = await readLedger(secondPage);
          expect(beforeReload.transactions).toHaveLength(3);
          expect(beforeReload.incomes).toHaveLength(1);
          expect(beforeReload.bill_occurrences).toHaveLength(1);

          await openSync(secondPage);
          await fillVaultForm(secondPage, vaultId, SYNTHETIC_PASSPHRASE);
          await secondPage.getByRole("button", { name: "Pull (Download)" }).click();
          await expect(
            secondPage.getByText(
              /Successfully pulled, decrypted and saved vault \(rev 2\)!/
            )
          ).toBeVisible();
          await closeSync(secondPage);

          const repeated = await readLedger(secondPage);
          expectCanonicalSnapshotEqual(
            repeated,
            expectedEditedPythonSnapshot(pythonNewId),
            "A repeat pull must not duplicate or mutate any supported snapshot field"
          );
          expect(sortedIds(repeated.transactions)).toEqual(
            sortedIds(beforeReload.transactions)
          );
          expect(repeated.transactions).toHaveLength(3);
          expect(repeated.incomes).toEqual(beforeReload.incomes);
          expect(repeated.bill_occurrences).toEqual(beforeReload.bill_occurrences);
          expect(repeated.payments).toHaveLength(2);
          expect(repeated.liabilities).toHaveLength(2);
          expect(
            repeated.transactions.filter(
              (row: any) => row.description === EDIT_DESCRIPTION
            )
          ).toHaveLength(1);
        });

        await test.step("authenticated restore with a failed persistence write keeps the good ledger", async () => {
          // The prior local state must differ from the remote state, otherwise the
          // before/after bytes would not prove that the ledger write rolled back.
          await secondPage.getByRole("button", { name: "Money", exact: true }).click();
          await secondPage.getByLabel("Amount ($)", { exact: true }).fill("5");
          await secondPage.getByLabel("Note", { exact: true }).fill("Synthetic local edit before failed restore");
          await secondPage.getByRole("button", { name: "Record this", exact: true }).click();
          await expect(secondPage.getByText("Synthetic local edit before failed restore")).toBeVisible();
          await secondPage.getByRole("button", { name: "Home", exact: true }).click();
          await expect(moneyNow(secondPage)).toHaveText("$1,170.00");
          await expect(exactLow(secondPage)).toHaveText("$970.00");
          const goodLedger = await readStorage(secondPage, LEDGER_STORAGE_KEY);
          const goodVaultId = await readStorage(secondPage, VAULT_ID_STORAGE_KEY);
          const goodSync = await readStorage(secondPage, SYNC_STORAGE_KEY);
          expect(goodLedger).not.toBeNull();
          expect(goodVaultId).toBe(vaultId);
          expect(JSON.parse(goodSync as string)[vaultId]).toMatchObject({
            baseRevision: 2,
          });

          await openSync(secondPage);
          await fillVaultForm(secondPage, vaultId, SYNTHETIC_PASSPHRASE);
          await secondPage.getByRole("button", { name: "Pull (Download)" }).click();
          const replace = secondPage.getByRole("button", { name: "Replace local ledger with the vault" });
          await expect(replace).toBeVisible();
          // Authenticate, download, decrypt and validate normally; fail only the
          // one durable sync-ancestry write so the bundle must roll back.
          await failNextSyncStorageWrite(secondPage);
          await replace.click();

          const failureAlert = secondPage
            .getByRole("alert")
            .filter({ hasText: "Vault decrypted but the restore was not persisted" });
          await expect(failureAlert).toBeVisible();
          await expect(failureAlert).toContainText("previous saved data is intact");
          await expect(
            secondPage.getByText(/Successfully pulled, decrypted and saved vault/)
          ).toHaveCount(0);
          expect(
            await secondPage.evaluate(
              () => (window as any).__mcQualificationWriteFailure
            )
          ).toBe(true);

          // The prior ledger, vault identity and revision ancestry are byte-for-byte
          // unchanged after the failed bundle commit.
          expect(await readStorage(secondPage, LEDGER_STORAGE_KEY)).toBe(goodLedger);
          expect(await readStorage(secondPage, VAULT_ID_STORAGE_KEY)).toBe(goodVaultId);
          expect(await readStorage(secondPage, SYNC_STORAGE_KEY)).toBe(goodSync);
          await closeSync(secondPage);

          // A reload still shows the good ledger, not a partially applied restore.
          await secondPage.reload();
          await expect(moneyNow(secondPage)).toHaveText("$1,170.00");
          await expect(exactLow(secondPage)).toHaveText("$970.00");
          expect(await readStorage(secondPage, LEDGER_STORAGE_KEY)).toBe(goodLedger);
          expect(await readStorage(secondPage, VAULT_ID_STORAGE_KEY)).toBe(goodVaultId);
          expect(await readStorage(secondPage, SYNC_STORAGE_KEY)).toBe(goodSync);

          // The one-shot failure did not disable durable storage: ancestry is intact
          // and a later authenticated pull still succeeds at revision 2.
          await openSync(secondPage);
          await fillVaultForm(secondPage, vaultId, SYNTHETIC_PASSPHRASE);
          await secondPage.getByRole("button", { name: "Pull (Download)" }).click();
          await replace.click();
          await expect(
            secondPage.getByText(
              /Successfully pulled, decrypted and saved vault \(rev 2\)!/
            )
          ).toBeVisible();
          await closeSync(secondPage);
          await expect(moneyNow(secondPage)).toHaveText("$1,175.00");
          await expect(exactLow(secondPage)).toHaveText("$975.00");
          expectCanonicalSnapshotEqual(
            await readLedger(secondPage),
            expectedEditedPythonSnapshot(pythonNewId),
            "An explicitly confirmed retry restores the full revision 2 snapshot"
          );
          expect(await readStorage(secondPage, LEDGER_STORAGE_KEY)).not.toBe(goodLedger);
          expect(
            JSON.parse((await readStorage(secondPage, SYNC_STORAGE_KEY)) as string)[vaultId]
          ).toMatchObject({ baseRevision: 2 });
        });

        await test.step("wrong synthetic passphrase leaves the good ledger intact", async () => {
          const goodLedger = await readStorage(secondPage, LEDGER_STORAGE_KEY);
          const goodSync = await readStorage(secondPage, SYNC_STORAGE_KEY);

          await openSync(secondPage);
          await fillVaultForm(secondPage, vaultId, SYNTHETIC_WRONG_PASSPHRASE);
          await secondPage.getByRole("button", { name: "Pull (Download)" }).click();
          await expect(secondPage.getByText("Wrong passphrase for this vault.")).toBeVisible();

          expect(await readStorage(secondPage, LEDGER_STORAGE_KEY)).toBe(goodLedger);
          expect(await readStorage(secondPage, SYNC_STORAGE_KEY)).toBe(goodSync);
          await closeSync(secondPage);
          await secondPage.reload();
          await expect(moneyNow(secondPage)).toHaveText("$1,175.00");
          expect((await readLedger(secondPage)).transactions).toHaveLength(3);
        });
      } finally {
        await secondContext.close();
      }

      // ---------------------------------------------------------------------
      // 5. Python-side repeat and failure nonreplacement.
      // ---------------------------------------------------------------------
      await test.step("Python repeat pull keeps ids, and a failed Python pull keeps the ledger", async () => {
        const repeated = runQualificationPython(
          python,
          ["-m", "monte_carlo_ledger", "sync", "pull"],
          { cwd: tempDir, env: pythonEnv }
        );
        expect(repeated.stdout).toContain("restored 3 transactions");
        expect(repeated.stdout).toContain("$1,175.00");

        const afterRepeat = JSON.parse(
          runQualificationPython(
            python,
            ["-m", "monte_carlo_ledger", "export-snapshot", "--json"],
            { cwd: tempDir, env: pythonEnv }
          ).stdout
        );
        expectCanonicalSnapshotEqual(
          afterRepeat,
          expectedEditedPythonSnapshot(pythonNewId),
          "A repeat Python pull must preserve every supported field, not just row counts"
        );
        expect(sortedIds(afterRepeat.transactions)).toEqual(
          sortedIds(pushedSnapshot.transactions)
        );
        expect(afterRepeat.incomes).toEqual(pushedSnapshot.incomes);
        expect(afterRepeat.bill_occurrences).toEqual(pushedSnapshot.bill_occurrences);
        expect(afterRepeat.transactions).toHaveLength(3);

        const wrongEnv = qualificationPythonEnv({
          repoRoot,
          workingDirectory: tempDir,
          ledgerDbPath,
          passphrase: SYNTHETIC_WRONG_PASSPHRASE,
        });
        const failed = runQualificationPython(
          python,
          ["-m", "monte_carlo_ledger", "sync", "pull"],
          { cwd: tempDir, env: wrongEnv, allowFailure: true }
        );
        expect(failed.status).not.toBe(0);
        expect(failed.stderr).toContain("Authentication failed");

        const afterFailure = JSON.parse(
          runQualificationPython(
            python,
            ["-m", "monte_carlo_ledger", "export-snapshot", "--json"],
            { cwd: tempDir, env: pythonEnv }
          ).stdout
        );
        expectCanonicalSnapshotEqual(
          afterFailure,
          expectedEditedPythonSnapshot(pythonNewId),
          "A failed Python pull must leave the prior local ledger unchanged"
        );
        expect(sortedIds(afterFailure.transactions)).toEqual(
          sortedIds(pushedSnapshot.transactions)
        );
        expect(afterFailure.bill_occurrences).toEqual(pushedSnapshot.bill_occurrences);
        expect(afterFailure.liabilities).toEqual(pushedSnapshot.liabilities);
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
