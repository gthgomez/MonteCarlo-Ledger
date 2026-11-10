import { quantilePlainName } from "./assumptions";
import { addDaysIso, calendarMonthWindow, previousMonthWindow, relativeDay } from "./dates";
import { formatMoney } from "./money-format";
import type { LiabilityItem, TransactionItem } from "./types";
import type { Section } from "./sections";

export interface TimelineLike {
  date: string;
  name: string;
  type: string;
  amount_cents: number;
  balance_after_cents: number;
}

export interface PlanSlice {
  /** Half-open window [asOf, asOf + days). Rows must already be in contract order. */
  events: TimelineLike[];
  scheduledIncomeCents: number;
  scheduledOutflowCents: number;
  plannedEndingCents: number;
  plannedLowCents: number;
}

/**
 * Summarize a prefix of contract timeline rows. This does not forecast.
 * The ending balance is the engine's running balance after the last event in
 * the window, or the starting balance when the window has no events.
 */
export function slicePlan(
  rows: TimelineLike[],
  asOf: string,
  days: number,
  startingBalanceCents: number
): PlanSlice {
  const end = addDaysIso(asOf, days);
  const events = rows.filter((row) => row.date >= asOf && row.date < end);
  let scheduledIncomeCents = 0;
  let scheduledOutflowCents = 0;
  for (const event of events) {
    if (event.type === "income") scheduledIncomeCents += event.amount_cents;
    else if (event.amount_cents < 0) scheduledOutflowCents += -event.amount_cents;
  }
  const plannedEndingCents = events.length
    ? events[events.length - 1].balance_after_cents
    : startingBalanceCents;
  const plannedLowCents = events.reduce(
    (low, event) => Math.min(low, event.balance_after_cents),
    startingBalanceCents
  );
  return {
    events,
    scheduledIncomeCents,
    scheduledOutflowCents,
    plannedEndingCents,
    plannedLowCents,
  };
}

export interface CategorySpend {
  category: string;
  cents: number;
}

export interface SpendingSummary {
  totalCents: number;
  byCategory: CategorySpend[];
}

/** Posted expenses only. Future-dated rows are scheduled, not spent. */
export function recordedSpending(
  transactions: TransactionItem[],
  startInclusive: string,
  endExclusive: string,
  asOf: string
): SpendingSummary {
  const totals = new Map<string, number>();
  let totalCents = 0;
  for (const tx of transactions) {
    if (tx.type !== "Expense") continue;
    if (tx.date > asOf) continue;
    if (tx.date < startInclusive || tx.date >= endExclusive) continue;
    const spent = -tx.amount_cents;
    if (spent <= 0) continue;
    const category = (tx.category || "Uncategorized").trim() || "Uncategorized";
    totals.set(category, (totals.get(category) ?? 0) + spent);
    totalCents += spent;
  }
  const byCategory = [...totals.entries()]
    .map(([category, cents]) => ({ category, cents }))
    .sort((a, b) => b.cents - a.cents || a.category.localeCompare(b.category));
  return { totalCents, byCategory };
}

export function spendingThisMonth(transactions: TransactionItem[], asOf: string): SpendingSummary {
  const { start, end } = calendarMonthWindow(asOf);
  return recordedSpending(transactions, start, end, asOf);
}

export function spendingLastMonth(transactions: TransactionItem[], asOf: string): SpendingSummary {
  const { start, end } = previousMonthWindow(asOf);
  return recordedSpending(transactions, start, end, asOf);
}

export function spendingDeltaNote(currentCents: number, previousCents: number): string | null {
  if (currentCents === 0 && previousCents === 0) return null;
  if (currentCents === 0) {
    return `No spending is recorded this month. Last month you recorded ${formatMoney(previousCents)}.`;
  }
  if (previousCents === 0) {
    return `You recorded ${formatMoney(currentCents)} of spending this month. Nothing was recorded last month, so this is not a comparison.`;
  }
  const delta = currentCents - previousCents;
  if (delta === 0) {
    return `Recorded spending this month matches last month at ${formatMoney(currentCents)}.`;
  }
  if (delta > 0) {
    return `Recorded spending this month is ${formatMoney(currentCents)}, which is ${formatMoney(delta)} more than last month.`;
  }
  return `Recorded spending this month is ${formatMoney(currentCents)}, which is ${formatMoney(-delta)} less than last month.`;
}

export interface CategoryOverage {
  category: string;
  actualCents: number;
  targetCents: number;
  overCents: number;
}

