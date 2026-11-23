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

/**
 * Synthetic household based on testdata/household/vault-payment-identity.json.
 * It adds a paid occurrence whose due date moved from its original slot, so the
 * round trip must preserve payment/transaction/occurrence linkage, not just row
 * counts.
 *
 * Hand-derived values:
 *   opening (Adjustment, 2028-01-31)        +180,000
 *   February rent (Expense, 2028-02-01)      -60,000
 *   opening cash                            120,000
 *   Python edit (Expense, 2028-02-01)         -2,500
 *   restored opening cash                   117,500
 */
function syntheticHousehold() {
  return {
    version: "2.2",
    current_balance_cents: 120_000,
    incomes: [],
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

test.describe("W2 Web → Python → fresh Web recovery", () => {
  test.use({ timezoneId: "UTC", locale: "en-US", colorScheme: "light" });

  test("real browser push, Python edit/push, fresh browser restore, repeat, and failed-restore nonreplacement", async ({
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
    test.setTimeout(90_000);
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
        // Feb rent is already paid; three $500 car slots and two $600 rent slots
        // remain before May 1, so the last low is $1,200 - $2,700.
        await expect(exactLow(page)).toHaveText("-$1,500.00");
        await expect(page.getByRole("heading", { name: "Modeled cash shortfall" })).toBeVisible();

        // Preferences really exist on the original browser and must not migrate.
        await page.getByRole("button", { name: "Use dark theme" }).click();
        expect(await readStorage(page, THEME_STORAGE_KEY)).toBe("dark");
        await page.getByRole("button", { name: "Advanced", exact: true }).click();
        await page.getByLabel("Reserve to subtract from the chosen low point ($)").fill("525");
        await page.getByRole("button", { name: "Update results" }).click();
        expect(await readStorage(page, ASSUMPTIONS_STORAGE_KEY)).not.toBeNull();
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
        expect(pulledSnapshot.version).toBe("2.2");
        expect(pulledSnapshot.current_balance_cents).toBe(120_000);
        expect(sortedIds(pulledSnapshot.transactions)).toEqual(["opening", "tx-rent-paid"]);
        expect(sortedIds(pulledSnapshot.payments)).toEqual(["payment-car", "payment-rent"]);
        expect(sortedIds(pulledSnapshot.liabilities)).toEqual(["10", "debt-car"]);
        expect(pulledSnapshot.bill_occurrences).toEqual([
          {
            id: "occ-rent-feb",
            payment_id: "payment-rent",
            due_date: "2028-02-07",
            paid: true,
            transaction_id: "tx-rent-paid",
            original_due_date: "2028-02-05",
            is_user_modified: true,
          },
        ]);
        const carDebt = pulledSnapshot.liabilities.find(
          (row: any) => row.id === "debt-car"
        );
        expect(carDebt).toMatchObject({
          balance_cents: 300_000,
          min_payment_cents: 50_000,
          due_day_of_month: 15,
          linked_payment_id: "payment-car",
        });
        const archived = pulledSnapshot.liabilities.find((row: any) => row.id === "10");
        expect(archived).toMatchObject({ is_active: false });

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
        expect(editedSnapshot.current_balance_cents).toBe(117_500);
        const editedRows = editedSnapshot.transactions.filter(
          (row: any) => row.description === EDIT_DESCRIPTION
        );
        expect(editedRows).toHaveLength(1);
        expect(editedRows[0]).toMatchObject({
          id: pythonNewId,
          amount_cents: EDIT_AMOUNT_CENTS,
          type: "Expense",
          date: AS_OF,
          category: "Qualification",
        });
        expect(sortedIds(editedSnapshot.transactions)).toEqual(
          [String(pythonNewId), "opening", "tx-rent-paid"].sort()
        );

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
        expect(pushedSnapshot.current_balance_cents).toBe(117_500);
      });

      // ---------------------------------------------------------------------
      // 3. Second, clean browser: decrypt, confirm replacement, restore.
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
          expect(restored.version).toBe("2.2");
          expect(restored.current_balance_cents).toBe(117_500);
          expect(sortedIds(restored.transactions)).toEqual(
            [String(pythonNewId), "opening", "tx-rent-paid"].sort()
          );
          expect(sortedIds(restored.payments)).toEqual(["payment-car", "payment-rent"]);
          expect(sortedIds(restored.liabilities)).toEqual(["10", "debt-car"]);

          const editRows = restored.transactions.filter(
            (row: any) => row.description === EDIT_DESCRIPTION
          );
          expect(editRows).toHaveLength(1);
          expect(editRows[0]).toMatchObject({
            id: pythonNewId,
            amount_cents: EDIT_AMOUNT_CENTS,
            type: "Expense",
            date: AS_OF,
          });

          expect(restored.bill_occurrences).toEqual([
            {
              id: "occ-rent-feb",
              payment_id: "payment-rent",
              due_date: "2028-02-07",
              paid: true,
              transaction_id: "tx-rent-paid",
              original_due_date: "2028-02-05",
              is_user_modified: true,
            },
          ]);
          const restoredCarDebt = restored.liabilities.find(
            (row: any) => row.id === "debt-car"
          );
          expect(restoredCarDebt.linked_payment_id).toBe("payment-car");
          expect(restored.liabilities.find((row: any) => row.id === "10").is_active).toBe(
            false
          );

          // Shared snapshot data came back; browser-local preferences did not.
          expect(await readStorage(secondPage, THEME_STORAGE_KEY)).toBeNull();
          expect(await readStorage(secondPage, ASSUMPTIONS_STORAGE_KEY)).toBeNull();
          expect(await readStorage(secondPage, BUDGET_STORAGE_KEY)).toBeNull();
          await expect(
            secondPage.getByRole("button", { name: "Use dark theme" })
          ).toBeVisible();
          expect(await readStorage(secondPage, VAULT_ID_STORAGE_KEY)).toBe(vaultId);
          const syncRaw = await readStorage(secondPage, SYNC_STORAGE_KEY);
          expect(JSON.parse(syncRaw as string)[vaultId]).toMatchObject({
            baseRevision: 2,
          });

          // The one posted $25 expense lowers the exact low by $25. The first
          // profile's reserve is local, so its modeled spending result may differ.
          await expect(exactLow(secondPage)).toHaveText("-$1,525.00");
        });

        await test.step("reload and repeat pull do not duplicate records", async () => {
          await secondPage.reload();
          await expect(moneyNow(secondPage)).toHaveText("$1,175.00");
          const beforeReload = await readLedger(secondPage);
          expect(beforeReload.transactions).toHaveLength(3);
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
          expect(repeated.current_balance_cents).toBe(117_500);
          expect(sortedIds(repeated.transactions)).toEqual(
            sortedIds(beforeReload.transactions)
          );
          expect(repeated.transactions).toHaveLength(3);
          expect(repeated.bill_occurrences).toEqual(beforeReload.bill_occurrences);
          expect(repeated.payments).toHaveLength(2);
          expect(repeated.liabilities).toHaveLength(2);
          expect(
            repeated.transactions.filter(
              (row: any) => row.description === EDIT_DESCRIPTION
            )
          ).toHaveLength(1);
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
      // 4. Python-side repeat and failure nonreplacement.
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
        expect(afterRepeat.current_balance_cents).toBe(117_500);
        expect(sortedIds(afterRepeat.transactions)).toEqual(
          sortedIds(pushedSnapshot.transactions)
        );
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
        expect(afterFailure.current_balance_cents).toBe(117_500);
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
