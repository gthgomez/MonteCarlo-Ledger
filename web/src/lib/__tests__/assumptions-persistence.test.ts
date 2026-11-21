import test from "node:test";
import assert from "node:assert/strict";
import {
  ASSUMPTIONS_STORAGE_KEY,
  loadAssumptions,
  saveAssumptions,
  type AssumptionsStorage,
} from "../assumptions-persistence";
import { DEFAULT_ASSUMPTIONS } from "../assumptions";

class MemoryStorage implements AssumptionsStorage {
  values = new Map<string, string>();
  failWrite: "before" | "after" | null = null;
  changeDuringWrite: string | null = null;

  getItem(key: string) {
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
    this.values.delete(key);
  }
}

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

test("versioned assumptions round-trip all financial controls", () => {
  const storage = new MemoryStorage();
  const assumptions = { ...DEFAULT_ASSUMPTIONS, reserveCents: 50_000, horizonDays: 180, runs: 1_200, seed: 7 };
  assert.deepEqual(saveAssumptions(storage, assumptions), { ok: true });
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

test("failed writes preserve the last valid settings, including interrupted writes", () => {
  const storage = new MemoryStorage();
  const original = { ...DEFAULT_ASSUMPTIONS, reserveCents: 20_000 };
  assert.deepEqual(saveAssumptions(storage, original), { ok: true });
  const priorRaw = storage.getItem(ASSUMPTIONS_STORAGE_KEY);
  storage.failWrite = "before";
  assert.equal(saveAssumptions(storage, { ...original, reserveCents: 40_000 }).ok, false);
  assert.equal(storage.getItem(ASSUMPTIONS_STORAGE_KEY), priorRaw);
  storage.failWrite = "after";
  assert.equal(saveAssumptions(storage, { ...original, reserveCents: 60_000 }).ok, false);
  assert.equal(storage.getItem(ASSUMPTIONS_STORAGE_KEY), priorRaw);
  storage.failWrite = null;
  const restored = loadAssumptions(storage);
  assert.equal(restored.ok, true);
  if (restored.ok) assert.deepEqual(restored.assumptions, original);
});

test("invalid assumptions cannot be saved", () => {
  const storage = new MemoryStorage();
  const result = saveAssumptions(storage, { ...DEFAULT_ASSUMPTIONS, runs: 0 });
  assert.equal(result.ok, false);
  assert.equal(storage.getItem(ASSUMPTIONS_STORAGE_KEY), null);
});

test("a concurrent tab update is not rolled back as if it were a failed write", () => {
  const storage = new MemoryStorage();
  const original = { ...DEFAULT_ASSUMPTIONS, reserveCents: 20_000 };
  const concurrent = { ...DEFAULT_ASSUMPTIONS, reserveCents: 30_000 };
  assert.deepEqual(saveAssumptions(storage, original), { ok: true });
  const concurrentRaw = JSON.stringify({ schemaVersion: 1, values: concurrent });
  storage.changeDuringWrite = concurrentRaw;

  const result = saveAssumptions(storage, { ...DEFAULT_ASSUMPTIONS, reserveCents: 50_000 });

  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error, /changed in another tab/);
  assert.equal(storage.getItem(ASSUMPTIONS_STORAGE_KEY), concurrentRaw);
  const loaded = loadAssumptions(storage);
  assert.equal(loaded.ok, true);
  if (loaded.ok) assert.deepEqual(loaded.assumptions, concurrent);
});
