import test from "node:test";
import assert from "node:assert/strict";
import {
  ASSUMPTIONS_LOCK_NAME,
  ASSUMPTIONS_STORAGE_KEY,
  loadAssumptions,
  saveAssumptions,
  type AssumptionsSaveResult,
  type AssumptionsStorage,
} from "../assumptions-persistence";
import { DEFAULT_ASSUMPTIONS } from "../assumptions";
import type { LedgerLockManager } from "../persistence";

class MemoryStorage implements AssumptionsStorage {
  values = new Map<string, string>();
  failWrite: "before" | "after" | null = null;
  changeDuringWrite: string | null = null;
  failRemove = false;
  readCalls = 0;
  failReadAtCall: number | null = null;

  getItem(key: string) {
    this.readCalls += 1;
    if (this.failReadAtCall === this.readCalls) throw new Error("read blocked");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    if (this.failWrite === "before") throw new Error("quota full");
    this.values.set(key, value);
    if (this.changeDuringWrite !== null) {
      this.values.set(key, this.changeDuringWrite);
      this.changeDuringWrite = null;
    }
    if (this.failWrite === "after") throw new Error("interrupted write");
  }

  removeItem(key: string) {
    if (this.failRemove) throw new Error("remove blocked");
    this.values.delete(key);
  }
}

const immediateLocks: LedgerLockManager = {
  request: (_name, _options, callback) => Promise.resolve(callback(undefined)),
};

/** Runs callbacks one at a time, so tests exercise real queue ordering rather than mocks. */
class QueuedLocks implements LedgerLockManager {
  names: string[] = [];
  private tail: Promise<unknown> = Promise.resolve();

  request<T>(
    name: string,
    _options: { mode?: "exclusive" | "shared"; signal?: AbortSignal },
    callback: (lock: unknown) => T | Promise<T>
  ): Promise<T> {
    this.names.push(name);
    const result = this.tail.then(() => callback(undefined));
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}

const rejectingLocks: LedgerLockManager = {
  request: () => Promise.reject(new Error("lock request rejected")),
};

function encoded(assumptions: typeof DEFAULT_ASSUMPTIONS): string {
  return JSON.stringify({ schemaVersion: 1, values: assumptions });
}

/** Narrow a result that must have failed, without weakening the union. */
function expectFailure(result: AssumptionsSaveResult): Extract<AssumptionsSaveResult, { ok: false }> {
  if (result.ok) assert.fail("expected a failed assumptions save result");
  return result;
}

test("the settings lock is separate from the ledger lock name", () => {
  assert.equal(ASSUMPTIONS_LOCK_NAME, "montecarlo-financial-settings-write");
});

test("missing saved assumptions use defaults without a migration warning", () => {
  const loaded = loadAssumptions(new MemoryStorage());
  assert.equal(loaded.ok, true);
  if (loaded.ok) {
    assert.deepEqual(loaded.assumptions, DEFAULT_ASSUMPTIONS);
    assert.equal(loaded.migrated, false);
    assert.equal(loaded.warning, null);
    assert.equal(loaded.raw, null);
  }
});

test("versioned assumptions round-trip all financial controls", async () => {
  const storage = new MemoryStorage();
  const assumptions = { ...DEFAULT_ASSUMPTIONS, reserveCents: 50_000, horizonDays: 180, runs: 1_200, seed: 7 };
  assert.deepEqual(await saveAssumptions(storage, assumptions, null, immediateLocks), {
    ok: true,
    raw: encoded(assumptions),
  });
  const raw = storage.getItem(ASSUMPTIONS_STORAGE_KEY);
  assert.ok(raw);
  assert.deepEqual(JSON.parse(raw), { schemaVersion: 1, values: assumptions });
  const loaded = loadAssumptions(storage);
  assert.equal(loaded.ok, true);
  if (loaded.ok) {
    assert.deepEqual(loaded.assumptions, assumptions);
    assert.equal(loaded.migrated, false);
    assert.equal(loaded.warning, null);
  }
});

test("a valid unversioned legacy assumptions record is explicitly migrated", () => {
  const storage = new MemoryStorage();
  const legacy = { ...DEFAULT_ASSUMPTIONS, reserveCents: 12_345 };
  storage.values.set(ASSUMPTIONS_STORAGE_KEY, JSON.stringify(legacy));
  const loaded = loadAssumptions(storage);
  assert.equal(loaded.ok, true);
  if (!loaded.ok) return;
  assert.deepEqual(loaded.assumptions, legacy);
  assert.equal(loaded.migrated, true);
  assert.match(loaded.warning ?? "", /Older financial settings/);
});

test("corrupt, incomplete, invalid, and unsupported assumptions fail closed", () => {
  const cases = [
    "{",
    JSON.stringify({ schemaVersion: 1, values: { reserveCents: 99_999 } }),
    JSON.stringify({ schemaVersion: 2, values: DEFAULT_ASSUMPTIONS }),
    JSON.stringify({ schemaVersion: 1, values: { ...DEFAULT_ASSUMPTIONS, surpriseAmountMin: -1 } }),
    JSON.stringify({ schemaVersion: 1, values: { ...DEFAULT_ASSUMPTIONS, unexpectedFutureField: 1 } }),
  ];
  for (const raw of cases) {
    const storage = new MemoryStorage();
    storage.values.set(ASSUMPTIONS_STORAGE_KEY, raw);
    const loaded = loadAssumptions(storage);
    assert.equal(loaded.ok, false, raw);
    assert.equal(storage.getItem(ASSUMPTIONS_STORAGE_KEY), raw);
  }
});

test("storage read failure is an error, not a default plan", () => {
  const storage: AssumptionsStorage = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
    removeItem() { throw new Error("blocked"); },
  };
  const loaded = loadAssumptions(storage);
  assert.equal(loaded.ok, false);
  if (!loaded.ok) assert.match(loaded.error, /could not be read/);
});

