import test from "node:test";
import assert from "node:assert/strict";
import {
  SyncStorage,
  commitSynchronizedState,
  fingerprintState,
  localChangesSinceSync,
  planPush,
  readSyncRecord,
  writeSyncRecord,
} from "../sync-state";
import { SAMPLE_LEDGER_STATE, LedgerState } from "../types";

class FakeStorage implements SyncStorage {
  data = new Map<string, string>();
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

function stateWithBalance(balance: number): LedgerState {
  return JSON.parse(JSON.stringify({ ...SAMPLE_LEDGER_STATE, current_balance_cents: balance }));
}

test("fingerprint is stable across key order and changes when data changes", () => {
  const a = fingerprintState(stateWithBalance(1000));
  const b = fingerprintState(stateWithBalance(1000));
  const c = fingerprintState(stateWithBalance(1001));
  assert.equal(a, b);
  assert.notEqual(a, c);
  // Reordering top-level keys must not change the fingerprint.
  const reordered = Object.fromEntries(
    Object.entries(stateWithBalance(1000)).reverse()
  ) as unknown as LedgerState;
  assert.equal(fingerprintState(reordered), a);
});

test("a push to a missing vault with no ancestry is a creation", () => {
  assert.deepEqual(planPush(null, false), { mode: "create" });
});

test("a push to an existing vault with no local record is a conflict", () => {
  assert.deepEqual(planPush(null, true), { mode: "conflict", reason: "unknown-ancestry" });
});

test("a locally recorded vault the server no longer has is a conflict, not recreation", () => {
  const record = {
    vaultId: "v",
    baseRevision: 3,
    fingerprint: "x",
    snapshotVersion: "2.1",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  assert.deepEqual(planPush(record, false), { mode: "conflict", reason: "stale-local" });
});

test("a push uses the locally recorded base revision, never the server's latest", () => {
  const record = {
    vaultId: "v",
    baseRevision: 2,
    fingerprint: "x",
    snapshotVersion: "2.1",
    updatedAt: "2026-01-01T00:00:00Z",
  };
  // The server may currently be at revision 9; the plan still uses 2, so the
  // server's CAS rejects a stale overwrite instead of accepting it as revision 10.
  assert.deepEqual(planPush(record, true), { mode: "update", expectedRevision: 2 });
});

test("sync records round-trip and detect local edits since the last sync", () => {
  const storage = new FakeStorage();
  const state = stateWithBalance(5000);
  assert.equal(commitSynchronizedState("v", 4, state, storage), true);

  const record = readSyncRecord("v", storage);
  assert.ok(record);
  assert.equal(record!.baseRevision, 4);
  assert.equal(localChangesSinceSync(record, state), false);
  assert.equal(localChangesSinceSync(record, stateWithBalance(6000)), true);
});

test("unknown ancestry plus non-empty local data counts as unsynchronized", () => {
  assert.equal(localChangesSinceSync(null, stateWithBalance(1000)), true);
  const empty = stateWithBalance(0);
  empty.transactions = [];
  empty.incomes = [];
  empty.payments = [];
  empty.liabilities = [];
  assert.equal(localChangesSinceSync(null, empty), false);
});

test("corrupt sync metadata is treated as unknown ancestry", () => {
  const storage = new FakeStorage();
  storage.setItem("montecarlo_vault_sync_v1", "{not json");
  assert.equal(readSyncRecord("v", storage), null);
});

test("a storage failure is reported instead of claiming ancestry was saved", () => {
  const failing: SyncStorage = {
    getItem: () => null,
    setItem: () => {
      throw new Error("quota");
    },
    removeItem: () => undefined,
  };
  assert.equal(
    writeSyncRecord(
      {
        vaultId: "v",
        baseRevision: 1,
        fingerprint: "x",
        snapshotVersion: "2.1",
        updatedAt: "2026-01-01T00:00:00Z",
      },
      failing
    ),
    false
  );
});
