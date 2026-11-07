import { LedgerState } from "./types";
import {
  PersistenceResult,
  SYNC_STORAGE_KEY,
  VAULT_ID_STORAGE_KEY,
  commitSynchronizedState,
  defaultSyncStorage,
  SyncStorage,
} from "./sync-state";

export const LEDGER_STORAGE_KEY = "montecarlo_ledger_state_v2";

function restore(storage: SyncStorage, key: string, value: string | null): void {
  try {
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    // Rollback is best-effort; the caller still reports that the bundle was not saved.
  }
}

/**
 * Persist a ledger replacement as one recoverable bundle.
 *
 * The ledger, vault id and synchronization ancestry are written in order. If any
 * write fails (quota, blocked storage), every key touched is restored to its prior
 * value so the stored ledger and the UI cannot claim a durable state that was not
 * actually written. Ancestry is only committed with a durable ledger.
 */
export function applyLedgerBundle(
  state: LedgerState,
  vaultId?: string,
  syncRevision?: number,
  storage: SyncStorage | null = defaultSyncStorage(),
  ledgerKey: string = LEDGER_STORAGE_KEY
): PersistenceResult {
  if (!storage) {
    return {
      ok: false,
      error: "Local storage is unavailable; the ledger was not saved.",
    };
  }
  const previous = {
    ledger: storage.getItem(ledgerKey),
    vault: storage.getItem(VAULT_ID_STORAGE_KEY),
    sync: storage.getItem(SYNC_STORAGE_KEY),
  };
  try {
    storage.setItem(ledgerKey, JSON.stringify(state));
    if (vaultId) {
      storage.setItem(VAULT_ID_STORAGE_KEY, vaultId);
      if (syncRevision !== undefined) {
        if (!commitSynchronizedState(vaultId, syncRevision, state, storage)) {
          throw new Error("synchronization ancestry could not be stored");
        }
      }
    }
    return { ok: true };
  } catch (err: any) {
    restore(storage, ledgerKey, previous.ledger);
    restore(storage, VAULT_ID_STORAGE_KEY, previous.vault);
    restore(storage, SYNC_STORAGE_KEY, previous.sync);
    return {
      ok: false,
      error: `The ledger was not saved (${
        err?.message ?? "storage failure"
      }); the previous ledger is still intact.`,
    };
  }
}