test("failed writes preserve the last valid settings, including interrupted writes", async () => {
  const storage = new MemoryStorage();
  const original = { ...DEFAULT_ASSUMPTIONS, reserveCents: 20_000 };
  assert.equal((await saveAssumptions(storage, original, null, immediateLocks)).ok, true);
  const priorRaw = storage.getItem(ASSUMPTIONS_STORAGE_KEY);
  storage.failWrite = "before";
  const before = expectFailure(await saveAssumptions(storage, { ...original, reserveCents: 40_000 }, priorRaw, immediateLocks));
  assert.equal(before.reason, "failed");
  assert.match(before.error, /Financial settings could not be saved/);
  assert.equal(storage.getItem(ASSUMPTIONS_STORAGE_KEY), priorRaw);
  storage.failWrite = "after";
  const after = expectFailure(await saveAssumptions(storage, { ...original, reserveCents: 60_000 }, priorRaw, immediateLocks));
  assert.equal(after.reason, "failed");
  assert.match(after.error, /Financial settings could not be saved/);
  assert.equal(storage.getItem(ASSUMPTIONS_STORAGE_KEY), priorRaw);
  storage.failWrite = null;
  const restored = loadAssumptions(storage);
  assert.equal(restored.ok, true);
  if (restored.ok) assert.deepEqual(restored.assumptions, original);
});

test("invalid assumptions cannot be saved", async () => {
  const storage = new MemoryStorage();
  const result = expectFailure(await saveAssumptions(storage, { ...DEFAULT_ASSUMPTIONS, runs: 0 }, null, immediateLocks));
  assert.equal(result.reason, "failed");
  assert.equal(storage.getItem(ASSUMPTIONS_STORAGE_KEY), null);
});

