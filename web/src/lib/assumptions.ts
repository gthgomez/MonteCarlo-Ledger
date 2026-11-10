/**
 * User-facing forecast assumptions. These map onto Contract 2.0 simulation
 * fields. They are not a second model.
 */

export interface Assumptions {
  horizonDays: number;
  runs: number;
  seed: number;
  quantileNum: number;
  quantileDen: number;
  incomeVariationMin: number;
  incomeVariationMax: number;
  expenseVariationMin: number;
  expenseVariationMax: number;
  surpriseProbabilityPpm: number;
  surpriseAmountMin: number;
  surpriseAmountMax: number;
  surpriseIntervalDays: number;
  reserveCents: number;
}

/** Matches the engine defaults used by the previous dashboard. */
export const DEFAULT_ASSUMPTIONS: Assumptions = {
  horizonDays: 90,
  runs: 500,
  seed: 42,
  quantileNum: 1,
  quantileDen: 10,
  incomeVariationMin: -8,
  incomeVariationMax: 8,
  expenseVariationMin: 0,
  expenseVariationMax: 0,
  surpriseProbabilityPpm: 150_000,
  surpriseAmountMin: 2_000,
  surpriseAmountMax: 15_000,
  surpriseIntervalDays: 14,
  reserveCents: 0,
};

export const UI_MAX_RUNS = 2_000;
export const UI_MAX_HORIZON_DAYS = 730;

export function toSimulationConfig(a: Assumptions): Record<string, number> {
  return {
    runs: a.runs,
    seed: a.seed,
    quantile_num: a.quantileNum,
    quantile_den: a.quantileDen,
    income_variation_min: a.incomeVariationMin,
    income_variation_max: a.incomeVariationMax,
    expense_variation_min: a.expenseVariationMin,
    expense_variation_max: a.expenseVariationMax,
    surprise_probability_ppm: a.surpriseProbabilityPpm,
    surprise_amount_min: a.surpriseAmountMin,
    surprise_amount_max: a.surpriseAmountMax,
    surprise_check_interval_days: a.surpriseIntervalDays,
    reserve_cents: a.reserveCents,
  };
}

function intIn(value: number, min: number, max: number): boolean {
  return Number.isInteger(value) && value >= min && value <= max;
}

export function assumptionError(a: Assumptions): string | null {
  if (!intIn(a.horizonDays, 1, UI_MAX_HORIZON_DAYS)) {
    return `The plan window must be between 1 and ${UI_MAX_HORIZON_DAYS} days.`;
  }
  if (!intIn(a.runs, 1, UI_MAX_RUNS)) {
    return `Modeled futures must be between 1 and ${UI_MAX_RUNS} on this screen.`;
  }
  if (!intIn(a.seed, 0, Number.MAX_SAFE_INTEGER)) {
    return "The seed must be a whole number of zero or more.";
  }
  if (!intIn(a.quantileNum, 1, 1_000_000) || !intIn(a.quantileDen, 1, 1_000_000) || a.quantileNum > a.quantileDen) {
    return "The outcome rank must be a fraction between 0 and 1.";
  }
  if (!Number.isInteger(a.incomeVariationMin) || !Number.isInteger(a.incomeVariationMax)) {
    return "Income variation must be a whole-number percent.";
  }
  if (a.incomeVariationMin > a.incomeVariationMax) {
    return "The low end of income variation cannot exceed the high end.";
  }
  if (!Number.isInteger(a.expenseVariationMin) || !Number.isInteger(a.expenseVariationMax)) {
    return "Bill variation must be a whole-number percent.";
  }
  if (a.expenseVariationMin > a.expenseVariationMax) {
    return "The low end of bill variation cannot exceed the high end.";
  }
  if (!intIn(a.surpriseProbabilityPpm, 0, 1_000_000)) {
    return "The unexpected-expense chance must be between 0% and 100%.";
  }
  if (!intIn(a.surpriseAmountMin, 0, Number.MAX_SAFE_INTEGER) || !intIn(a.surpriseAmountMax, 0, Number.MAX_SAFE_INTEGER)) {
    return "Unexpected expense amounts must be whole cents.";
  }
  if (a.surpriseAmountMin > a.surpriseAmountMax) {
    return "The smaller unexpected expense cannot exceed the larger one.";
  }
  if (!intIn(a.surpriseIntervalDays, 1, 365)) {
    return "The unexpected-expense check must be between 1 and 365 days.";
  }
  if (!intIn(a.reserveCents, 0, Number.MAX_SAFE_INTEGER)) {
    return "The reserve must be zero or a positive amount.";
  }
  return null;
}

export function quantilePlainName(num: number, den: number): string {
  if (num * 10 === den) return "more difficult tenth";
  if (num * 2 === den) return "middle";
  if (num * 10 === den * 9) return "more favorable tenth";
  return `nearest-rank ${num}/${den}`;
}

export function safeSpendTechnicalName(num: number, den: number): string {
  if (num === 1 && den === 10) return "Safe to Spend (P10)";
  return `Safe to spend (nearest-rank ${num}/${den})`;
}
