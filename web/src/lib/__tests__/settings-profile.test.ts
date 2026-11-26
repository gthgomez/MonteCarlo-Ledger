import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ASSUMPTIONS } from "../assumptions";
import { EMPTY_TARGETS } from "../budget-targets";
import {
  parseSettingsProfile,
  readSettingsProfileRevision,
  rememberSettingsProfileRevision,
  serializeSettingsProfile,
  settingsProfileVaultId,
} from "../settings-profile";

test("portable settings round-trip preserves reserve, horizon and budget targets", () => {
  const assumptions = {
    ...DEFAULT_ASSUMPTIONS,
    reserveCents: 30000,
    horizonDays: 45,
    seed: 99,
    surpriseProbabilityPpm: 250000,
  };
  const targets = { monthlyLimitCents: 250000, categories: { Groceries: 60000, Rent: 145000 } };
  const profile = serializeSettingsProfile(assumptions, targets, "2026-11-24T10:00:00.000Z");
  const parsed = parseSettingsProfile(JSON.parse(JSON.stringify(profile)));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.profile.assumptions, assumptions);
  assert.deepEqual(parsed.profile.budgetTargets, targets);
});

test("a profile with a missing reserve is rejected instead of defaulted", () => {
  const profile: any = serializeSettingsProfile(DEFAULT_ASSUMPTIONS, EMPTY_TARGETS);
  delete profile.assumptions.reserveCents;
  const parsed = parseSettingsProfile(profile);
  assert.equal(parsed.ok, false);
});

test("unknown profile versions and fields fail closed", () => {
  const profile: any = serializeSettingsProfile(DEFAULT_ASSUMPTIONS, EMPTY_TARGETS);
  assert.equal(parseSettingsProfile({ ...profile, schemaVersion: 3 }).ok, false);
  assert.equal(parseSettingsProfile({ ...profile, schemaVersion: 2 }).ok, false);
  assert.equal(parseSettingsProfile({ ...profile, surprise: true }).ok, false);
  assert.equal(
    parseSettingsProfile({ ...profile, budgetTargets: { categories: { Rent: -1 } } }).ok,
    false
  );
});

test("a revision-bound profile only accepts a positive whole ledger revision", () => {
  const profile = serializeSettingsProfile(DEFAULT_ASSUMPTIONS, EMPTY_TARGETS);
  const paired = { ...profile, schemaVersion: 2, ledgerRevision: 7 };
  assert.deepEqual(parseSettingsProfile(paired), { ok: true, profile: paired });
  assert.equal(parseSettingsProfile({ ...paired, ledgerRevision: 0 }).ok, false);
  assert.equal(parseSettingsProfile({ ...paired, ledgerRevision: 2.5 }).ok, false);
  assert.equal(parseSettingsProfile({ ...profile, ledgerRevision: 7 }).ok, false);
});
test("invalid financial settings cannot be serialized", () => {
  assert.throws(() =>
    serializeSettingsProfile(
      { ...DEFAULT_ASSUMPTIONS, reserveCents: -1 },
      EMPTY_TARGETS
    )
  );
});

test("the profile vault id is deterministic and within the server limit", async () => {
  const first = await settingsProfileVaultId("vault-abc");
  const second = await settingsProfileVaultId("vault-abc");
  assert.equal(first, second);
  assert.notEqual(first, await settingsProfileVaultId("vault-abd"));
  assert.match(first, /^[A-Za-z0-9._-]{3,128}$/);
  const long = await settingsProfileVaultId("x".repeat(128));
  assert.ok(long.length <= 128);
  assert.match(long, /^[A-Za-z0-9._-]{3,128}$/);
});

test("profile revision ancestry is stored per derived vault id", () => {
  const map = new Map<string, string>();
  const storage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
  assert.equal(readSettingsProfileRevision(storage, "settings-a"), null);
  assert.equal(rememberSettingsProfileRevision(storage, "settings-a", 3, "2026-11-24T10:00:00Z"), true);
  assert.deepEqual(readSettingsProfileRevision(storage, "settings-a"), {
    baseRevision: 3,
    savedAt: "2026-11-24T10:00:00Z",
  });
  assert.equal(readSettingsProfileRevision(storage, "settings-b"), null);
});
