import assert from "node:assert/strict";
import test from "node:test";

import { SAMPLE_LEDGER_STATE } from "../types";
import {
  SYNC_STORAGE_KEY,
  VAULT_ID_STORAGE_KEY,
  commitSynchronizedState,
  fingerprintState,
  readSyncRecord,
  SyncStorage,
} from "../sync-state";
import {
  applyLedgerBundle,
  LEDGER_LOCK_NAME,
  LEDGER_STORAGE_KEY,
  LedgerLockManager,
  saveLedgerChange,
} from "../persistence";

class FakeStorage implements SyncStorage {
  data = new Map<string, string>();
  failOnKey: string | null = null;
  failReadOnKey: string | null = null;

  getItem(key: string): string | null {
    if (this.failReadOnKey === key) throw new Error(`read blocked on ${key}`);
    return this.data.has(key) ? (this.data.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    if (this.failOnKey === key) throw new Error(`quota on ${key}`);
    this.data.set(key, value);
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
}

const STATE = { ...SAMPLE_LEDGER_STATE, updated_at: "2026-11-07T00:00:00Z" };

test("a successful bundle writes ledger, vault and ancestry", () => {
  const storage = new FakeStorage();
  const result = applyLedgerBundle(STATE, "vault-1", 3, storage);
  assert.deepEqual(result, { ok: true });
  assert.equal(storage.getItem(LEDGER_STORAGE_KEY), JSON.stringify(STATE));
  assert.equal(storage.getItem(VAULT_ID_STORAGE_KEY), "vault-1");
  const record = readSyncRecord("vault-1", storage);
  assert.equal(record?.baseRevision, 3);
  assert.equal(record?.fingerprint, fingerprintState(STATE));
});

test("a ledger write failure changes nothing", () => {
  const storage = new FakeStorage();
  storage.data.set(LEDGER_STORAGE_KEY, "previous");
  storage.data.set(VAULT_ID_STORAGE_KEY, "old-vault");
  storage.failOnKey = LEDGER_STORAGE_KEY;
  const result = applyLedgerBundle(STATE, "vault-1", 3, storage);
  assert.equal(result.ok, false);
  assert.equal(storage.getItem(LEDGER_STORAGE_KEY), "previous");
  assert.equal(storage.getItem(VAULT_ID_STORAGE_KEY), "old-vault");
  assert.equal(storage.getItem(SYNC_STORAGE_KEY), null);
});

test("a vault-id write failure rolls the ledger back", () => {
  const storage = new FakeStorage();
  storage.data.set(LEDGER_STORAGE_KEY, "previous");
  storage.failOnKey = VAULT_ID_STORAGE_KEY;
  const result = applyLedgerBundle(STATE, "vault-1", 3, storage);
  assert.equal(result.ok, false);
  assert.equal(storage.getItem(LEDGER_STORAGE_KEY), "previous");
  assert.equal(storage.getItem(VAULT_ID_STORAGE_KEY), null);
  assert.equal(storage.getItem(SYNC_STORAGE_KEY), null);
});

test("an ancestry write failure rolls back ledger and vault id", () => {
  const storage = new FakeStorage();
  storage.data.set(LEDGER_STORAGE_KEY, "previous");
  storage.data.set(VAULT_ID_STORAGE_KEY, "old-vault");
  storage.data.set(SYNC_STORAGE_KEY, "old-sync");
  storage.failOnKey = SYNC_STORAGE_KEY;
  const result = applyLedgerBundle(STATE, "vault-1", 3, storage);
  assert.equal(result.ok, false);
  assert.equal(storage.getItem(LEDGER_STORAGE_KEY), "previous");
  assert.equal(storage.getItem(VAULT_ID_STORAGE_KEY), "old-vault");
  assert.equal(storage.getItem(SYNC_STORAGE_KEY), "old-sync");
  assert.equal(readSyncRecord("vault-1", storage), null);
});

test("a storage failure during rollback is reported without claiming the prior data is intact", () => {
  const storage = new FakeStorage();
  storage.data.set(LEDGER_STORAGE_KEY, "previous");
  const write = storage.setItem.bind(storage);
  storage.setItem = (key, value) => {
    if (key === SYNC_STORAGE_KEY || (key === LEDGER_STORAGE_KEY && value === "previous")) {
      throw new Error("storage blocked");
    }
    write(key, value);
  };
  const result = applyLedgerBundle(STATE, "vault-1", 3, storage);
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /previous saved data could not be verified/i);
  assert.equal(storage.getItem(VAULT_ID_STORAGE_KEY), null);
});

test("unavailable storage fails closed", () => {
  const result = applyLedgerBundle(STATE, "vault-1", 3, null);
  assert.equal(result.ok, false);
});

test("a plain import without a vault writes only the ledger", () => {
  const storage = new FakeStorage();
  const result = applyLedgerBundle(STATE, undefined, undefined, storage);
  assert.deepEqual(result, { ok: true });
  assert.equal(storage.getItem(LEDGER_STORAGE_KEY), JSON.stringify(STATE));
  assert.equal(storage.getItem(VAULT_ID_STORAGE_KEY), null);
  assert.equal(storage.getItem(SYNC_STORAGE_KEY), null);
});

const immediateLocks: LedgerLockManager = {
  request: (_name, _options, callback) => Promise.resolve(callback(undefined)),
};

interface PendingLockRequest {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
}

/** Holds callbacks so a test can abort while the writer is queued for the lock. */
class DeferredLocks implements LedgerLockManager {
  pending: PendingLockRequest[] = [];
  names: string[] = [];

