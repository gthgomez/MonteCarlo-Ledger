/**
 * Pure, clock-free reference engine for MonteCarlo Contract 1.0 - 2.0.
 * Bit-for-bit conformant with Python reference engine.
 */

import { amortize, validateLiabilities } from "./debt";
import {
  checkedAdd,
  ContractError,
  roundHalfAway,
  scaleCentsByPercent,
} from "./money";
import { SplitMix64 } from "./prng";

export const CONTRACT_VERSION = "2.0";
export const SUPPORTED_CONTRACT_VERSIONS = ["1.0", "1.1", "1.2", "2.0"] as const;
const MAX_OCCURRENCES = 100000;
const MONTH_STEPS: Record<string, number> = {
  monthly: 1,
  bimonthly: 2,
  quarterly: 3,
  semiannually: 6,
  annually: 12,
};
const FREQUENCIES = new Set([
  "weekly",
  "biweekly",
  "semimonthly",
  "monthly",
  "bimonthly",
  "quarterly",
  "semiannually",
  "annually",
  "onetime",
]);

export const SIMULATION_DEFAULTS = {
  runs: 500,
  seed: 42,
  income_variation_min: -8,
  income_variation_max: 8,
  expense_variation_min: 0,
  expense_variation_max: 0,
  surprise_probability_ppm: 150000,
  surprise_check_interval_days: 14,
  surprise_amount_min: 2000,
  surprise_amount_max: 15000,
  quantile_num: 1,
  quantile_den: 10,
  reserve_cents: 0,
};

function parseDate(value: any, code: string = "INVALID_DATE"): Date {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ContractError(code, String(value));
  }
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (
    date.getUTCFullYear() !== y ||
    date.getUTCMonth() !== m - 1 ||
    date.getUTCDate() !== d
  ) {
    throw new ContractError(code, value);
  }
  return date;
}

function formatDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86400000);
}

function lastDayOfMonth(year: number, month1Indexed: number): number {
  return new Date(Date.UTC(year, month1Indexed, 0)).getUTCDate();
}

function validateEvent(ev: any): void {
  const amount = ev.amount_cents;
  const etype = ev.type;
  if (typeof amount !== "number" || !Number.isInteger(amount)) {
    throw new ContractError("INVALID_AMOUNT", String(amount));
  }
  if (etype === "income" && amount <= 0) {
    throw new ContractError("INVALID_AMOUNT", `income ${amount}`);
  }
  if (etype === "expense" && amount >= 0) {
    throw new ContractError("INVALID_AMOUNT", `expense ${amount}`);
  }
  if (etype === "adjustment" && amount === 0) {
    throw new ContractError("INVALID_AMOUNT", "zero adjustment");
  }
  if (!["income", "expense", "adjustment"].includes(etype)) {
    throw new ContractError("INVALID_EVENT_TYPE", String(etype));
  }
}

function validateRecurrence(rec: any): void {
  const rtype = rec.type;
  const amount = rec.amount_cents;
  if (typeof amount !== "number" || !Number.isInteger(amount)) {
    throw new ContractError("INVALID_AMOUNT", String(amount));
  }
  if (rtype === "income" && amount <= 0) {
    throw new ContractError("INVALID_AMOUNT", `income ${amount}`);
  }
  if (rtype === "expense" && amount >= 0) {
    throw new ContractError("INVALID_AMOUNT", `expense ${amount}`);
  }
  if (!["income", "expense"].includes(rtype)) {
    throw new ContractError("INVALID_EVENT_TYPE", String(rtype));
  }
  if (!FREQUENCIES.has(rec.frequency)) {
    throw new ContractError("INVALID_FREQUENCY", String(rec.frequency));
  }
}

function contractVersion(scenario: any): string {
  const v = scenario.contract_version ?? CONTRACT_VERSION;
  if (!SUPPORTED_CONTRACT_VERSIONS.includes(v)) {
    throw new ContractError("SCHEMA_INVALID", `unsupported contract_version '${v}'`);
  }
  return v;
}

