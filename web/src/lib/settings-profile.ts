import { assumptionError, type Assumptions } from "./assumptions";
import { parseBudgetTargets, type BudgetTargets } from "./budget-targets";
import type { KeyValueStorage } from "./budget-targets";

/**
 * Portable financial settings travel as their own encrypted vault object.
 *
 * The ledger snapshot schema is deliberately unchanged: Python and Android
 * readers keep opening the same 2.0-2.2 payloads. A vault may contain an
 * optional companion profile under a derived vault ID. Old clients never look
 * it up, so they neither lose data nor misinterpret it.
 */

export const SETTINGS_PROFILE_SCHEMA_VERSION = 1;

export interface SettingsProfile {
  schemaVersion: typeof SETTINGS_PROFILE_SCHEMA_VERSION;
  /** Informational only; never used to choose between financial values. */
  savedAt: string;
  assumptions: Assumptions;
  budgetTargets: BudgetTargets;
}

export type SettingsProfileParseResult =
  | { ok: true; profile: SettingsProfile }
  | { ok: false; error: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

export function parseSettingsProfile(raw: unknown): SettingsProfileParseResult {
  if (!isObject(raw)) return { ok: false, error: "Financial settings profile must be an object." };
  if (!hasExactKeys(raw, ["schemaVersion", "savedAt", "assumptions", "budgetTargets"])) {
    return { ok: false, error: "Financial settings profile has unrecognized fields." };
  }
  if (raw.schemaVersion !== SETTINGS_PROFILE_SCHEMA_VERSION) {
    return {
      ok: false,
      error: `Financial settings profile uses unsupported version ${String(raw.schemaVersion)}.`,
    };
  }
  if (typeof raw.savedAt !== "string" || Number.isNaN(Date.parse(raw.savedAt))) {
    return { ok: false, error: "Financial settings profile has an invalid timestamp." };
  }
  if (!isObject(raw.assumptions)) {
    return { ok: false, error: "Financial settings profile is missing its forecast settings." };
  }
  const assumptions = raw.assumptions as unknown as Assumptions;
  const problem = assumptionError(assumptions);
  if (problem) return { ok: false, error: `Financial settings profile is invalid: ${problem}` };

  if (!isObject(raw.budgetTargets)) {
    return { ok: false, error: "Financial settings profile is missing its budget targets." };
  }
  // parseBudgetTargets validates unknown categories, whole cents and the limit.
  const parsedTargets = parseBudgetTargets(JSON.stringify(raw.budgetTargets));
  if (parsedTargets.warning) {
    return { ok: false, error: `Financial settings profile is invalid: ${parsedTargets.warning}` };
  }
  return {
    ok: true,
    profile: {
      schemaVersion: SETTINGS_PROFILE_SCHEMA_VERSION,
      savedAt: raw.savedAt,
      assumptions: { ...assumptions },
      budgetTargets: parsedTargets.targets,
    },
  };
}

export function serializeSettingsProfile(
  assumptions: Assumptions,
  budgetTargets: BudgetTargets,
  savedAt: string = new Date().toISOString()
): SettingsProfile {
  const candidate: SettingsProfile = {
    schemaVersion: SETTINGS_PROFILE_SCHEMA_VERSION,
    savedAt,
    assumptions: { ...assumptions },
    budgetTargets: {
      monthlyLimitCents: budgetTargets.monthlyLimitCents,
      categories: { ...budgetTargets.categories },
    },
  };
  const parsed = parseSettingsProfile(candidate);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.profile;
}

/** The companion object is separate from the ledger ID and cannot collide with a random vault. */
export async function settingsProfileVaultId(vaultId: string): Promise<string> {
  const candidate = `settings-${vaultId}`;
  if (candidate.length <= 128) return candidate;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(vaultId));
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `settings-${hex.slice(0, 48)}`;
}

interface ProfileSyncRecord {
  baseRevision: number;
  savedAt: string;
}

type ProfileSyncMap = Record<string, ProfileSyncRecord>;

export const SETTINGS_PROFILE_SYNC_KEY = "montecarlo_settings_profile_sync_v1";

function readMap(storage: KeyValueStorage | null): ProfileSyncMap {
  if (!storage) return {};
  try {
    const raw = storage.getItem(SETTINGS_PROFILE_SYNC_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw);
    if (!isObject(parsed)) return {};
    const map: ProfileSyncMap = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!isObject(value)) continue;
      const revision = value.baseRevision;
      const savedAt = value.savedAt;
      if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) continue;
      if (typeof savedAt !== "string") continue;
      map[key] = { baseRevision: revision, savedAt };
    }
    return map;
  } catch {
    return {};
  }
}

export function readSettingsProfileRevision(
  storage: KeyValueStorage | null,
  profileVaultId: string
): ProfileSyncRecord | null {
  return readMap(storage)[profileVaultId] ?? null;
}

export function rememberSettingsProfileRevision(
  storage: KeyValueStorage | null,
  profileVaultId: string,
  baseRevision: number,
  savedAt: string
): boolean {
  if (!storage || !Number.isSafeInteger(baseRevision) || baseRevision < 1) return false;
  const map = readMap(storage);
  map[profileVaultId] = { baseRevision, savedAt };
  try {
    storage.setItem(SETTINGS_PROFILE_SYNC_KEY, JSON.stringify(map));
    return true;
  } catch {
    return false;
  }
}
