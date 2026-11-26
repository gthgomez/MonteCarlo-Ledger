import { LedgerState } from "./types";
import {
  PersistenceResult,
  SYNC_STORAGE_KEY,
  VAULT_ID_STORAGE_KEY,
  commitSynchronizedState,
  defaultSyncStorage,
  readSyncRecord,
  SyncStorage,
} from "./sync-state";
import {
  SETTINGS_REVIEW_STORAGE_KEY,
  clearSettingsReview,
  readSettingsReview,
  writeSettingsReview,
  type SettingsReviewGuard,
  type SettingsReviewReason,
  type SettingsReviewResolution,
} from "./settings-review";

export const LEDGER_STORAGE_KEY = "montecarlo_ledger_state_v2";

/**
 * Shared-origin lock name for every ledger write. Ordinary edits, demo resets,
 * imports and vault restores must all use this one name so a restore can never
 * interleave with a writer in another tab.
 */
export const LEDGER_LOCK_NAME = "montecarlo-ledger-write";

/** A vault restore must add a guard; a local replacement must clear one. */
export type SettingsReviewChange =
  | { action: "require"; token: string; reason: SettingsReviewReason }
  | { action: "clear" };

export interface SettingsReviewApplyResult {
  ok: boolean;
  error?: string;
}

export interface SettingsReviewResolutionRequest {
  /** Guard token the user/restore actually reviewed; null for a corrupt record. */
  token: string | null;
  /** Exact raw guard bytes the user reviewed. Required to recover a corrupt record. */
  expectedRaw?: string | null;
  /** Applied under the ledger lock; any failure keeps the guard in place. */
  apply?: () => Promise<SettingsReviewApplyResult>;
}

/** Options for a ledger mutation whose authorization is tied to one durable snapshot. */
export interface LedgerChangeOptions {
  /** Exact raw ledger value the user authorized replacing; null means "no stored ledger". */
  expectedRaw: string | null;
  vaultId?: string;
  syncRevision?: number;
  signal?: AbortSignal;
  /** Restores/imports must fail closed when the Web Locks API is unavailable. */
  requireLock?: boolean;
  /**
   * Vault restores pass a required guard so the ledger and its review state are
   * one recoverable bundle. Imports/demo resets clear the previous guard.
   */
  settingsReview?: SettingsReviewChange;
}

type LockRequestCallback<T> = (lock: unknown) => T | Promise<T>;

/** Minimal shape used to inject a lock manager in tests without DOM globals. */
export interface LedgerLockManager {
  request<T>(
    name: string,
    options: { mode?: "exclusive" | "shared"; signal?: AbortSignal },
    callback: LockRequestCallback<T>
  ): Promise<T>;
}

interface NativeLockManager {
  request(
    name: string,
    options: { mode?: "exclusive" | "shared"; signal?: AbortSignal },
    callback: (lock: unknown) => unknown
  ): Promise<unknown>;
}

function restore(storage: SyncStorage, key: string, value: string | null): boolean {
  try {
    if (storage.getItem(key) === value) return true;
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
    return storage.getItem(key) === value;
  } catch {
    return false;
  }
}

/**
 * Persist a ledger replacement as one recoverable bundle.
 *
 * The ledger, vault id and synchronization ancestry are written in order. If any
 * write fails (quota, blocked storage), restore the previous values before reporting
 * failure. If the rollback cannot be verified, the result is marked indeterminate:
 * some or all of the change may have persisted, so the caller must keep the prior
 * view available until the user retains a copy and checks storage.
 *
 * This function performs no cross-tab check; callers that can replace a ledger
 * should use {@link saveLedgerChange}, which performs the check under a lock.
 */
