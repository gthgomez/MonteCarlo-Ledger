import { checkedAdd, roundHalfAway, toSafeNumber } from "../contract/money";
import { IncomeItem, LedgerState, LiabilityItem, PaymentItem } from "./types";

/**
 * Locale-independent code-point comparison, matching Python's string ordering.
 * `localeCompare` can put mixed-case/accented names in a different order and is
 * browser-locale dependent, which would shift seeded draws between surfaces.
 */
function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  const limit = Math.min(a.length, b.length);
  for (let i = 0; i < limit; i += 1) {
    const diff = a[i].codePointAt(0)! - b[i].codePointAt(0)!;
    if (diff !== 0) return diff;
  }
  return a.length - b.length;
}

/** Canonical same-day order shared by the base scenario and what-if events. */
export function sortScenarioEvents(events: any[]): void {
  events.sort((left, right) => {
    const byDate = compareCodePoints(String(left.date), String(right.date));
    if (byDate !== 0) return byDate;
    const leftRank = left.type === "income" ? 0 : left.type === "adjustment" ? 2 : 1;
    const rightRank = right.type === "income" ? 0 : right.type === "adjustment" ? 2 : 1;
    if (leftRank !== rightRank) return leftRank - rightRank;
    const byName = compareCodePoints(String(left.name), String(right.name));
    if (byName !== 0) return byName;
    if (left.amount_cents !== right.amount_cents) return left.amount_cents - right.amount_cents;
    return compareCodePoints(String(left.category ?? ""), String(right.category ?? ""));
  });
}

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().split("T")[0];
}

