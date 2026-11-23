import { assumptionError, DEFAULT_ASSUMPTIONS, type Assumptions } from "./assumptions";
import {
  defaultLedgerLockManager,
  type LedgerLockManager,
} from "./persistence";

/** Stable key; the payload carries its own schema version. */
export const ASSUMPTIONS_STORAGE_KEY = "montecarlo_financial_assumptions";

/**
 * Separate shared-origin lock for financial settings. It is deliberately not the
 * ledger lock: settings writes must never queue behind or block ledger recovery,
 * and ledger writes must not be serialized with an unrelated settings edit.
 */
export const ASSUMPTIONS_LOCK_NAME = "montecarlo-financial-settings-write";

export interface AssumptionsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type AssumptionsLoadResult =
  | {
      ok: true;
      assumptions: Assumptions;
      migrated: boolean;
      warning: string | null;
      raw: string | null;
    }
  | { ok: false; error: string; raw: string | null };

const ASSUMPTION_KEYS: (keyof Assumptions)[] = [
  "horizonDays",
  "runs",
  "seed",
  "quantileNum",
  "quantileDen",
  "incomeVariationMin",
  "incomeVariationMax",
  "expenseVariationMin",
  "expenseVariationMax",
  "surpriseProbabilityPpm",
  "surpriseAmountMin",
  "surpriseAmountMax",
  "surpriseIntervalDays",
  "reserveCents",
];

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function parseValues(value: unknown): Assumptions | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, ASSUMPTION_KEYS)) return null;
  for (const key of ASSUMPTION_KEYS) {
    if (typeof record[key] !== "number" || !Number.isSafeInteger(record[key])) return null;
  }
  const assumptions = record as unknown as Assumptions;
  return assumptionError(assumptions) === null ? assumptions : null;
}

/**
 * Schema v1 is an envelope containing every current assumption. The only
 * supported migration is the exact unversioned Assumptions object used by
 * early local builds. Unknown versions and extra fields fail closed.
 */
export function parseSavedAssumptions(raw: string | null): AssumptionsLoadResult {
  if (raw === null) {
    return {
      ok: true,
      assumptions: { ...DEFAULT_ASSUMPTIONS },
      migrated: false,
      warning: null,
      raw: null,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Saved financial settings are not valid JSON.", raw };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "Saved financial settings have an unrecognized format.", raw };
  }

  const record = parsed as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(record, "schemaVersion")) {
    const legacy = parseValues(record);
    if (!legacy) {
      return { ok: false, error: "Saved financial settings are incomplete or invalid.", raw };
    }
    return {
      ok: true,
      assumptions: legacy,
      migrated: true,
      warning: "Older financial settings were loaded. They will be saved in the current format when possible.",
      raw,
    };
  }

  if (record.schemaVersion !== 1) {
    return {
      ok: false,
      error: `Financial settings use unsupported schema version ${String(record.schemaVersion)}.`,
      raw,
    };
  }
  if (!hasExactKeys(record, ["schemaVersion", "values"])) {
    return { ok: false, error: "Saved financial settings contain unrecognized fields.", raw };
  }
  const assumptions = parseValues(record.values);
  if (!assumptions) {
    return { ok: false, error: "Saved financial settings are incomplete or invalid.", raw };
  }
  return { ok: true, assumptions, migrated: false, warning: null, raw };
}

export function loadAssumptions(storage: AssumptionsStorage | null): AssumptionsLoadResult {
  if (!storage) {
    return { ok: false, error: "Financial settings could not be read because browser storage is unavailable.", raw: null };
  }
  try {
    return parseSavedAssumptions(storage.getItem(ASSUMPTIONS_STORAGE_KEY));
  } catch {
    return { ok: false, error: "Financial settings could not be read from this browser.", raw: null };
  }
}

export type AssumptionsSaveResult =
  | { ok: true; raw: string }
  | { ok: false; reason: "failed" | "unreadable" | "indeterminate"; error: string }
  | { ok: false; reason: "conflict"; error: string; raw: string | null };

const PREVIOUS_UNREADABLE =
  "The previous financial settings could not be checked, so no change was applied.";
const INVALID_SETTINGS = "These financial settings are invalid and were not saved.";
const INVALID_FOR_SAVING = "These financial settings could not be validated for saving.";
const LOCK_UNAVAILABLE =
  "This browser cannot lock financial settings across tabs, so no change was saved.";
const LOCK_FAILED =
  "Financial settings could not be locked for a safe save. No change was saved.";
const CONFLICT =
  "Financial settings changed in another tab. Review the saved values before retrying; this edit was not applied.";
const WRITE_FAILED =
  "Financial settings could not be saved. The previous saved settings were verified and kept.";
