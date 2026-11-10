import { runScenario, timelineRows, type TimelineRow } from "../contract/engine";
import { ContractError } from "../contract/money";
import { Assumptions, assumptionError, toSimulationConfig } from "./assumptions";
import { addDaysIso, isIsoDate } from "./dates";
import { buildScenarioFromLedger } from "./scenario-builder";
import { LedgerState } from "./types";

export interface ModelOutcome {
  safeSpendCents: number;
  overdraftPpm: number;
  minimumBalanceP10Cents: number;
  minimumBalanceP50Cents: number;
  minimumBalanceP90Cents: number;
  endingBalanceP10Cents: number;
  endingBalanceP50Cents: number;
  endingBalanceP90Cents: number;
  projectedLowCents: number;
  projectedLowDate: string;
  endingBalanceCents: number;
  firstNegativeDate: string | null;
  reserveCents: number;
  quantileNum: number;
  quantileDen: number;
  runs: number;
  seed: number;
  horizonDays: number;
  startingBalanceCents: number;
  scenarioId: string;
}

export type EvalResult =
  | { status: "ok"; outcome: ModelOutcome; rows: TimelineRow[] }
  | { status: "error"; code: string; message: string };

function fail(code: string, message: string): EvalResult {
  return { status: "error", code, message };
}

function fromThrown(err: unknown): EvalResult {
  const code = err instanceof ContractError ? err.code : "UNKNOWN_ERROR";
  const message = err instanceof Error ? err.message : String(err);
  return fail(code, message);
}

function outcomeFrom(raw: any, assumptions: Assumptions, scenario: any): ModelOutcome {
  return {
    safeSpendCents: raw.risk.safe_to_spend_cents,
    overdraftPpm: raw.risk.negative_balance_probability_ppm,
    minimumBalanceP10Cents: raw.risk.minimum_balance_p10_cents,
    minimumBalanceP50Cents: raw.risk.minimum_balance_p50_cents,
    minimumBalanceP90Cents: raw.risk.minimum_balance_p90_cents,
    endingBalanceP10Cents: raw.risk.ending_balance_p10_cents,
    endingBalanceP50Cents: raw.risk.ending_balance_p50_cents,
    endingBalanceP90Cents: raw.risk.ending_balance_p90_cents,
    projectedLowCents: raw.forecast.minimum_balance_cents,
    projectedLowDate: raw.forecast.minimum_balance_date,
    endingBalanceCents: raw.forecast.ending_balance_cents,
    firstNegativeDate: raw.forecast.first_negative_date,
    reserveCents: assumptions.reserveCents,
    quantileNum: assumptions.quantileNum,
    quantileDen: assumptions.quantileDen,
    runs: assumptions.runs,
    seed: assumptions.seed,
    horizonDays: assumptions.horizonDays,
    startingBalanceCents: scenario.starting_balance_cents,
    scenarioId: String(scenario.scenario_id ?? ""),
  };
}

function runBuilt(scenario: any, assumptions: Assumptions): EvalResult {
  try {
    const raw = runScenario(scenario);
    if (!raw.risk || !raw.forecast) {
      return fail("UNKNOWN_ERROR", "The engine returned a result without a forecast.");
    }
    const rows = timelineRows(scenario);
    return { status: "ok", outcome: outcomeFrom(raw, assumptions, scenario), rows };
  } catch (err) {
    return fromThrown(err);
  }
}

export function evaluateLedger(state: LedgerState, asOf: string, assumptions: Assumptions): EvalResult {
  const problem = assumptionError(assumptions);
  if (problem) return fail("INVALID_ASSUMPTIONS", problem);
  if (!isIsoDate(asOf)) return fail("INVALID_DATE", asOf);
  try {
    const scenario = buildScenarioFromLedger(
      state,
      asOf,
      assumptions.horizonDays,
      toSimulationConfig(assumptions)
    );
    return runBuilt(scenario, assumptions);
  } catch (err) {
    return fromThrown(err);
  }
}

export function evaluatePurchase(
  state: LedgerState,
  asOf: string,
  assumptions: Assumptions,
  amountCents: number,
  date: string
): EvalResult {
  const problem = assumptionError(assumptions);
  if (problem) return fail("INVALID_ASSUMPTIONS", problem);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return fail("INVALID_AMOUNT", "Purchase amount must be positive integer cents.");
  }
  if (!isIsoDate(date)) return fail("INVALID_DATE", date);
  const windowEnd = addDaysIso(asOf, assumptions.horizonDays);
  if (date < asOf || date >= windowEnd) {
    return fail("EVENT_OUT_OF_HORIZON", "Purchase date is outside the horizon.");
  }
  try {
    const scenario = buildScenarioFromLedger(
      state,
      asOf,
      assumptions.horizonDays,
      toSimulationConfig(assumptions)
    );
    const cloned = JSON.parse(JSON.stringify(scenario));
    cloned.events.push({
      date,
      amount_cents: -amountCents,
      type: "expense",
      name: "Simulated Purchase",
    });
    return runBuilt(cloned, assumptions);
  } catch (err) {
    return fromThrown(err);
  }
}

export function evaluateIncomeDelay(
  state: LedgerState,
  asOf: string,
  assumptions: Assumptions,
  delayDays: number
): EvalResult {
  const problem = assumptionError(assumptions);
  if (problem) return fail("INVALID_ASSUMPTIONS", problem);
  if (!Number.isInteger(delayDays) || delayDays <= 0) {
    return fail("INVALID_HORIZON", "Delay must be a positive number of days.");
  }
  try {
    const scenario = buildScenarioFromLedger(
      state,
      asOf,
      assumptions.horizonDays,
      toSimulationConfig(assumptions)
    );
    const cloned = JSON.parse(JSON.stringify(scenario));
    const incomes = cloned.events
      .filter((event: { type: string }) => event.type === "income")
      .sort((a: { date: string }, b: { date: string }) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (incomes.length === 0) {
      return fail("NO_INCOME", "No paycheck is scheduled in this window.");
    }
    const target = incomes[0];
    const index = cloned.events.indexOf(target);
    cloned.events[index] = {
      ...target,
      date: addDaysIso(target.date, delayDays),
    };
    return runBuilt(cloned, assumptions);
  } catch (err) {
    return fromThrown(err);
  }
}

export function evaluateBillAmount(
  state: LedgerState,
  asOf: string,
  assumptions: Assumptions,
  paymentId: string,
  amountCents: number
): EvalResult {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return fail("INVALID_AMOUNT", "Bill amount must be positive integer cents.");
  }
  const next = JSON.parse(JSON.stringify(state)) as LedgerState;
  const payment = next.payments.find((item) => String(item.id) === paymentId);
  if (!payment) return fail("PAYMENT_NOT_FOUND", paymentId);
  payment.amount_cents = amountCents;
  return evaluateLedger(next, asOf, assumptions);
}

/**
 * Models money leaving the account on a monthly due day.
 * It does not create a separate savings balance.
 */
export function evaluateMonthlySetAside(
  state: LedgerState,
  asOf: string,
  assumptions: Assumptions,
  amountCents: number
): EvalResult {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return fail("INVALID_AMOUNT", "The amount set aside must be positive integer cents.");
  }
  const next = JSON.parse(JSON.stringify(state)) as LedgerState;
  const dueDay = Number(asOf.split("-")[2]);
  next.payments = [
    ...next.payments,
    {
      id: "hypothetical-set-aside",
      name: "Amount set aside",
      amount_cents: amountCents,
      due_day: dueDay,
      recurrence: "Monthly",
      is_auto_withdraw: false,
    },
  ];
  return evaluateLedger(next, asOf, assumptions);
}