// Advance by whole months while preserving the day-of-month anchor: Jan 31 monthly
// becomes Feb 28/29, then Mar 31 — it must never drift into a different day (MCD-0022).
// `anchorDay` carries the recurrence's original day through clamped months; without it,
// a clamped occurrence (Feb 28) would redefine the anchor and erase the 31st forever.
function addMonthsClamped(iso: string, months: number, anchorDay?: number): string {
  const [y, m] = iso.split("-").map(Number);
  const d = anchorDay ?? Number(iso.split("-")[2]);
  const targetMonth0 = m - 1 + months;
  const ny = y + Math.floor(targetMonth0 / 12);
  const nm = (targetMonth0 % 12) + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const nd = Math.min(d, lastDay);
  return `${ny}-${String(nm).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}

/** First date actually covered by a newly saved monthly bill. */
export function firstMonthlyBillDate(asOf: string, dueDay: number): string {
  const thisMonth = addMonthsClamped(asOf, 0, dueDay);
  return thisMonth >= asOf ? thisMonth : addMonthsClamped(asOf, 1, dueDay);
}

function getNextDate(iso: string, frequency: string, anchorDay?: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));

  switch (frequency) {
    case "Weekly":
      date.setUTCDate(date.getUTCDate() + 7);
      break;
    case "Bi-weekly":
      date.setUTCDate(date.getUTCDate() + 14);
      break;
    case "Monthly":
      return addMonthsClamped(iso, 1, anchorDay);
    default:
      return "9999-12-31";
  }
  return date.toISOString().split("T")[0];
}

/**
 * The income date the plan actually uses on or after `asOf`.
 *
 * A stored next payday may already be in the past (the app does not rewrite the
 * ledger just because a date passed). Showing that stale date as "next" is false;
 * advance the same anchored recurrence the forecast uses.
 */
export function nextIncomeDate(income: IncomeItem, asOf: string): string {
  if (income.next_payday >= asOf) return income.next_payday;
  if (income.frequency === "One-time") return income.next_payday;
  const lastAnchorDay = Number(income.last_payday.split("-")[2]);
  const nextDay = Number(income.next_payday.split("-")[2]);
  const [ny, nm] = income.next_payday.split("-").map(Number);
  const lastOfNextMonth = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const incomeAnchorDay =
    nextDay === Math.min(lastAnchorDay, lastOfNextMonth) ? lastAnchorDay : nextDay;
  let current = income.next_payday;
  let guard = 0;
  while (current < asOf && guard < 10_000) {
    const next = getNextDate(current, income.frequency, incomeAnchorDay);
    if (next <= current) break;
    current = next;
    guard += 1;
  }
  return current;
}

const fixedOrdersByScenario = new WeakMap<object, Set<number>>();

/** Adapter-private metadata; never serialized into the scenario or contract. */
export function fixedEventOrders(scenario: any): ReadonlySet<number> | undefined {
  return fixedOrdersByScenario.get(scenario);
}

export interface ProjectedDebtMinimum {
  liability_id: string;
  name: string;
  date: string;
  amount_cents: number;
  due_day_of_month: number | null;
}

export interface LedgerScenarioEvent {
  date: string;
  amount_cents: number;
  type: "income" | "expense" | "adjustment";
  name: string;
}

export type LedgerEventSource =
  | { kind: "scheduled-income"; incomeId: IncomeItem["id"] }
  | { kind: "bill"; paymentId: PaymentItem["id"]; slotDate: string; dueDate: string }
  | { kind: "debt-minimum"; minimum: ProjectedDebtMinimum }
  | { kind: "posted-transaction"; transactionId: LedgerState["transactions"][number]["id"] };

const sourceByEvent = new WeakMap<LedgerScenarioEvent, LedgerEventSource>();

function sourcedEvent<Event extends LedgerScenarioEvent>(event: Event, source: LedgerEventSource): Event {
  sourceByEvent.set(event, source);
  return event;
}

/** Adapter-private identity, keyed by event object so sorting cannot change it. */
export function ledgerEventSource(event: LedgerScenarioEvent): LedgerEventSource | undefined {
  return sourceByEvent.get(event);
}

export interface ProjectedBillSlot {
  payment: PaymentItem;
  slotDate: string;
  dueDate: string;
}

/** Stable identity for one scheduled bill slot. */
export function paymentOccurrenceKey(paymentId: number | string, slotDate: string): string {
  return `${paymentId}::${slotDate}`;
}

type BillInputs = Pick<LedgerState, "payments" | "bill_occurrences">;

function coveredBillSlots(occurrences: LedgerState["bill_occurrences"]): Set<string> {
  const covered = new Set<string>();
  for (const occ of occurrences) {
    covered.add(paymentOccurrenceKey(occ.payment_id, occ.original_due_date || occ.due_date));
    if (occ.is_user_modified) {
      covered.add(paymentOccurrenceKey(occ.payment_id, occ.due_date));
    }
  }
  return covered;
}

function scheduledOneTimeSlots(payments: PaymentItem[], covered: Set<string>): ProjectedBillSlot[] {
  const slots: ProjectedBillSlot[] = [];
  for (const payment of payments) {
    if (payment.recurrence !== "One-time" || !payment.due_date) continue;
    if (covered.has(paymentOccurrenceKey(String(payment.id), payment.due_date))) continue;
    slots.push({ payment, slotDate: payment.due_date, dueDate: payment.due_date });
  }
  return slots;
}

function byDueDate(left: ProjectedBillSlot, right: ProjectedBillSlot): number {
  return left.dueDate.localeCompare(right.dueDate)
    || String(left.payment.id).localeCompare(String(right.payment.id));
}

/**
 * One-time bills whose scheduled date passed without any stored occurrence.
 * They stay out of the cash plan (no automatic historical expense) but must be
 * visible for review; `projectBillPayments` exposes them as resolvable slots.
 */
export function unresolvedPastOneTimeSlots(
  state: BillInputs,
  asOf: string,
  covered = coveredBillSlots(state.bill_occurrences)
): ProjectedBillSlot[] {
  return scheduledOneTimeSlots(state.payments, covered).filter((slot) => slot.dueDate < asOf).sort(byDueDate);
}

/**
 * Show the earliest unresolved slot for each recurring schedule whose starting
 * date is known. Day-of-month-only legacy templates have no historical start;
 * do not invent debts before a user entered them. Never post a guessed debit.
 */
export function unresolvedPastRecurringSlots(
  state: BillInputs,
  asOf: string,
  covered = coveredBillSlots(state.bill_occurrences)
): ProjectedBillSlot[] {
  const slots: ProjectedBillSlot[] = [];
  for (const payment of state.payments) {
    if (payment.id == null || !payment.due_date || payment.recurrence === "One-time") continue;
    const anchorDay = payment.due_day ?? Number(payment.due_date.split("-")[2]);
    if (payment.recurrence === "Monthly" && addMonthsClamped(payment.due_date, 0, anchorDay) !== payment.due_date) continue;
    let current = payment.due_date;
    while (current < asOf) {
      if (!covered.has(paymentOccurrenceKey(payment.id, current))) {
        slots.push({ payment, slotDate: current, dueDate: current });
        break;
      }
      const next = getNextDate(current, payment.recurrence, anchorDay);
      if (next <= current) break;
      current = next;
    }
  }
  return slots.sort(byDueDate);
}

export function unresolvedPastBillSlots(state: BillInputs, asOf: string): ProjectedBillSlot[] {
  const covered = coveredBillSlots(state.bill_occurrences);
  return [
    ...unresolvedPastOneTimeSlots(state, asOf, covered),
    ...unresolvedPastRecurringSlots(state, asOf, covered),
  ];
}

/** The earliest known one-time outflow on or after the first excluded day. */
export function firstOneTimeBillOutsideWindow(state: BillInputs, windowEnd: string): ProjectedBillSlot | null {
  const slots = scheduledOneTimeSlots(state.payments, coveredBillSlots(state.bill_occurrences));
  const oneTimeById = new Map(state.payments
    .filter((payment) => payment.recurrence === "One-time")
    .map((payment) => [String(payment.id), payment] as const));
  for (const occurrence of state.bill_occurrences) {
    if (occurrence.paid || occurrence.due_date < windowEnd) continue;
    const payment = oneTimeById.get(String(occurrence.payment_id));
    if (!payment) continue;
    slots.push({
      payment,
      slotDate: occurrence.original_due_date || occurrence.due_date,
      dueDate: occurrence.due_date,
    });
  }
  return slots.filter((slot) => slot.dueDate >= windowEnd).sort(byDueDate)[0] ?? null;
}

/** One occurrence model for cash events and editable bill rows. */
export function projectBillPayments(
  state: LedgerState,
  asOf: string,
  windowEnd: string,
  fixedPaymentIds?: ReadonlySet<string>
) {
  const events: (LedgerScenarioEvent & { type: "expense" })[] = [];
  const fixedEvents = new Set<LedgerScenarioEvent>();
  const slots: ProjectedBillSlot[] = [];
  const generated = new Set<string>();

  function addBill(slot: ProjectedBillSlot, isGenerated: boolean): void {
    const { payment, slotDate, dueDate } = slot;
    const event = sourcedEvent({
      date: dueDate < asOf ? asOf : dueDate,
      amount_cents: -payment.amount_cents,
      type: "expense",
      name: payment.name,
    }, { kind: "bill", paymentId: payment.id, slotDate, dueDate });
    slots.push(slot);
    events.push(event);
    if (isGenerated) {
      generated.add(paymentOccurrenceKey(String(payment.id), slotDate));
      if (fixedPaymentIds?.has(String(payment.id))) fixedEvents.add(event);
    }
  }

  const paymentById = new Map(state.payments.map((p) => [String(p.id), p] as const));
  const covered = coveredBillSlots(state.bill_occurrences);
  for (const occ of state.bill_occurrences) {
    if (occ.paid) continue;
    if (occ.due_date >= windowEnd) continue;
    const pmt = paymentById.get(String(occ.payment_id));
    if (!pmt) continue;
    const slotDate = occ.original_due_date || occ.due_date;
    addBill({ payment: pmt, slotDate, dueDate: occ.due_date }, false);
  }

  for (const pmt of state.payments) {
    if (pmt.recurrence === "Monthly" && pmt.due_day) {
      const [startYear, startMonth] = asOf.split("-").map(Number);
      const [endYear, endMonth] = windowEnd.split("-").map(Number);
      const totalMonths = (endYear - startYear) * 12 + (endMonth - startMonth) + 2;

      for (let i = 0; i < totalMonths; i++) {
        const curM = startMonth + i;
        const curY = startYear + Math.floor((curM - 1) / 12);
        const actualM = ((curM - 1) % 12) + 1;
        const maxD = new Date(Date.UTC(curY, actualM, 0)).getUTCDate();
        const d = Math.min(pmt.due_day, maxD);
        const dueIso = `${curY}-${String(actualM).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

        if (dueIso >= asOf && dueIso < windowEnd && (!pmt.due_date || dueIso >= pmt.due_date)) {
          const key = paymentOccurrenceKey(String(pmt.id), dueIso);
          if (!covered.has(key)) {
            addBill({ payment: pmt, slotDate: dueIso, dueDate: dueIso }, true);
          }
        }
      }
    } else if (pmt.due_date) {
      let current = pmt.due_date;
      const paymentAnchorDay = Number(pmt.due_date.split("-")[2]);
      let guard = 0;
      while (current < windowEnd && guard < 1000) {
        if (current >= asOf) {
          const key = paymentOccurrenceKey(String(pmt.id), current);
          if (!covered.has(key)) {
            addBill({ payment: pmt, slotDate: current, dueDate: current }, true);
          }
        }
        if (pmt.recurrence === "One-time") break;
        const nxt = getNextDate(current, pmt.recurrence, paymentAnchorDay);
        if (nxt <= current) break;
        current = nxt;
        guard++;
      }
    }
  }

  // A past one-time slot with no stored occurrence has no cash event, but it is
  // still an unresolved obligation. Expose it as an editable row so a person can
  // mark it paid or move it; do not invent a historical expense.
  for (const slot of unresolvedPastOneTimeSlots(state, asOf, covered)) {
    slots.push(slot);
  }
  for (const slot of unresolvedPastRecurringSlots(state, asOf, covered)) {
    slots.push(slot);
  }

  return { events, generated, slots, fixedEvents };
}