test("a concurrent tab update is not rolled back as if it were a failed write", async () => {
  const storage = new MemoryStorage();
  const original = { ...DEFAULT_ASSUMPTIONS, reserveCents: 20_000 };
  const concurrent = { ...DEFAULT_ASSUMPTIONS, reserveCents: 30_000 };
  assert.equal((await saveAssumptions(storage, original, null, immediateLocks)).ok, true);
  const priorRaw = storage.getItem(ASSUMPTIONS_STORAGE_KEY);
  const concurrentRaw = encoded(concurrent);
  storage.changeDuringWrite = concurrentRaw;

  const result = expectFailure(
    await saveAssumptions(storage, { ...DEFAULT_ASSUMPTIONS, reserveCents: 50_000 }, priorRaw, immediateLocks)
  );

  assert.equal(result.reason, "conflict");
  assert.match(result.error, /changed in another tab/);
  assert.equal(result.raw, concurrentRaw);
  assert.equal(storage.getItem(ASSUMPTIONS_STORAGE_KEY), concurrentRaw);
  const loaded = loadAssumptions(storage);
  assert.equal(loaded.ok, true);
  if (loaded.ok) assert.deepEqual(loaded.assumptions, concurrent);
});

test("queued saves compare the earlier rendered null and report the changed durable reserve", async () => {
  const storage = new MemoryStorage();
  const locks = new QueuedLocks();
  const first = { ...DEFAULT_ASSUMPTIONS, reserveCents: 20_000 };
  const second = { ...DEFAULT_ASSUMPTIONS, reserveCents: 30_000 };

  const firstSaving = saveAssumptions(storage, first, null, locks);
  const secondSaving = saveAssumptions(storage, second, null, locks);
  const [firstResult, secondResult] = await Promise.all([firstSaving, secondSaving]);

  assert.deepEqual(firstResult, { ok: true, raw: encoded(first) });
  const conflict = expectFailure(secondResult);
  assert.equal(conflict.reason, "conflict");
  assert.match(conflict.error, /changed in another tab/);
  assert.equal(conflict.raw, encoded(first));
  const durable = JSON.parse(conflict.raw ?? "null");
  assert.equal(durable.values.reserveCents, 20_000);
  assert.equal(storage.getItem(ASSUMPTIONS_STORAGE_KEY), encoded(first));
  assert.deepEqual(locks.names, [ASSUMPTIONS_LOCK_NAME, ASSUMPTIONS_LOCK_NAME]);
});

test("a conflict observed before the write leaves an existing value untouched", async () => {
  const storage = new MemoryStorage();
  const durable = { ...DEFAULT_ASSUMPTIONS, reserveCents: 70_000 };
  storage.values.set(ASSUMPTIONS_STORAGE_KEY, encoded(durable));

  const result = expectFailure(
    await saveAssumptions(storage, { ...DEFAULT_ASSUMPTIONS, reserveCents: 80_000 }, null, immediateLocks)
  );

  assert.equal(result.reason, "conflict");
  assert.equal(result.raw, encoded(durable));
  assert.equal(storage.getItem(ASSUMPTIONS_STORAGE_KEY), encoded(durable));
});

test("absent or rejected locks fail safely without a write", async () => {
  const storage = new MemoryStorage();
  const priorRaw = encoded({ ...DEFAULT_ASSUMPTIONS, reserveCents: 10_000 });
  storage.values.set(ASSUMPTIONS_STORAGE_KEY, priorRaw);

  const absent = expectFailure(
    await saveAssumptions(storage, { ...DEFAULT_ASSUMPTIONS, reserveCents: 40_000 }, priorRaw, null)
  );
  assert.equal(absent.reason, "failed");
  assert.match(absent.error, /lock financial settings across tabs/);
  assert.equal(storage.getItem(ASSUMPTIONS_STORAGE_KEY), priorRaw);

  const rejected = expectFailure(
    await saveAssumptions(storage, { ...DEFAULT_ASSUMPTIONS, reserveCents: 50_000 }, priorRaw, rejectingLocks)
  );
  assert.equal(rejected.reason, "failed");
  assert.match(rejected.error, /could not be locked/);
  assert.equal(storage.getItem(ASSUMPTIONS_STORAGE_KEY), priorRaw);
});