export function categoryOverages(
  spending: CategorySpend[],
  targets: Record<string, number>
): CategoryOverage[] {
  const actual = new Map(spending.map((row) => [row.category, row.cents]));
  const rows: CategoryOverage[] = [];
  for (const [category, targetCents] of Object.entries(targets)) {
    if (!Number.isSafeInteger(targetCents) || targetCents < 0) continue;
    const actualCents = actual.get(category) ?? 0;
    if (actualCents > targetCents) {
      rows.push({
        category,
        actualCents,
        targetCents,
        overCents: actualCents - targetCents,
      });
    }
  }
  rows.sort((a, b) => b.overCents - a.overCents || a.category.localeCompare(b.category));
  return rows;
}

export function transactionSumCents(transactions: TransactionItem[]): number | null {
  let sum = 0;
  for (const tx of transactions) {
    if (!Number.isSafeInteger(tx.amount_cents)) return null;
    if (sum > 0 && tx.amount_cents > Number.MAX_SAFE_INTEGER - sum) return null;
    if (sum < 0 && tx.amount_cents < Number.MIN_SAFE_INTEGER - sum) return null;
    sum += tx.amount_cents;
  }
  return sum;
}

export function enteredDebtCents(liabilities: LiabilityItem[] | undefined): number | null {
  let sum = 0;
  for (const debt of liabilities ?? []) {
    if (!Number.isSafeInteger(debt.balance_cents) || debt.balance_cents < 0) return null;
    if (sum > Number.MAX_SAFE_INTEGER - debt.balance_cents) return null;
    sum += debt.balance_cents;
  }
  return sum;
}

export function cashMinusEnteredDebt(
  balanceCents: number,
  liabilities: LiabilityItem[] | undefined
): number | null {
  const debt = enteredDebtCents(liabilities);
  if (debt === null || !Number.isSafeInteger(balanceCents)) return null;
  const net = balanceCents - debt;
  if (!Number.isSafeInteger(net)) return null;
  return net;
}

export interface PositionCopy {
  lead: string;
  caution: string;
  technicalName: string;
}

export function describePosition(input: {
  recordedBalanceCents: number;
  scheduledIncomeCents: number;
  scheduledBillCents: number;
  plannedEndingCents: number;
  windowDays: number;
  safeSpendCents: number;
  difficultLowCents: number;
  reserveCents: number;
  quantileNum: number;
  quantileDen: number;
  runs: number;
  isDemo: boolean;
  hasSchedule: boolean;
}): PositionCopy {
  const rank = quantilePlainName(input.quantileNum, input.quantileDen);
  const who = input.isDemo
    ? `This sample household has ${formatMoney(input.recordedBalanceCents)} recorded.`
    : `You have ${formatMoney(input.recordedBalanceCents)} recorded.`;
  const bills =
    input.scheduledBillCents > 0
      ? `Known bills in the next ${input.windowDays} days total ${formatMoney(input.scheduledBillCents)}.`
      : `No bills are scheduled in the next ${input.windowDays} days.`;
  const income =
    input.scheduledIncomeCents > 0
      ? `Scheduled income in that window is ${formatMoney(input.scheduledIncomeCents)}.`
      : `No paycheck is scheduled in that window.`;
  const plan = input.hasSchedule
    ? `If that schedule happens exactly as entered, the balance would be ${formatMoney(input.plannedEndingCents)}.`
    : `With nothing scheduled, this plan leaves the recorded balance unchanged.`;
  const spend =
    input.safeSpendCents >= 0
      ? `The cautious amount you could spend is ${formatMoney(input.safeSpendCents)}.`
      : `In the ${rank} of modeled outcomes, the low point is ${formatMoney(input.safeSpendCents)}, so there is no cautious amount left to spend.`;
  let caution = `The cautious amount is the ${rank} of the lowest balances in ${input.runs} modeled futures, minus a reserve of ${formatMoney(input.reserveCents)}. It is an estimate from the assumptions in Advanced, not a guarantee and not your bank balance.`;
  if (input.reserveCents === 0 && input.safeSpendCents === input.difficultLowCents) {
    caution += ` With no reserve set, it matches that modeled low point.`;
  }
  const technicalName =
    input.quantileNum === 1 && input.quantileDen === 10
      ? "Safe to Spend (P10)"
      : `Safe to spend (nearest-rank ${input.quantileNum}/${input.quantileDen})`;
  return {
    lead: `${who} ${bills} ${income} ${plan} ${spend}`,
    caution,
    technicalName,
  };
}

export interface Insight {
  id: string;
  tone: "info" | "attention" | "ok";
  title: string;
  detail: string;
  action?: { label: string; section: Section };
}