const POST_WRITE_UNVERIFIED =
  "Financial settings could not be confirmed after writing. Some or all of the change may have persisted.";
const ROLLBACK_UNVERIFIED =
  "The previous financial settings could not be verified after a write failed. Some or all of the change may have persisted.";

/**
 * Restore the exact previous bytes after a write reported failure, then follow
 * what is actually durable. A rollback adapter may throw after restoring, so the
 * read after the attempt decides between a clean failure and an indeterminate one.
 */
function rollbackFailedWrite(
  storage: AssumptionsStorage,
  previous: string | null
): AssumptionsSaveResult {
  try {
    if (previous === null) storage.removeItem(ASSUMPTIONS_STORAGE_KEY);
    else storage.setItem(ASSUMPTIONS_STORAGE_KEY, previous);
  } catch {
    // Deliberately keep going: the rollback can throw after restoring the bytes.
  }

  let durable: string | null;
  try {
    durable = storage.getItem(ASSUMPTIONS_STORAGE_KEY);
  } catch {
    return { ok: false, reason: "indeterminate", error: ROLLBACK_UNVERIFIED };
  }

  if (durable === previous) {
    return { ok: false, reason: "failed", error: WRITE_FAILED };
  }
  // The proposed bytes may still be durable, or a noncooperating writer may have
  // replaced them after our rollback attempt. Do not overwrite either result.
  return { ok: false, reason: "indeterminate", error: ROLLBACK_UNVERIFIED };
}

/**
 * Compare and write while the settings lock is held. The durable raw value is
 * re-read inside the lock, including the null case, so an edit authorized against
 * an earlier rendered snapshot cannot replace another tab's newer settings.
 */
function saveLocked(
  storage: AssumptionsStorage,
  encoded: string,
  expectedRaw: string | null
): AssumptionsSaveResult {
  let current: string | null;
  try {
    current = storage.getItem(ASSUMPTIONS_STORAGE_KEY);
  } catch {
    return { ok: false, reason: "unreadable", error: PREVIOUS_UNREADABLE };
  }

  if (current !== expectedRaw) {
    // A conflict before the write must leave the observed value untouched.
    return { ok: false, reason: "conflict", error: CONFLICT, raw: current };
  }

  let writeFailed = false;
  try {
    storage.setItem(ASSUMPTIONS_STORAGE_KEY, encoded);
  } catch {
    // A storage adapter can report failure after writing. Verify before deciding.
    writeFailed = true;
  }

  let durable: string | null;
  try {
    durable = storage.getItem(ASSUMPTIONS_STORAGE_KEY);
  } catch {
    return { ok: false, reason: "indeterminate", error: POST_WRITE_UNVERIFIED };
  }

  if (!writeFailed && durable === encoded) return { ok: true, raw: encoded };
  if (durable === expectedRaw) {
    // The write did not change the stored bytes; the previous settings are intact.
    return { ok: false, reason: "failed", error: WRITE_FAILED };
  }
  if (durable === encoded) return rollbackFailedWrite(storage, expectedRaw);

  // Another writer replaced the value observed in this critical section. Leave it
  // alone rather than overwriting or rolling back a noncooperating external value.
  return { ok: false, reason: "conflict", error: CONFLICT, raw: durable };
}

/**
 * Save validated financial settings after proving the caller rendered the exact
 * durable snapshot. Settings need the Web Locks API: there is no lock-bypass
 * fallback for a mutation, unlike ordinary ledger edits. When the lock is absent
 * or fails, nothing is written.
 */
export async function saveAssumptions(
  storage: AssumptionsStorage | null,
  assumptions: Assumptions,
  expectedRaw: string | null,
  locks: LedgerLockManager | null = defaultLedgerLockManager()
): Promise<AssumptionsSaveResult> {
  if (!storage) return { ok: false, reason: "unreadable", error: PREVIOUS_UNREADABLE };
  if (assumptionError(assumptions)) {
    return { ok: false, reason: "failed", error: INVALID_SETTINGS };
  }

  const encoded = JSON.stringify({ schemaVersion: 1, values: assumptions });
  const validated = parseSavedAssumptions(encoded);
  if (!validated.ok) return { ok: false, reason: "failed", error: INVALID_FOR_SAVING };

  if (!locks) return { ok: false, reason: "failed", error: LOCK_UNAVAILABLE };

  try {
    return await locks.request(
      ASSUMPTIONS_LOCK_NAME,
      { mode: "exclusive" },
      () => saveLocked(storage, encoded, expectedRaw)
    );
  } catch {
    // Once a lock manager exists, no settings write may bypass it on failure.
    return { ok: false, reason: "failed", error: LOCK_FAILED };
  }
}
