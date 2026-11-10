/**
 * Spending targets live beside the ledger, not inside it.
 * They are not forecast inputs and are not written into vault snapshots.
 */

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const BUDGET_TARGETS_KEY = "montecarlo_budget_targets_v1";

export interface BudgetTargets {
  monthlyLimitCents: number | null;
  categories: Record<string, number>;
}

export const EMPTY_TARGETS: BudgetTargets = {
  monthlyLimitCents: null,
  categories: {},
};

function isCents(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseBudgetTargets(raw: string | null): { targets: BudgetTargets; warning: string | null } {
  if (raw === null || raw === "") return { targets: EMPTY_TARGETS, warning: null };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      targets: EMPTY_TARGETS,
      warning: "Saved spending targets could not be read. They were not applied.",
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {
      targets: EMPTY_TARGETS,
      warning: "Saved spending targets were not in a recognized shape. They were not applied.",
    };
  }
  const record = parsed as Record<string, unknown>;
  let monthlyLimitCents: number | null = null;
  if (record.monthlyLimitCents !== null && record.monthlyLimitCents !== undefined) {
    if (!isCents(record.monthlyLimitCents)) {
      return {
        targets: EMPTY_TARGETS,
        warning: "The saved monthly spending target was not a whole number of cents. Targets were not applied.",
      };
    }
    monthlyLimitCents = record.monthlyLimitCents;
  }
  const categories: Record<string, number> = {};
  const source = record.categories;
  if (source !== undefined) {
    if (typeof source !== "object" || source === null || Array.isArray(source)) {
      return {
        targets: EMPTY_TARGETS,
        warning: "Saved category targets were not in a recognized shape. They were not applied.",
      };
    }
    for (const [name, cents] of Object.entries(source)) {
      const trimmed = name.trim();
      if (!trimmed || trimmed.length > 40 || !isCents(cents)) {
        return {
          targets: EMPTY_TARGETS,
          warning: "A saved category target was invalid. Targets were not applied.",
        };
      }
      categories[trimmed] = cents;
    }
  }
  return { targets: { monthlyLimitCents, categories }, warning: null };
}

export function loadBudgetTargets(storage: KeyValueStorage | null): { targets: BudgetTargets; warning: string | null } {
  if (!storage) {
    return { targets: EMPTY_TARGETS, warning: "This browser cannot store spending targets." };
  }
  try {
    return parseBudgetTargets(storage.getItem(BUDGET_TARGETS_KEY));
  } catch {
    return { targets: EMPTY_TARGETS, warning: "Spending targets could not be read from this browser." };
  }
}

export function saveBudgetTargets(
  storage: KeyValueStorage | null,
  targets: BudgetTargets
): { ok: true } | { ok: false; error: string } {
  if (!storage) return { ok: false, error: "This browser cannot store spending targets." };
  const parsed = parseBudgetTargets(JSON.stringify(targets));
  if (parsed.warning) return { ok: false, error: parsed.warning };
  try {
    storage.setItem(BUDGET_TARGETS_KEY, JSON.stringify(parsed.targets));
    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "storage error";
    return { ok: false, error: `Spending targets were not saved (${message}).` };
  }
}
