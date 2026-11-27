import {
  expand, runScenario, runScenarioWithFixedEvents, sortEvents, timelineRows, type TimelineRow,
} from "../contract/engine";
import { ContractError } from "../contract/money";
import { Assumptions, assumptionError, toSimulationConfig } from "./assumptions";
import { addDaysIso, isIsoDate } from "./dates";
import {
  buildScenarioFromLedger,
  debtMinimumsFromEvents,
  fixedEventOrders,
  ledgerEventSource,
  sortScenarioEvents,
  type LedgerEventSource,
  type LedgerScenarioEvent,
  type ProjectedDebtMinimum,
} from "./scenario-builder";
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

export interface EvaluatedTimelineRow extends TimelineRow {
  source?: LedgerEventSource;
}

export type EvalResult =
  | { status: "ok"; outcome: ModelOutcome; rows: EvaluatedTimelineRow[]; debtMinimums: ProjectedDebtMinimum[] }
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

function runBuilt(
  scenario: any,
  assumptions: Assumptions,
  fixedOrders?: ReadonlySet<number>
): EvalResult {
  try {
    const raw = fixedOrders === undefined
      ? runScenario(scenario)
      : runScenarioWithFixedEvents(scenario, fixedOrders);
    if (!raw.risk || !raw.forecast) {
      return fail("UNKNOWN_ERROR", "The engine returned a result without a forecast.");
    }
    // Engine order identifies each explicit event even when its displayed values
    // are identical to those of another source, or a what-if changes its date.
    const orderedEvents: LedgerScenarioEvent[] = sortEvents(expand(scenario).events)
      .map(({ order }) => scenario.events[order]);
    const rows = timelineRows(scenario).map((row, index): EvaluatedTimelineRow => {
      const source = ledgerEventSource(orderedEvents[index]);
      return source ? { ...row, source } : row;
    });
    return {
      status: "ok",
      outcome: outcomeFrom(raw, assumptions, scenario),
      rows,
      debtMinimums: debtMinimumsFromEvents(orderedEvents),
    };
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
  return evaluateDatedOutflow(state, asOf, assumptions, amountCents, date, "Simulated Purchase");
}

/** Adds just the proposed cash outflow. It does not rewrite a liability or its future minimums. */
export function evaluateExtraDebtPayment(
  state: LedgerState,
  asOf: string,
  assumptions: Assumptions,
  amountCents: number,
  date: string
): EvalResult {
  return evaluateDatedOutflow(state, asOf, assumptions, amountCents, date, "Extra debt payment");
}

function evaluateDatedOutflow(
  state: LedgerState,
  asOf: string,
  assumptions: Assumptions,
  amountCents: number,
  date: string,
  name: string
): EvalResult {
  const problem = assumptionError(assumptions);
  if (problem) return fail("INVALID_ASSUMPTIONS", problem);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return fail("INVALID_AMOUNT", "The amount must be positive integer cents.");
  }
  if (!isIsoDate(asOf)) return fail("INVALID_DATE", asOf);
  if (!isIsoDate(date)) return fail("INVALID_DATE", date);
  const windowEnd = addDaysIso(asOf, assumptions.horizonDays);
  if (date < asOf || date >= windowEnd) {
    return fail("EVENT_OUT_OF_HORIZON", "The date is outside the plan window.");
  }
  try {
    const scenario = buildScenarioFromLedger(
      state,
      asOf,
      assumptions.horizonDays,
      toSimulationConfig(assumptions)
    );
    const fixedEvent = {
      date,
      amount_cents: -amountCents,
      type: "expense",
      name,
    };
    scenario.events.push(fixedEvent);
    sortScenarioEvents(scenario.events);
    // A hypothetical amount is the decision variable. Varying it (or letting
    // it consume a bill draw) would change the question being asked.
    return runBuilt(scenario, assumptions, new Set([scenario.events.indexOf(fixedEvent)]));
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
    const events: LedgerScenarioEvent[] = scenario.events;
    const target = events.find((event) => ledgerEventSource(event)?.kind === "scheduled-income");
    if (!target) {
      return fail("NO_INCOME", "No paycheck is scheduled in this window.");
    }
    // The freshly built scenario is already in chronological order. Preserve
    // input order as the engine's same-day tiebreaker after changing its date.
    target.date = addDaysIso(target.date, delayDays);
    return runBuilt(scenario, assumptions);
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
  const problem = assumptionError(assumptions);
  if (problem) return fail("INVALID_ASSUMPTIONS", problem);
  if (!isIsoDate(asOf)) return fail("INVALID_DATE", asOf);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    return fail("INVALID_AMOUNT", "The amount set aside must be positive integer cents.");
  }
  const next = JSON.parse(JSON.stringify(state)) as LedgerState;
  const dueDay = Number(asOf.split("-")[2]);
  const hypotheticalId = "hypothetical-set-aside";
  next.payments = [
    ...next.payments,
    {
      id: hypotheticalId,
      name: "Amount set aside",
      amount_cents: amountCents,
      due_day: dueDay,
      recurrence: "Monthly",
      is_auto_withdraw: false,
    },
  ];
  try {
    const scenario = buildScenarioFromLedger(
      next,
      asOf,
      assumptions.horizonDays,
      toSimulationConfig(assumptions),
      { fixedPaymentIds: new Set([hypotheticalId]) }
    );
    return runBuilt(scenario, assumptions, fixedEventOrders(scenario));
  } catch (err) {
    return fromThrown(err);
  }
}
