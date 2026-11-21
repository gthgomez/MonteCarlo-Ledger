import { assumptionError, DEFAULT_ASSUMPTIONS, type Assumptions } from "./assumptions";

/** Stable key; the payload carries its own schema version. */
export const ASSUMPTIONS_STORAGE_KEY = "montecarlo_financial_assumptions";

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

export function saveAssumptions(
  storage: AssumptionsStorage | null,
  assumptions: Assumptions
): { ok: true } | { ok: false; error: string } {
  if (!storage) return { ok: false, error: "This browser cannot save financial settings." };
  if (assumptionError(assumptions)) {
    return { ok: false, error: "These financial settings are invalid and were not saved." };
  }

  const encoded = JSON.stringify({ schemaVersion: 1, values: assumptions });
  const validated = parseSavedAssumptions(encoded);
  if (!validated.ok) return { ok: false, error: "These financial settings could not be validated for saving." };

  let previous: string | null;
  try {
    previous = storage.getItem(ASSUMPTIONS_STORAGE_KEY);
  } catch {
    return { ok: false, error: "The previous financial settings could not be checked, so no change was applied." };
  }

  let writeFailed = false;
  try {
    storage.setItem(ASSUMPTIONS_STORAGE_KEY, encoded);
  } catch {
    writeFailed = true;
  }

  let current: string | null;
  try {
    current = storage.getItem(ASSUMPTIONS_STORAGE_KEY);
  } catch {
    return { ok: false, error: "Financial settings could not be confirmed after saving. Reload before using the forecast." };
  }

  if (current === encoded && !writeFailed) return { ok: true };
  if (current !== encoded && current !== previous) {
    return {
      ok: false,
      error: "Financial settings changed in another tab while saving. Reload to use the latest settings.",
    };
  }

  if (current === encoded) {
    // localStorage updates one key atomically. This rollback also protects
    // adapters and test doubles that report a failure after writing.
    try {
      if (previous === null) storage.removeItem(ASSUMPTIONS_STORAGE_KEY);
      else storage.setItem(ASSUMPTIONS_STORAGE_KEY, previous);
    } catch {
      // The caller must withhold the forecast until settings can be read again.
    }
  }
  return { ok: false, error: "Financial settings could not be saved. The previous saved settings were kept when possible." };
}