function getExclusions(scenario: any, version: string): Set<string> {
  if ("occurrence_exclusions" in scenario && version === "1.0") {
    throw new ContractError("SCHEMA_INVALID", "occurrence_exclusions requires contract_version 1.1");
  }
  const result = new Set<string>();
  for (const item of scenario.occurrence_exclusions ?? []) {
    if (typeof item !== "object" || item === null) {
      throw new ContractError("SCHEMA_INVALID", "occurrence_exclusions item must be an object");
    }
    const rid = item.recurrence_id;
    const raw = item.date;
    if (typeof rid !== "string" || typeof raw !== "string") {
      throw new ContractError("SCHEMA_INVALID", "occurrence exclusion requires recurrence_id and date");
    }
    result.add(`${rid}::${formatDate(parseDate(raw))}`);
  }
  return result;
}

function getOccurrences(rec: any, ceiling: Date): Date[] {
  const freq = rec.frequency;
  const start = parseDate(rec.start_date);
  const anchor = rec.anchor_day ? Number(rec.anchor_day) : start.getUTCDate();
  const end = rec.end_date ? parseDate(rec.end_date) : null;

  const stop = (d: Date) => d.getTime() >= ceiling.getTime() || (end !== null && d.getTime() > end.getTime());
  const out: Date[] = [];

  if (freq === "onetime") {
    return !stop(start) ? [start] : [];
  }
  if (freq === "weekly" || freq === "biweekly") {
    const stepDays = freq === "weekly" ? 7 : 14;
    let d = start;
    while (!stop(d) && out.length < MAX_OCCURRENCES) {
      out.push(d);
      d = addDays(d, stepDays);
    }
    return out;
  }
  if (freq === "semimonthly") {
    let year = start.getUTCFullYear();
    let month = start.getUTCMonth() + 1;
    while (out.length < MAX_OCCURRENCES) {
      const last = lastDayOfMonth(year, month);
      const days = anchor < 15 ? [1, 15] : [15, last];
      for (const day of days) {
        const d = new Date(Date.UTC(year, month - 1, Math.min(day, last)));
        if (d.getTime() < start.getTime()) continue;
        if (stop(d)) return out;
        out.push(d);
      }
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
      if (stop(new Date(Date.UTC(year, month - 1, 1)))) {
        return out;
      }
    }
    return out;
  }
  if (freq === "annually" || freq in MONTH_STEPS) {
    const step = MONTH_STEPS[freq] ?? 12;
    let year = start.getUTCFullYear();
    let month = start.getUTCMonth() + 1;
    while (out.length < MAX_OCCURRENCES) {
      const last = lastDayOfMonth(year, month);
      const d = new Date(Date.UTC(year, month - 1, Math.min(anchor, last)));
      if (stop(d)) return out;
      if (d.getTime() >= start.getTime()) {
        out.push(d);
      }
      month += step;
      year += Math.floor((month - 1) / 12);
      month = ((month - 1) % 12) + 1;
    }
    return out;
  }
  throw new ContractError("INVALID_FREQUENCY", freq);
}

export interface InternalEvent {
  date: Date;
  amount: bigint;
  type: string;
  sequence: number;
  order: number;
  name: string;
  category?: string;
}

export function expand(scenario: any): {
  events: InternalEvent[];
  asOf: Date;
  horizon: number;
  windowEnd: Date;
} {
  if (!("as_of" in scenario)) {
    throw new ContractError("MISSING_AS_OF");
  }
  const asOf = parseDate(scenario.as_of);
  const horizon = scenario.horizon_days;
  if (typeof horizon !== "number" || !Number.isInteger(horizon) || horizon < 0) {
    throw new ContractError("INVALID_HORIZON", String(horizon));
  }
  const version = contractVersion(scenario);
  const exclusions = getExclusions(scenario, version);
  const windowEnd = addDays(asOf, horizon);

  const events: InternalEvent[] = [];
  let order = 0;

  for (let index = 0; index < (scenario.events ?? []).length; index++) {
    const ev = scenario.events[index];
    validateEvent(ev);
    const d = parseDate(ev.date);
    const seq = ev.sequence ?? (ev.type === "income" ? 0 : 1);
    if (d.getTime() < asOf.getTime() || d.getTime() >= windowEnd.getTime()) {
      order = index + 1;
      continue;
    }
    events.push({
      date: d,
      amount: BigInt(ev.amount_cents),
      type: ev.type,
      sequence: seq,
      order: index,
      name: ev.name ?? "",
      category: ev.category,
    });
    order = index + 1;
  }

  for (const rec of scenario.recurrences ?? []) {
    validateRecurrence(rec);
    const recId = rec.id;
    let firstInWindow = true;
    for (const d of getOccurrences(rec, windowEnd)) {
      if (d.getTime() < asOf.getTime() || d.getTime() >= windowEnd.getTime()) {
        continue;
      }
      const key = `${recId}::${formatDate(d)}`;
      if (exclusions.has(key)) {
        continue;
      }
      let amount = BigInt(rec.amount_cents);
      if (firstInWindow && rec.type === "income" && "expected_amount_cents" in rec) {
        amount = BigInt(rec.expected_amount_cents);
      }
      firstInWindow = false;
      events.push({
        date: d,
        amount,
        type: rec.type,
        sequence: rec.type === "income" ? 0 : 1,
        order,
        name: rec.name ?? rec.id ?? "",
        category: rec.category,
      });
      order += 1;
    }
  }

  return { events, asOf, horizon, windowEnd };
}