export function applyLedgerBundle(
  state: LedgerState,
  vaultId?: string,
  syncRevision?: number,
  storage: SyncStorage | null = defaultSyncStorage(),
  ledgerKey: string = LEDGER_STORAGE_KEY,
  settingsReview?: SettingsReviewChange
): PersistenceResult {
  if (!storage) {
    return {
      ok: false,
      error: "Local storage is unavailable; the ledger was not saved.",
    };
  }
  const previous: [string, string | null][] = [];
  let reviewPrevious: string | null = null;
  let reviewChanged = false;
  let reviewGuard: SettingsReviewGuard | null = null;
  try {
    const serialized = JSON.stringify(state);
    // The review guard is part of the same recoverable bundle as the ledger. It
    // is written first so a reload cannot see new records with no review state.
    if (settingsReview) {
      reviewPrevious = storage.getItem(SETTINGS_REVIEW_STORAGE_KEY);
      previous.push([SETTINGS_REVIEW_STORAGE_KEY, reviewPrevious]);
    }
    previous.push([ledgerKey, storage.getItem(ledgerKey)]);
    if (vaultId) {
      previous.push([VAULT_ID_STORAGE_KEY, storage.getItem(VAULT_ID_STORAGE_KEY)]);
      if (syncRevision !== undefined) {
        previous.push([SYNC_STORAGE_KEY, storage.getItem(SYNC_STORAGE_KEY)]);
      }
    }
    if (settingsReview) {
      if (settingsReview.action === "require") {
        reviewChanged = true;
        if (!vaultId || syncRevision === undefined) {
          throw new Error("a vault restore must identify its revision before requiring a review");
        }
        reviewGuard = {
          vaultId,
          ledgerRevision: syncRevision,
          token: settingsReview.token,
          reason: settingsReview.reason,
          recordedAt: new Date().toISOString(),
        };
        if (!writeSettingsReview(storage, reviewGuard)) {
          throw new Error("the financial-settings review could not be stored");
        }
      }
      // A "clear" happens only after the replacement ledger is verified. If this
      // process is interrupted, the old guarded ledger still has its old guard.
    }
    storage.setItem(ledgerKey, serialized);
    if (storage.getItem(ledgerKey) !== serialized) {
      throw new Error("the stored ledger did not match the change");
    }
    if (vaultId) {
      storage.setItem(VAULT_ID_STORAGE_KEY, vaultId);
      if (storage.getItem(VAULT_ID_STORAGE_KEY) !== vaultId) {
        throw new Error("the stored vault ID did not match the change");
      }
      if (syncRevision !== undefined) {
        if (!commitSynchronizedState(vaultId, syncRevision, state, storage)) {
          throw new Error("synchronization ancestry could not be stored");
        }
      }
    }
    if (settingsReview?.action === "clear") {
      reviewChanged = true;
      if (!clearSettingsReview(storage)) {
        throw new Error("the previous financial-settings review could not be cleared");
      }
    }
    return { ok: true };
  } catch (err: unknown) {
    let restored = true;
    // Roll back the review key last, after deciding whether the ledger may still
    // hold the attempted restore.
    for (const [key, value] of previous.reverse()) {
      if (reviewChanged && key === SETTINGS_REVIEW_STORAGE_KEY) continue;
      if (!restore(storage, key, value)) restored = false;
    }
    if (reviewChanged) {
      if (restored) {
        // Every other key is verified back to its previous bytes, so the old
        // review state is safe to restore (including absent).
        if (!restore(storage, SETTINGS_REVIEW_STORAGE_KEY, reviewPrevious)) {
          restored = false;
        }
      } else if (settingsReview?.action === "require" && reviewGuard) {
        // The ledger may still hold the restore. Never fall back to "absent":
        // keep a verified guard so a reload still withholds guidance.
        const current = readSettingsReview(storage);
        if (current.status !== "valid" || current.guard.token !== reviewGuard.token) {
          writeSettingsReview(storage, reviewGuard);
        }
      } else if (settingsReview?.action === "clear") {
        // A local replacement with an unverified rollback stays conservative.
        if (!restore(storage, SETTINGS_REVIEW_STORAGE_KEY, reviewPrevious)) {
          restored = false;
        }
      }
    }
    const detail = err instanceof Error ? err.message : "storage failure";
    if (restored) {
      return {
        ok: false,
        error: `The ledger change failed (${detail}). The previous saved data is intact.`,
      };
    }
    return {
      ok: false,
      error:
        `The ledger change failed (${detail}). The previous saved data could not be verified, ` +
        "and some or all of the change may have persisted.",
      indeterminate: true,
    };
  }
}