  request<T>(
    name: string,
    _options: { mode?: "exclusive" | "shared"; signal?: AbortSignal },
    callback: (lock: unknown) => T | Promise<T>
  ): Promise<T> {
    this.names.push(name);
    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        run: () => Promise.resolve(callback(undefined)),
        resolve: resolve as (value: unknown) => void,
        reject,
      });
    });
  }

  async release(): Promise<void> {
    const next = this.pending.shift();
    if (!next) throw new Error("no queued lock request");
    try {
      next.resolve(await next.run());
    } catch (err) {
      next.reject(err);
    }
  }
}

test("saveLedgerChange replaces the exact durable snapshot under the shared lock", async () => {
  const storage = new FakeStorage();
  storage.data.set(LEDGER_STORAGE_KEY, JSON.stringify(STATE));
  const locks = new DeferredLocks();

  const saving = saveLedgerChange(
    { ...STATE, updated_at: "2026-11-08T00:00:00Z" },
    { expectedRaw: JSON.stringify(STATE), vaultId: "vault-1", syncRevision: 4 },
    storage,
    LEDGER_STORAGE_KEY,
    locks
  );
  await locks.release();
  const result = await saving;

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(locks.names, [LEDGER_LOCK_NAME]);
  assert.equal(
    storage.getItem(LEDGER_STORAGE_KEY),
    JSON.stringify({ ...STATE, updated_at: "2026-11-08T00:00:00Z" })
  );
  assert.equal(storage.getItem(VAULT_ID_STORAGE_KEY), "vault-1");
  assert.equal(readSyncRecord("vault-1", storage)?.baseRevision, 4);
});

test("saveLedgerChange refuses a snapshot changed after authorization", async () => {
  const storage = new FakeStorage();
  storage.data.set(LEDGER_STORAGE_KEY, JSON.stringify(STATE));

  const result = await saveLedgerChange(
    { ...STATE, updated_at: "2026-11-09T00:00:00Z" },
    { expectedRaw: "an-older-snapshot", requireLock: true },
    storage,
    LEDGER_STORAGE_KEY,
    immediateLocks
  );

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /changed in another tab/);
  assert.equal(storage.getItem(LEDGER_STORAGE_KEY), JSON.stringify(STATE));
  assert.equal(storage.getItem(VAULT_ID_STORAGE_KEY), null);
});

test("an older pull cannot undo newer sync ancestry even if the saved ledger has not changed", async () => {
  const storage = new FakeStorage();
  const raw = JSON.stringify(STATE);
  storage.setItem(LEDGER_STORAGE_KEY, raw);
  commitSynchronizedState("vault-1", 4, STATE, storage);
  const result = await saveLedgerChange(
    { ...STATE, updated_at: "2026-11-09T00:00:00Z" },
    { expectedRaw: raw, vaultId: "vault-1", syncRevision: 3, requireLock: true },
    storage,
    LEDGER_STORAGE_KEY,
    immediateLocks
  );
  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /newer vault revision/);
  assert.equal(storage.getItem(LEDGER_STORAGE_KEY), raw);
  assert.equal(readSyncRecord("vault-1", storage)?.baseRevision, 4);
});