export function sortEvents(events: InternalEvent[]): InternalEvent[] {
  return [...events].sort((a, b) => {
    const timeDiff = a.date.getTime() - b.date.getTime();
    if (timeDiff !== 0) return timeDiff;
    const seqDiff = a.sequence - b.sequence;
    if (seqDiff !== 0) return seqDiff;
    return a.order - b.order;
  });
}

export function forecast(start: bigint, asOf: Date, ordered: InternalEvent[]): any {
  let balance = start;
  let minimum = start;
  let minimumDate = asOf;
  let firstNegative: string | null = start < 0n ? formatDate(asOf) : null;
  let ending = start;

  for (const ev of ordered) {
    balance = checkedAdd(balance, ev.amount);
    ending = balance;
    if (balance < minimum) {
      minimum = balance;
      minimumDate = ev.date;
    }
    if (firstNegative === null && balance < 0n) {
      firstNegative = formatDate(ev.date);
    }
  }

  return {
    minimum_balance_cents: Number(minimum),
    minimum_balance_date: formatDate(minimumDate),
    ending_balance_cents: Number(ending),
    first_negative_date: firstNegative,
  };
}

export function nearestRank(sortedValues: number[], num: number, den: number): number {
  const n = sortedValues.length;
  let idx = Math.floor((n * num + den - 1) / den) - 1;
  idx = Math.max(0, Math.min(idx, n - 1));
  return sortedValues[idx];
}

function parseCategoryRanges(raw: any): Map<string, [number, number]> {
  const result = new Map<string, [number, number]>();
  if (!raw) return result;
  if (!Array.isArray(raw)) {
    throw new ContractError("SCHEMA_INVALID", "expense_category_variation must be an array");
  }
  for (const item of raw) {
    if (typeof item !== "object" || item === null) {
      throw new ContractError("SCHEMA_INVALID", "expense_category_variation item must be an object");
    }
    const cat = item.category;
    const lo = item.min;
    const hi = item.max;
    if (typeof cat !== "string") {
      throw new ContractError("SCHEMA_INVALID", "expense_category_variation.category must be a string");
    }
    if (typeof lo !== "number" || !Number.isInteger(lo) || typeof hi !== "number" || !Number.isInteger(hi)) {
      throw new ContractError("SCHEMA_INVALID", "expense_category_variation min/max must be integers");
    }
    if (lo > hi) {
      throw new ContractError("SCHEMA_INVALID", `expense_category_variation '${cat}': min > max`);
    }
    if (result.has(cat)) {
      throw new ContractError("SCHEMA_INVALID", `duplicate expense_category_variation category '${cat}'`);
    }
    result.set(cat, [lo, hi]);
  }
  return result;
}

