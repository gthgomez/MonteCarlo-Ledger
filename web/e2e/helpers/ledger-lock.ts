import type { Page } from "@playwright/test";
import { LEDGER_LOCK_NAME, LEDGER_STORAGE_KEY } from "../../src/lib/persistence";

interface LedgerLockHarness {
  releaseTestLedgerLock?: () => void;
}

export async function holdLedgerLock(page: Page): Promise<void> {
  await page.evaluate(
    (name) =>
      new Promise<void>((acquired) => {
        const harness = window as Window & LedgerLockHarness;
        const hold = new Promise<void>((release) => {
          harness.releaseTestLedgerLock = release;
        });
        void navigator.locks.request(name, () => {
          acquired();
          return hold;
        });
      }),
    LEDGER_LOCK_NAME
  );
}

export async function releaseLedgerLock(page: Page): Promise<void> {
  await page.evaluate(() => {
    const harness = window as Window & LedgerLockHarness;
    const release = harness.releaseTestLedgerLock;
    delete harness.releaseTestLedgerLock;
    release?.();
  });
}

export function queuedWrites(page: Page): Promise<number> {
  return page.evaluate(
    async (name) => (await navigator.locks.query()).pending?.filter((lock) => lock.name === name).length ?? 0,
    LEDGER_LOCK_NAME
  );
}

/** Fail one write in this synthetic browser context; verification and retry use real storage. */
export async function failNextLedgerWrite(page: Page): Promise<void> {
  await page.evaluate((ledgerKey) => {
    const original = Storage.prototype.setItem;
    const local = window.localStorage;
    Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
      if (this === local && key === ledgerKey) {
        Storage.prototype.setItem = original;
        throw new DOMException("Synthetic ledger write failure", "QuotaExceededError");
      }
      original.call(this, key, value);
    };
  }, LEDGER_STORAGE_KEY);
}