/**
 * Resolve the browser's Web Locks manager when available.
 *
 * This is feature detection, not a fallback: callers decide whether the absence
 * of locking is acceptable. Destructive replacements pass `requireLock` and must
 * fail closed; ordinary edits may use the checked read/write fallback below.
 */
export function defaultLedgerLockManager(): LedgerLockManager | null {
  try {
    const locks = (globalThis as { navigator?: { locks?: NativeLockManager } })
      .navigator?.locks;
    if (!locks || typeof locks.request !== "function") return null;
    return {
      request<T>(
        name: string,
        options: { mode?: "exclusive" | "shared"; signal?: AbortSignal },
        callback: LockRequestCallback<T>
      ): Promise<T> {
        return locks.request(name, options, () => callback(undefined)) as Promise<T>;
      },
    };
  } catch {
    // Some embedded/private contexts expose the property but throw when used.
    return null;
  }
}

const CANCELLED = "The ledger change was cancelled; nothing was saved.";
const CHANGED =
  "The stored ledger changed in another tab or after this change began. Nothing was replaced; reload and try again.";
const LOCK_UNAVAILABLE =
  "This browser cannot lock the ledger across tabs, so the replacement was not saved. Reload and try again.";
const LOCK_FAILED =
  "The ledger could not be locked for a safe save. Nothing was changed; reload and try again.";

function cancelledResult(): PersistenceResult {
  return { ok: false, error: CANCELLED };
}

function readDurableRaw(
  storage: SyncStorage,
  ledgerKey: string
): { ok: true; raw: string | null } | { ok: false; error: string } {
  try {
    return { ok: true, raw: storage.getItem(ledgerKey) };
  } catch {
    return {
      ok: false,
      error:
        "Local storage could not be read, so the ledger was not changed. Reload and try again.",
    };
  }
}

/**
 * Compare and write in the same synchronous step. When called inside a Web Lock
 * no other cooperating tab can commit between the comparison and the write.
 */
function saveIfStillCurrent(
  state: LedgerState,
  options: LedgerChangeOptions,
  storage: SyncStorage,
  ledgerKey: string
): PersistenceResult {
  if (options.signal?.aborted) return cancelledResult();

  const durable = readDurableRaw(storage, ledgerKey);
  if (!durable.ok) return { ok: false, error: durable.error };

  // Cancellation and the durable comparison are deliberately synchronous here:
  // nothing can run between reading the raw ledger and replacing it.
  if (options.signal?.aborted) return cancelledResult();
  if (durable.raw !== options.expectedRaw) {
    return { ok: false, error: CHANGED };
  }
  if (options.vaultId && options.syncRevision !== undefined) {
    const latest = readSyncRecord(options.vaultId, storage);
    if (latest && latest.baseRevision > options.syncRevision) {
      return { ok: false, error: "This browser already synchronized a newer vault revision. Nothing was replaced; pull again." };
    }
  }

  return applyLedgerBundle(
    state,
    options.vaultId,
    options.syncRevision,
    storage,
    ledgerKey,
    options.settingsReview
  );
}

/**
 * Save a ledger change without replacing a snapshot the user did not authorize.
 *
 * The exact `expectedRaw` is re-read inside a shared-origin Web Lock immediately
 * before any write, so a pull that started before an edit (or before another tab's
 * edit) fails closed instead of overwriting newer data. A cancelled signal is
 * checked both while queued for the lock and inside the critical section.
 *
 * Restores pass `requireLock: true`: if Web Locks are unavailable the replacement
 * fails rather than using a comparison-only path. Ordinary edits keep the prior
 * checked read/write fallback when the API is unavailable.
 */
