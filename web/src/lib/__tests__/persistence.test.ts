import assert from "node:assert/strict";
import test from "node:test";

import { SAMPLE_LEDGER_STATE } from "../types";
import {
  SYNC_STORAGE_KEY,
  VAULT_ID_STORAGE_KEY,
  fingerprintState,
  readSyncRecord,
  SyncStorage,
} from "../sync-state";
import { applyLedgerBundle, LEDGER_STORAGE_KEY } from "../persistence";

class FakeStorage implements SyncStorage {
  data = new Map<string, string>();
  failOnKey: string | null = null;

  getItem(key: string): string | null {
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