test("null expected raw means the store must still be empty", async () => {
  const storage = new FakeStorage();
  const result = await saveLedgerChange(
    STATE,
    { expectedRaw: null, requireLock: true },
    storage,
    LEDGER_STORAGE_KEY,
    immediateLocks
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(storage.getItem(LEDGER_STORAGE_KEY), JSON.stringify(STATE));
});

test("a signal aborted while queued prevents the replacement", async () => {
  const storage = new FakeStorage();
  const locks = new DeferredLocks();
  const controller = new AbortController();

  const saving = saveLedgerChange(
    STATE,
    { expectedRaw: null, signal: controller.signal, requireLock: true },
    storage,
    LEDGER_STORAGE_KEY,
    locks
  );
  assert.equal(locks.pending.length, 1);
  controller.abort();
  await locks.release();
  const result = await saving;

  assert.equal(result.ok, false);
  assert.equal(storage.getItem(LEDGER_STORAGE_KEY), null);
});

test("a signal aborted before starting never calls the lock", async () => {
  const storage = new FakeStorage();
  const locks = new DeferredLocks();
  const controller = new AbortController();
  controller.abort();

  const result = await saveLedgerChange(
    STATE,
    { expectedRaw: null, signal: controller.signal, requireLock: true },
    storage,
    LEDGER_STORAGE_KEY,
    locks
  );

  assert.equal(result.ok, false);
  assert.equal(locks.names.length, 0);
  assert.equal(storage.getItem(LEDGER_STORAGE_KEY), null);
});

test("a destructive replacement fails closed without Web Locks", async () => {
  const storage = new FakeStorage();
  const result = await saveLedgerChange(
    STATE,
    { expectedRaw: null, requireLock: true },
    storage,
    LEDGER_STORAGE_KEY,
    null
  );

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /cannot lock the ledger/);
  assert.equal(storage.getItem(LEDGER_STORAGE_KEY), null);
});

test("ordinary edits keep the checked fallback when Web Locks are unavailable", async () => {
  const storage = new FakeStorage();
  storage.data.set(LEDGER_STORAGE_KEY, JSON.stringify(STATE));
  const result = await saveLedgerChange(
    { ...STATE, updated_at: "2026-11-10T00:00:00Z" },
    { expectedRaw: JSON.stringify(STATE) },
    storage,
    LEDGER_STORAGE_KEY,
    null
  );

  assert.deepEqual(result, { ok: true });
  assert.equal(
    storage.getItem(LEDGER_STORAGE_KEY),
    JSON.stringify({ ...STATE, updated_at: "2026-11-10T00:00:00Z" })
  );
});

test("the fallback still refuses a stale snapshot", async () => {
  const storage = new FakeStorage();
  storage.data.set(LEDGER_STORAGE_KEY, "changed-elsewhere");
  const result = await saveLedgerChange(
    STATE,
    { expectedRaw: "what-the-user-saw" },
    storage,
    LEDGER_STORAGE_KEY,
    null
  );

  assert.equal(result.ok, false);
  assert.equal(storage.getItem(LEDGER_STORAGE_KEY), "changed-elsewhere");
});

test("a failed bundle inside the lock rolls back every key", async () => {
  const storage = new FakeStorage();
  storage.data.set(LEDGER_STORAGE_KEY, "previous");
  storage.data.set(VAULT_ID_STORAGE_KEY, "old-vault");
  storage.data.set(SYNC_STORAGE_KEY, "old-sync");
  storage.failOnKey = SYNC_STORAGE_KEY;

  const result = await saveLedgerChange(
    STATE,
    { expectedRaw: "previous", vaultId: "vault-1", syncRevision: 3, requireLock: true },
    storage,
    LEDGER_STORAGE_KEY,
    immediateLocks
  );

  assert.equal(result.ok, false);
  assert.equal(storage.getItem(LEDGER_STORAGE_KEY), "previous");
  assert.equal(storage.getItem(VAULT_ID_STORAGE_KEY), "old-vault");
  assert.equal(storage.getItem(SYNC_STORAGE_KEY), "old-sync");
});

test("a lock failure prevents both replacement and ordinary saves from writing without it", async () => {
  const storage = new FakeStorage();
  const failingLocks: LedgerLockManager = {
    request: () => Promise.reject(new Error("lock unavailable")),
  };
  for (const requireLock of [true, false]) {
    const result = await saveLedgerChange(
      STATE,
      { expectedRaw: null, requireLock },
      storage,
      LEDGER_STORAGE_KEY,
      failingLocks
    );
    assert.equal(result.ok, false);
    assert.equal(storage.getItem(LEDGER_STORAGE_KEY), null);
  }
});

test("a blocked durable read fails closed without touching stored data", async () => {
  const storage = new FakeStorage();
  storage.data.set(LEDGER_STORAGE_KEY, "previous");
  storage.failReadOnKey = LEDGER_STORAGE_KEY;

  const result = await saveLedgerChange(
    STATE,
    { expectedRaw: "previous" },
    storage,
    LEDGER_STORAGE_KEY,
    null
  );

  assert.equal(result.ok, false);
  assert.match(result.ok ? "" : result.error, /could not be read/);
  assert.equal(storage.data.get(LEDGER_STORAGE_KEY), "previous");
  assert.equal(storage.data.get(VAULT_ID_STORAGE_KEY), undefined);
  assert.equal(storage.data.get(SYNC_STORAGE_KEY), undefined);
});