export async function saveLedgerChange(
  state: LedgerState,
  options: LedgerChangeOptions,
  storage: SyncStorage | null = defaultSyncStorage(),
  ledgerKey: string = LEDGER_STORAGE_KEY,
  lockManager: LedgerLockManager | null = defaultLedgerLockManager()
): Promise<PersistenceResult> {
  if (options.signal?.aborted) return cancelledResult();
  if (!storage) {
    return {
      ok: false,
      error: "Local storage is unavailable; the ledger was not saved.",
    };
  }

  if (!lockManager) {
    if (options.requireLock) {
      return { ok: false, error: LOCK_UNAVAILABLE };
    }
    return saveIfStillCurrent(state, options, storage, ledgerKey);
  }

  try {
    return await lockManager.request(
      LEDGER_LOCK_NAME,
      { mode: "exclusive", signal: options.signal },
      () => saveIfStillCurrent(state, options, storage, ledgerKey)
    );
  } catch (err: unknown) {
    if (options.signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
      return cancelledResult();
    }
    // Once a lock manager exists, no writer may bypass it on request failure.
    return { ok: false, error: LOCK_FAILED };
  }
}

/**
 * Verify the reviewed guard, apply decision settings, and clear the guard under
 * the same shared ledger lock.
 *
 * A newer restore writes a different token/raw record under this lock. An older
 * settings apply can therefore no longer overwrite newer settings after the newer
 * restore has cleared its guard. The apply callback must not take the ledger lock
 * again (use the existing skipReviewClear path); it may take the settings lock.
 */
export async function resolveSettingsReview(
  request: SettingsReviewResolutionRequest,
  storage: SyncStorage | null = defaultSyncStorage(),
  lockManager: LedgerLockManager | null = defaultLedgerLockManager()
): Promise<SettingsReviewResolution> {
  if (!storage) {
    return {
      ok: false,
      cleared: false,
      applied: false,
      superseded: false,
      current: null,
      error: "Local storage is unavailable; the financial-settings review could not be resolved.",
    };
  }

  const run = async (): Promise<SettingsReviewResolution> => {
    const current = readSettingsReview(storage);

    if (current.status === "absent") {
      // Something newer resolved or replaced the restore. Do not apply the older
      // settings over it, and do not invent a gate that has nothing to clear.
      return { ok: true, cleared: true, applied: false, superseded: true, current: null };
    }

    if (current.status === "valid") {
      const rawMatches = request.expectedRaw === undefined || request.expectedRaw === current.raw;
      if (request.token === null || current.guard.token !== request.token || !rawMatches) {
        return {
          ok: true,
          cleared: false,
          applied: false,
          superseded: true,
          current: current.guard,
        };
      }
    } else {
      // A corrupt record can be recovered only from the exact bytes the person
      // reviewed; a token alone is not enough, and an undefined raw is blind.
      if (
        request.token !== null ||
        request.expectedRaw === undefined ||
        current.raw === null ||
        request.expectedRaw !== current.raw
      ) {
        return { ok: true, cleared: false, applied: false, superseded: true, current: null };
      }
    }

    let applied = false;
    if (request.apply) {
      let result: SettingsReviewApplyResult;
      try {
        result = await request.apply();
      } catch (err: unknown) {
        return {
          ok: false,
          cleared: false,
          applied: false,
          superseded: false,
          current: current.status === "valid" ? current.guard : null,
          error: err instanceof Error ? err.message : "The financial settings could not be applied.",
        };
      }
      if (!result.ok) {
        return {
          ok: false,
          cleared: false,
          applied: false,
          superseded: false,
          current: current.status === "valid" ? current.guard : null,
          error: result.error ?? "The financial settings could not be applied.",
        };
      }
      applied = true;
    }

    if (!clearSettingsReview(storage)) {
      return {
        ok: false,
        cleared: false,
        applied,
        superseded: false,
        current: current.status === "valid" ? current.guard : null,
        error: "The financial-settings review marker could not be cleared.",
      };
    }
    return { ok: true, cleared: true, applied, superseded: false, current: null };
  };

  if (!lockManager) return run();
  try {
    return await lockManager.request(LEDGER_LOCK_NAME, { mode: "exclusive" }, run);
  } catch {
    return {
      ok: false,
      cleared: false,
      applied: false,
      superseded: false,
      current: null,
      error: "The financial-settings review could not be locked for a safe resolve.",
    };
  }
}