export function buildScenarioFromLedger(
  state: LedgerState,
  asOf: string,
  horizonDays: number = 90,
  includeSimulation?: any,
  options?: { fixedPaymentIds?: ReadonlySet<string> }
): any {
  const paymentIds = new Set(state.payments.map((payment) => String(payment.id)));
  const ownedPayments = new Set<string>();
  for (const liability of state.liabilities ?? []) {
    if (liability.linked_payment_id == null) continue;
    const linkedId = String(liability.linked_payment_id);
    if (!paymentIds.has(linkedId)) throw new Error(`Liability '${liability.id}' references unknown payment '${linkedId}'`);
    if (ownedPayments.has(linkedId)) throw new Error(`Payment '${linkedId}' is linked to multiple liabilities`);
    ownedPayments.add(linkedId);
  }
  const windowEnd = addDays(asOf, horizonDays);
  const events: LedgerScenarioEvent[] = [];

  // 1. Materialize Scheduled Income
  for (const inc of state.incomes) {
    let current = inc.next_payday;
    // Anchor on the original last_payday day, not the possibly clamped next_payday
    // (MCD-0022). A deliberately moved next payday becomes the new anchor.
    const lastAnchorDay = Number(inc.last_payday.split("-")[2]);
    const nextDay = Number(inc.next_payday.split("-")[2]);
    const [ny, nm] = inc.next_payday.split("-").map(Number);
    const lastOfNextMonth = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
    const incomeAnchorDay =
      nextDay === Math.min(lastAnchorDay, lastOfNextMonth) ? lastAnchorDay : nextDay;
    let firstInWindow = true;
    let guard = 0;
    while (current < windowEnd && guard < 1000) {
      if (current >= asOf) {
        const amount =
          firstInWindow && inc.expected_amount !== undefined && inc.expected_amount !== null
            ? inc.expected_amount
            : inc.amount_cents;
        events.push(sourcedEvent({
          date: current,
          amount_cents: amount,
          type: "income",
          name: inc.name,
        }, { kind: "scheduled-income", incomeId: inc.id }));
        firstInWindow = false;
      }
      const nextDate = getNextDate(current, inc.frequency, incomeAnchorDay);
      if (nextDate <= current) break;
      current = nextDate;
      guard++;
    }
  }

  const bills = projectBillPayments(state, asOf, windowEnd, options?.fixedPaymentIds);
  events.push(...bills.events);

  // 3. Future-dated posted transactions are events, not opening cash.
  const futureTransactions = state.transactions.filter(
    (tx) => tx.date > asOf && tx.date < windowEnd
  );
  for (const tx of futureTransactions) {
    const type = tx.type === "Income" ? "income" : tx.type === "Expense" ? "expense" : "adjustment";
    events.push(sourcedEvent({
      date: tx.date,
      amount_cents: tx.amount_cents,
      type,
      name: tx.description || tx.category || "Planned transaction",
    }, { kind: "posted-transaction", transactionId: tx.id }));
  }

  // 4. Entered debt minimums become ordinary cash outflows (Contract callers add events;
  // the engine still does not auto-inject). Linked bills cover only their matching slot.
  events.push(...liabilityMinPaymentEvents(
    state.liabilities ?? [], state.payments, state.bill_occurrences, state.transactions, bills.generated, asOf, windowEnd,
  ));

  sortScenarioEvents(events);

  const futureOutflow = state.transactions
    .filter((tx) => tx.date > asOf)
    .reduce((sum, tx) => sum + BigInt(tx.amount_cents), 0n);
  const startingBalance = toSafeNumber(BigInt(state.current_balance_cents) - futureOutflow);

  const fixedOrders = new Set<number>();
  if (bills.fixedEvents.size > 0) {
    events.forEach((event, index) => {
      if (bills.fixedEvents.has(event)) fixedOrders.add(index);
    });
  }
  const scenario: any = {
    contract_version: "2.0",
    scenario_id: `ledger-${asOf}-${horizonDays}`,
    as_of: asOf,
    starting_balance_cents: startingBalance,
    horizon_days: horizonDays,
    events,
  };

  const activeLiabilities = (state.liabilities ?? []).filter((l) => l.is_active !== false);
  if (activeLiabilities.length > 0) {
    scenario.liabilities = activeLiabilities.map((l) => {
      const item: any = {
        id: l.id,
        name: l.name,
        balance_cents: l.balance_cents,
        apr_basis_points: l.apr_basis_points,
        min_payment_cents: l.min_payment_cents,
        kind: l.kind ?? "installment",
      };
      if (typeof l.min_payment_percent_bps === "number") {
        item.min_payment_percent_bps = l.min_payment_percent_bps;
      }
      if (typeof l.min_payment_floor_cents === "number") {
        item.min_payment_floor_cents = l.min_payment_floor_cents;
      }
      if (typeof l.due_day_of_month === "number") {
        item.due_day_of_month = l.due_day_of_month;
      }
      return item;
    });
    scenario.debt_strategy = "snowball";
  }

  if (includeSimulation) {
    scenario.simulation = includeSimulation;
  }
  if (fixedOrders.size > 0) fixedOrdersByScenario.set(scenario, fixedOrders);

  return scenario;
}