test("missing storage and a pre-write read failure are unreadable before anything is written", async () => {
  const noStorage = expectFailure(
    await saveAssumptions(null, { ...DEFAULT_ASSUMPTIONS, reserveCents: 40_000 }, null, immediateLocks)
  );
  assert.equal(noStorage.reason, "unreadable");
  assert.match(noStorage.error, /previous financial settings could not be checked/i);

  const storage = new MemoryStorage();
  const priorRaw = encoded({ ...DEFAULT_ASSUMPTIONS, reserveCents: 10_000 });
  storage.values.set(ASSUMPTIONS_STORAGE_KEY, priorRaw);
  storage.failReadAtCall = 1;

  const unreadable = expectFailure(
    await saveAssumptions(storage, { ...DEFAULT_ASSUMPTIONS, reserveCents: 40_000 }, priorRaw, immediateLocks)
  );
  assert.equal(unreadable.reason, "unreadable");
  assert.match(unreadable.error, /previous financial settings could not be checked/i);
  assert.equal(storage.values.get(ASSUMPTIONS_STORAGE_KEY), priorRaw);
});

test("a read failure after writing is indeterminate and does not instruct a blind reload", async () => {
  const storage = new MemoryStorage();
  const priorRaw = encoded({ ...DEFAULT_ASSUMPTIONS, reserveCents: 10_000 });
  const proposed = { ...DEFAULT_ASSUMPTIONS, reserveCents: 40_000 };
  storage.values.set(ASSUMPTIONS_STORAGE_KEY, priorRaw);
  storage.failReadAtCall = 2;

  const result = expectFailure(await saveAssumptions(storage, proposed, priorRaw, immediateLocks));

  assert.equal(result.reason, "indeterminate");
  assert.match(result.error, /some or all of the change may have persisted/i);
  assert.doesNotMatch(result.error, /reload/i);
  assert.doesNotMatch(result.error, /discard/i);
  // The write occurred; only verification failed.
  assert.equal(storage.values.get(ASSUMPTIONS_STORAGE_KEY), encoded(proposed));
});

test("an unverified rollback that leaves the new bytes durable is indeterminate", async () => {
  const storage = new MemoryStorage();
  const proposed = { ...DEFAULT_ASSUMPTIONS, reserveCents: 40_000 };
  storage.failWrite = "after";
  storage.failRemove = true;

  const result = expectFailure(await saveAssumptions(storage, proposed, null, immediateLocks));

  assert.equal(result.reason, "indeterminate");
  assert.match(result.error, /some or all of the change may have persisted/i);
  assert.doesNotMatch(result.error, /reload/i);
  assert.doesNotMatch(result.error, /discard/i);
  assert.equal(storage.values.get(ASSUMPTIONS_STORAGE_KEY), encoded(proposed));
});

test("a rollback that throws after restoring previous bytes still reports a verified failure", async () => {
  const storage = new MemoryStorage();
  const priorRaw = encoded({ ...DEFAULT_ASSUMPTIONS, reserveCents: 10_000 });
  const proposed = { ...DEFAULT_ASSUMPTIONS, reserveCents: 40_000 };
  storage.values.set(ASSUMPTIONS_STORAGE_KEY, priorRaw);
  storage.failWrite = "after";

  const result = expectFailure(await saveAssumptions(storage, proposed, priorRaw, immediateLocks));

  assert.equal(result.reason, "failed");
  assert.match(result.error, /Financial settings could not be saved/);
  assert.doesNotMatch(result.error, /some or all of the change may have persisted/i);
  assert.equal(storage.values.get(ASSUMPTIONS_STORAGE_KEY), priorRaw);
});