function simulateOnce(
  base: InternalEvent[],
  start: bigint,
  asOf: Date,
  horizon: number,
  windowEnd: Date,
  p: any,
  rng: SplitMix64
): any {
  const scenario: InternalEvent[] = base.map((e) => ({ ...e }));
  const imin = p.income_variation_min;
  const imax = p.income_variation_max;
  const emin = p.expense_variation_min;
  const emax = p.expense_variation_max;
  const categoryRanges: Map<string, [number, number]> = p.expense_category_variation;

  for (const ev of scenario) {
    if (ev.type === "income") {
      if (imin !== 0 || imax !== 0) {
        const pct = BigInt(rng.nextInt(imin, imax));
        const scaled = scaleCentsByPercent(ev.amount, pct);
        ev.amount = scaled > 0n ? scaled : 0n;
      }
    } else {
      const cat = ev.category;
      const matched = typeof cat === "string" ? categoryRanges.get(cat) : undefined;
      if (matched !== undefined) {
        const pct = BigInt(rng.nextInt(matched[0], matched[1]));
        const scaled = scaleCentsByPercent(ev.amount, pct);
        ev.amount = scaled < 0n ? scaled : 0n;
      } else if (emin !== 0 || emax !== 0) {
        const pct = BigInt(rng.nextInt(emin, emax));
        const scaled = scaleCentsByPercent(ev.amount, pct);
        ev.amount = scaled < 0n ? scaled : 0n;
      }
    }
  }

  const interval = p.surprise_check_interval_days;
  const checks = Math.floor(horizon / interval);
  for (let i = 0; i < checks; i++) {
    if (rng.nextPpmHit(p.surprise_probability_ppm)) {
      const offset = i * interval + rng.nextInt(0, interval - 1);
      const d = addDays(asOf, offset);
      if (d.getTime() < windowEnd.getTime()) {
        const amount = -BigInt(rng.nextInt(p.surprise_amount_min, p.surprise_amount_max));
        scenario.push({
          date: d,
          amount,
          type: "expense",
          sequence: 1,
          order: base.length + i,
          name: "Unexpected Expense",
        });
      }
    }
  }

  return forecast(start, asOf, sortEvents(scenario));
}

export function runScenario(scenario: any): any {
  const { events, asOf, horizon, windowEnd } = expand(scenario);
  const base = sortEvents(events);
  const start = BigInt(scenario.starting_balance_cents);

  const result: any = {
    contract_version: scenario.contract_version ?? CONTRACT_VERSION,
    scenario_id: scenario.scenario_id ?? "",
    forecast: forecast(start, asOf, base),
  };

  if ("liabilities" in scenario) {
    validateLiabilities(scenario.liabilities);
    result.debt = amortize(
      formatDate(asOf),
      scenario.liabilities,
      scenario.debt_strategy ?? "snowball",
      scenario.extra_monthly_payment_cents ?? 0
    );
  }

  const simConfig = scenario.simulation;
  if (!simConfig) {
    return result;
  }

  const p: any = { ...SIMULATION_DEFAULTS, ...simConfig };
  if (typeof p.runs !== "number" || p.runs < 1) {
    throw new ContractError("INVALID_RUNS", String(p.runs));
  }
  if (p.surprise_check_interval_days < 1) {
    throw new ContractError("INVALID_HORIZON", "check interval");
  }
  p.expense_category_variation = parseCategoryRanges(p.expense_category_variation);

  const rng = new SplitMix64(p.seed);
  const endings: number[] = [];
  const minimums: number[] = [];
  let negativeRuns = 0;

  for (let r = 0; r < p.runs; r++) {
    const outcome = simulateOnce(base, start, asOf, horizon, windowEnd, p, rng);
    endings.push(outcome.ending_balance_cents);
    minimums.push(outcome.minimum_balance_cents);
    if (outcome.first_negative_date !== null) {
      negativeRuns++;
    }
  }

  endings.sort((a, b) => a - b);
  minimums.sort((a, b) => a - b);

  const pct = (arr: number[], num: number, den: number) => nearestRank(arr, num, den);

  result.risk = {
    negative_balance_probability_ppm: Number(roundHalfAway(BigInt(negativeRuns) * 1000000n, BigInt(p.runs))),
    minimum_balance_p10_cents: pct(minimums, 1, 10),
    minimum_balance_p50_cents: pct(minimums, 1, 2),
    minimum_balance_p90_cents: pct(minimums, 9, 10),
    ending_balance_p10_cents: pct(endings, 1, 10),
    ending_balance_p50_cents: pct(endings, 1, 2),
    ending_balance_p90_cents: pct(endings, 9, 10),
    projected_low_point_cents: result.forecast.minimum_balance_cents,
    safe_to_spend_cents: pct(minimums, p.quantile_num, p.quantile_den) - p.reserve_cents,
  };

  return result;
}

export function runScenarioSafe(scenario: any): any {
  try {
    return runScenario(scenario);
  } catch (err: any) {
    return { error: err.code ?? "UNKNOWN_ERROR" };
  }
}