/** Opening-balance planning minimum (no interest); matches Contract revolving/installment rules. */
export function planningMinimumPaymentCents(
  liability: LiabilityItem,
  balanceCents: number = liability.balance_cents
): number {
  const balance = balanceCents;
  if (!Number.isSafeInteger(balance) || balance <= 0) return 0;
  if ((liability.kind ?? "installment") !== "revolving") {
    return Math.min(liability.min_payment_cents, balance);
  }
  const percent = toSafeNumber(
    roundHalfAway(BigInt(balance) * BigInt(liability.min_payment_percent_bps ?? 0), 10_000n)
  );
  const floor = liability.min_payment_floor_cents ?? 0;
  return Math.min(Math.max(percent, floor), balance);
}

/**
 * The date a linked bill is scheduled to pay its debt in one calendar month.
 *
 * A link is the user's statement that this bill pays this debt. The bill's own
 * recurrence therefore defines the slot, even when the debt's stored due day was
 * edited later or came from another client. Returns null for a one-time link in
 * a month it does not occupy, so that month falls back to the debt's own due day.
 */
function linkedPaymentSlot(
  payment: PaymentItem,
  year: number,
  month: number
): string | null {
  if (payment.recurrence === "Monthly" && payment.due_day) {
    const maxD = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const day = Math.min(payment.due_day, maxD);
    const slot = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    return payment.due_date && slot < payment.due_date ? null : slot;
  }
  if (payment.recurrence === "One-time" && payment.due_date) {
    const [dueYear, dueMonth] = payment.due_date.split("-").map(Number);
    return dueYear === year && dueMonth === month ? payment.due_date : null;
  }
  return null;
}

