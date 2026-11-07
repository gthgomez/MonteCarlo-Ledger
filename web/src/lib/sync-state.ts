import { LedgerState } from "./types";

/**
 * Local synchronization ancestry.
 *
 * A push must be based on the revision this device actually synchronized with, not
 * on whatever revision the server currently reports. Otherwise a stale client can
 * fetch the latest revision, push its old snapshot as the next revision, and erase
 * changes it never observed.
 *
 * Only non-secret metadata is stored: no passphrase and no financial records.
 */

export const SYNC_STORAGE_KEY = "montecarlo_vault_sync_v1";
export const VAULT_ID_STORAGE_KEY = "montecarlo_vault_id";

export type PersistenceResult = { ok: true } | { ok: false; error: string };

export interface SyncRecord {
  vaultId: string;
  /** Revision this device last synchronized with (the CAS base for pushes). */
  baseRevision: number;
  /** Fingerprint of the local ledger at that synchronized revision. */
  fingerprint: string;
  snapshotVersion: string;
  updatedAt: string;
}

export interface SyncStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function defaultSyncStorage(): SyncStorage | null {
  try {
    const storage = (globalThis as { localStorage?: SyncStorage }).localStorage;
    return storage ?? null;
  } catch {
    // Access can throw in private/blocked contexts; unknown ancestry is the safe result.
    return null;
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Stable content fingerprint used only to detect "local edits since last sync".
 * Two independent hashes reduce the collision risk; this is not a security hash.
 */
export function fingerprintState(state: LedgerState): string {
  const text = canonical(state);
  let fnv = 0x811c9dc5;
  let djb = 5381;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    fnv ^= code;
    fnv = Math.imul(fnv, 0x01000193) >>> 0;
    djb = (Math.imul(djb, 33) + code) >>> 0;
  }
  return `${fnv.toString(16).padStart(8, "0")}${djb.toString(16).padStart(8, "0")}`;
}

function isRecord(value: unknown): value is SyncRecord {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.vaultId === "string" &&
    typeof record.baseRevision === "number" &&
    Number.isSafeInteger(record.baseRevision) &&
    record.baseRevision >= 1 &&
    typeof record.fingerprint === "string" &&
    typeof record.snapshotVersion === "string" &&
    typeof record.updatedAt === "string"
  );
}

function readMap(storage: SyncStorage | null): Record<string, SyncRecord> {
  if (!storage) return {};
  try {
    const raw = storage.getItem(SYNC_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const map: Record<string, SyncRecord> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (isRecord(value)) map[key] = value;
    }
    return map;
  } catch {
    return {};
  }
}

export function readSyncRecord(
  vaultId: string,
  storage: SyncStorage | null = defaultSyncStorage()
): SyncRecord | null {
  const record = readMap(storage)[vaultId];
  return record ?? null;
}

export function writeSyncRecord(
  record: SyncRecord,
  storage: SyncStorage | null = defaultSyncStorage()
): boolean {
  if (!storage) return false;
  try {
    const map = readMap(storage);
    map[record.vaultId] = record;
    storage.setItem(SYNC_STORAGE_KEY, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}

export function clearSyncRecord(
  vaultId: string,
  storage: SyncStorage | null = defaultSyncStorage()
): boolean {
  if (!storage) return false;
  try {
    const map = readMap(storage);
    delete map[vaultId];
    storage.setItem(SYNC_STORAGE_KEY, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}

export function commitSynchronizedState(
  vaultId: string,
  revision: number,
  state: LedgerState,
  storage: SyncStorage | null = defaultSyncStorage()
): boolean {
  return writeSyncRecord(
    {
      vaultId,
      baseRevision: revision,
      fingerprint: fingerprintState(state),
      snapshotVersion: state.version,
      updatedAt: new Date().toISOString(),
    },
    storage
  );
}

export type PushPlan =
  | { mode: "create" }
  | { mode: "update"; expectedRevision: number }
  | { mode: "conflict"; reason: "unknown-ancestry" | "stale-local" };

/**
 * Decide how a push may proceed. The only revision a push may use is the locally
 * recorded base. A vault that exists without local ancestry is a conflict, never a
 * licence to overwrite.
 */
export function planPush(
  record: SyncRecord | null,
  remoteExists: boolean
): PushPlan {
  if (!remoteExists) {
    return record ? { mode: "conflict", reason: "stale-local" } : { mode: "create" };
  }
  if (!record) {
    return { mode: "conflict", reason: "unknown-ancestry" };
  }
  return { mode: "update", expectedRevision: record.baseRevision };
}

function ledgerHasContent(state: LedgerState): boolean {
  return (
    state.transactions.length > 0 ||
    state.incomes.length > 0 ||
    state.payments.length > 0 ||
    state.liabilities.length > 0
  );
}

/**
 * True when pulling would replace data this device has not synchronized.
 *
 * With no sync record the ancestry is unknown, so a non-empty local ledger is
 * treated as potentially unsynchronized: the user must confirm the replacement.
 */
export function localChangesSinceSync(
  record: SyncRecord | null,
  state: LedgerState | undefined
): boolean {
  if (!state) return false;
  if (!record) return ledgerHasContent(state);
  return fingerprintState(state) !== record.fingerprint;
}