export function buildInsights(input: {
  asOf: string;
  isDemo: boolean;
  incomeCount: number;
  paymentCount: number;
  overdueCount: number;
  overdueCents: number;
  overdueEarliest: string | null;
  firstNegativeDate: string | null;
  nextBill: TimelineLike | null;
  spendingNote: string | null;
  overage: CategoryOverage | null;
  safeSpendCents: number;
  overdraftPpm: number;
  runs: number;
  ledgerMatches: boolean;
}): Insight[] {
  const insights: Insight[] = [];
  if (!input.ledgerMatches) {
    insights.push({
      id: "ledger-mismatch",
      tone: "attention",
      title: "The recorded balance does not match the transactions",
      detail: "No spending advice is based on that balance until the ledger adds up.",
      action: { label: "Review money", section: "money" },
    });
  }
  if (input.overdueCount > 0 && input.overdueEarliest) {
    insights.push({
      id: "overdue",
      tone: "attention",
      title: `${input.overdueCount} unpaid ${input.overdueCount === 1 ? "bill is" : "bills are"} past the due date`,
      detail: `They total ${formatMoney(input.overdueCents)}, earliest ${relativeDay(input.asOf, input.overdueEarliest)}. The forward plan does not include them.`,
      action: { label: "Review bills", section: "bills" },
    });
  }
  if (input.firstNegativeDate) {
    insights.push({
      id: "planned-shortfall",
      tone: "attention",
      title: "The exact schedule goes below zero",
      detail: `If every entered paycheck and bill happens on its date, the balance would be negative on ${relativeDay(input.asOf, input.firstNegativeDate)} (${input.firstNegativeDate}). That is the plan, not a prediction.`,
      action: { label: "See the plan", section: "future" },
    });
  }
  if (input.safeSpendCents < 0) {
    insights.push({
      id: "no-cautious-spend",
      tone: "attention",
      title: "There is no cautious amount left to spend",
      detail: `The more difficult modeled low point is ${formatMoney(input.safeSpendCents)}. That is an estimate, not a guarantee you will overdraw.`,
      action: { label: "Look at decisions", section: "plan" },
    });
  }
  if (input.nextBill && input.nextBill.amount_cents < 0) {
    insights.push({
      id: "next-bill",
      tone: "info",
      title: `${input.nextBill.name} is due ${relativeDay(input.asOf, input.nextBill.date)}`,
      detail: `${formatMoney(-input.nextBill.amount_cents)} on ${input.nextBill.date}. This bill is already included in the plan. Recording it as paid is a separate step.`,
      action: { label: "See bills", section: "bills" },
    });
  }
  if (input.spendingNote) {
    insights.push({
      id: "spending",
      tone: "info",
      title: "Recorded spending",
      detail: input.spendingNote,
      action: { label: "Open budget", section: "budget" },
    });
  }
  if (input.overage) {
    insights.push({
      id: "over-target",
      tone: "attention",
      title: `${input.overage.category} is over the target you set`,
      detail: `Recorded ${input.overage.category} spending this month is ${formatMoney(input.overage.actualCents)}, which is ${formatMoney(input.overage.overCents)} over your ${formatMoney(input.overage.targetCents)} target.`,
      action: { label: "Adjust the target", section: "budget" },
    });
  }
  if (input.incomeCount === 0) {
    insights.push({
      id: "no-income",
      tone: "info",
      title: "No paycheck is on the schedule",
      detail: "The plan can only use the balance and bills you entered until you add income.",
      action: { label: "Add income", section: "money" },
    });
  }
  if (input.paymentCount === 0) {
    insights.push({
      id: "no-bills",
      tone: "info",
      title: "No bills are on the schedule",
      detail: "Add rent, utilities, or other payments you make regularly so upcoming obligations show up.",
      action: { label: "Add a bill", section: "bills" },
    });
  }
  if (input.overdraftPpm > 0) {
    insights.push({
      id: "model-shortfall",
      tone: "attention",
      title: "Some modeled futures go negative",
      detail: `${input.overdraftPpm.toLocaleString("en-US")} of 1,000,000 is the modeled chance of a negative balance in this window. It is not a promise that it will or will not happen.`,
      action: { label: "See possible futures", section: "future" },
    });
  } else if (input.runs > 0 && input.safeSpendCents >= 0 && !input.firstNegativeDate) {
    insights.push({
      id: "model-clear",
      tone: "ok",
      title: "None of these modeled futures went negative",
      detail: `That is ${input.runs} futures under the current assumptions. It is not a guarantee. Income and surprise expenses only move inside the ranges in Advanced.`,
      action: { label: "Check assumptions", section: "advanced" },
    });
  }
  return insights;
}

/** Straight division of a savings target. Not a forecast and not interest. */
export function evenSetAside(
  targetCents: number,
  months: number
): { perMonthCents: number; remainderCents: number } | null {
  if (!Number.isSafeInteger(targetCents) || targetCents <= 0) return null;
  if (!Number.isInteger(months) || months < 1 || months > 120) return null;
  const perMonthCents = Math.floor(targetCents / months);
  return { perMonthCents, remainderCents: targetCents - perMonthCents * months };
}