function isUnpaidMovedOccurrence(occurrence: LedgerState["bill_occurrences"][number] | undefined): boolean {
  return Boolean(
    occurrence?.original_due_date &&
    occurrence.original_due_date !== occurrence.due_date &&
    !occurrence.paid
  );
}

function liabilityMinPaymentEvents(
  liabilities: LiabilityItem[],
  payments: PaymentItem[],
  occurrences: LedgerState["bill_occurrences"],
  transactions: { id?: number | string; amount_cents: number }[],
  generatedSlots: ReadonlySet<string>,
  asOf: string,
  windowEnd: string
): LedgerScenarioEvent[] {
  const paymentById = new Map(payments.map((payment) => [String(payment.id), payment] as const));
  const occurrenceSlots = new Map<string, Map<string, typeof occurrences[number]>>();
  const transactionById = new Map(transactions.map((tx) => [String(tx.id), tx] as const));
  for (const occurrence of occurrences) {
    const key = String(occurrence.payment_id);
    const slots = occurrenceSlots.get(key) ?? new Map<string, typeof occurrence>();
    const slot = occurrence.original_due_date || occurrence.due_date;
    if (slots.has(slot)) throw new Error(`Payment '${key}' has duplicate occurrences on ${slot}`);
    slots.set(slot, occurrence);
    occurrenceSlots.set(key, slots);
  }

  const [startYear, startMonth] = asOf.split("-").map(Number);
  function monthOffset(date: string): number {
    const [year, month] = date.split("-").map(Number);
    return (year - startYear) * 12 + month - startMonth;
  }
  const forecastMonths = monthOffset(windowEnd) + 1;
  const forecastOffsets = Array.from({ length: forecastMonths }, (_, offset) => offset);
  const events: LedgerScenarioEvent[] = [];

  // Use stable identity order so same-day expenses receive seeded variation in the
  // same order as Python, regardless of how a snapshot's liabilities are arranged.
  const orderedLiabilities = [...liabilities].sort((left, right) => {
    const a = String(left.id);
    const b = String(right.id);
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (const liability of orderedLiabilities) {
    if (liability.is_active === false) continue;
    const name = liability.name || "Debt payment";
    let dueDay = liability.due_day_of_month ?? 1;
    if (!Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) dueDay = 1;
    const linkedPayment = liability.linked_payment_id == null
      ? undefined
      : paymentById.get(String(liability.linked_payment_id));
    const slots = linkedPayment ? occurrenceSlots.get(String(linkedPayment.id)) : undefined;

    // A moved unpaid bill still owns its original month's minimum. Select that
    // month directly if it contributes cash, without walking intervening months.
    const offsets = new Set(forecastOffsets);
    const firstOccurrenceByMonth = new Map<string, typeof occurrences[number]>();
    for (const [slot, occurrence] of slots ?? []) {
      const month = slot.slice(0, 7);
      const first = firstOccurrenceByMonth.get(month);
      if (!first || slot < (first.original_due_date || first.due_date)) firstOccurrenceByMonth.set(month, occurrence);
      if (occurrence.due_date < windowEnd && isUnpaidMovedOccurrence(occurrence)) {
        offsets.add(monthOffset(slot));
      }
    }

    const dueSlots: { date: string; coveredCents: number; paidCoverage: boolean }[] = [];
    for (const offset of [...offsets].sort((left, right) => left - right)) {
      const curM = startMonth + offset;
      const yearOffset = Math.floor((curM - 1) / 12);
      const curY = startYear + yearOffset;
      const actualM = curM - yearOffset * 12;
      const maxD = new Date(Date.UTC(curY, actualM, 0)).getUTCDate();
      const d = Math.min(dueDay, maxD);
      const fallbackDueIso = `${curY}-${String(actualM).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      // The linked bill owns this debt's slot for the month. Using the debt's stored
      // due day here would charge a second minimum whenever the two dates differ.
      const dueIso = linkedPayment
        ? linkedPaymentSlot(linkedPayment, curY, actualM) ?? fallbackDueIso
        : fallbackDueIso;
      let projectedDueIso = dueIso;
      let coveredCents = 0;
      let paidCoverage = false;
      if (linkedPayment) {
        // A past edit can change the bill's due day while an occurrence keeps the
        // original slot. The month still identifies the same scheduled payment.
        const occurrence = slots?.get(dueIso) ?? (linkedPayment.recurrence === "Monthly"
          ? firstOccurrenceByMonth.get(dueIso.slice(0, 7))
          : undefined);
        const outsideForecastMonths = offset < 0 || offset >= forecastMonths;
        if (outsideForecastMonths && !isUnpaidMovedOccurrence(occurrence)) continue;
        const occurrenceAmount = occurrence?.paid && occurrence.transaction_id != null
          ? Math.abs(transactionById.get(String(occurrence.transaction_id))?.amount_cents ?? linkedPayment.amount_cents)
          : linkedPayment.amount_cents;
        const generatedCovers = generatedSlots.has(paymentOccurrenceKey(String(linkedPayment.id), dueIso));
        if (occurrence || generatedCovers) coveredCents = occurrenceAmount;
        paidCoverage = occurrence?.paid ?? false;
        // Keep the original slot for coverage, but project the unpaid shortfall
        // with its bill on the date cash will actually leave.
        if (occurrence && !occurrence.paid) projectedDueIso = occurrence.due_date;
      }
      // An overdue minimum still reduces today's available cash.
      const eventDate = projectedDueIso < asOf ? asOf : projectedDueIso;
      if (eventDate < windowEnd) {
        dueSlots.push({ date: eventDate, coveredCents, paidCoverage });
      }
    }

    // Apply payments in cash-date order (original month breaks same-date ties).
    // Accrue only through the event's cash month, on the remaining principal.
    dueSlots.sort((left, right) => compareCodePoints(left.date, right.date));
    let remainingBalance = liability.balance_cents;
    if (planningMinimumPaymentCents(liability, remainingBalance) <= 0) continue;
    let interestThroughMonth = 0;
    for (const { date, coveredCents, paidCoverage } of dueSlots) {
      if (remainingBalance <= 0) break;
      const cashMonth = monthOffset(date);
      while (interestThroughMonth < cashMonth) {
        const interest = toSafeNumber(
          roundHalfAway(
            BigInt(remainingBalance) * BigInt(liability.apr_basis_points),
            120_000n
          )
        );
        remainingBalance = toSafeNumber(
          checkedAdd(BigInt(remainingBalance), BigInt(interest))
        );
        interestThroughMonth += 1;
      }
      const amount = planningMinimumPaymentCents(liability, remainingBalance);
      if (amount <= 0) break;
      const shortfall = Math.max(0, amount - coveredCents);
      if (shortfall > 0) {
        const minimum: ProjectedDebtMinimum = {
          liability_id: String(liability.id),
          name,
          date,
          amount_cents: -shortfall,
          due_day_of_month: liability.due_day_of_month ?? null,
        };
        events.push(sourcedEvent(
          { date, amount_cents: -shortfall, type: "expense", name },
          { kind: "debt-minimum", minimum }
        ));
      }
      remainingBalance -= paidCoverage ? shortfall : amount;
    }
  }
  return events;
}

/** Debt minimums already computed for these cash events, in display order. */
export function debtMinimumsFromEvents(events: readonly LedgerScenarioEvent[]): ProjectedDebtMinimum[] {
  const details: ProjectedDebtMinimum[] = [];
  for (const event of events) {
    const source = ledgerEventSource(event);
    if (source?.kind === "debt-minimum") details.push(source.minimum);
  }
  return details.sort(
    (left, right) =>
      left.date.localeCompare(right.date) ||
      left.liability_id.localeCompare(right.liability_id)
  );
}

/**
 * The same debt-minimum cash events the forecast includes, exposed for honest
 * presentation. This calls the one projection routine; it is not a second model.
 */
export function projectedDebtMinimums(
  state: LedgerState,
  asOf: string,
  horizonDays: number
): ProjectedDebtMinimum[] {
  const windowEnd = addDays(asOf, horizonDays);
  const bills = projectBillPayments(state, asOf, windowEnd);
  const events = liabilityMinPaymentEvents(
    state.liabilities ?? [],
    state.payments,
    state.bill_occurrences,
    state.transactions,
    bills.generated,
    asOf,
    windowEnd
  );
  return debtMinimumsFromEvents(events);
}
