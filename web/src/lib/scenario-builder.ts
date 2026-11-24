import { checkedAdd, roundHalfAway, toSafeNumber } from "../contract/money";
import { LedgerState, LiabilityItem, PaymentItem } from "./types";

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
export function projectBillPayments(state: LedgerState, asOf: string, windowEnd: string) {
  const events: { date: string; amount_cents: number; type: "expense"; name: string }[] = [];
  const slots: ProjectedBillSlot[] = [];
  const paymentById = new Map(state.payments.map((p) => [String(p.id), p] as const));
  const covered = coveredBillSlots(state.bill_occurrences);
  const generated = new Set<string>();
  for (const occ of state.bill_occurrences) {
    if (occ.paid) continue;
    if (occ.due_date >= windowEnd) continue;
    const pmt = paymentById.get(String(occ.payment_id));
    if (!pmt) continue;
    const slotDate = occ.original_due_date || occ.due_date;
    slots.push({ payment: pmt, slotDate, dueDate: occ.due_date });
    events.push({
      date: occ.due_date < asOf ? asOf : occ.due_date,
      amount_cents: -pmt.amount_cents,
      type: "expense",
      name: pmt.name,
    });
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

        if (dueIso >= asOf && dueIso < windowEnd) {
          const key = paymentOccurrenceKey(String(pmt.id), dueIso);
          if (!covered.has(key)) {
            generated.add(key);
            slots.push({ payment: pmt, slotDate: dueIso, dueDate: dueIso });
            events.push({
              date: dueIso,
              amount_cents: -pmt.amount_cents,
              type: "expense",
              name: pmt.name,
            });
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
            generated.add(key);
            slots.push({ payment: pmt, slotDate: current, dueDate: current });
            events.push({
              date: current,
              amount_cents: -pmt.amount_cents,
              type: "expense",
              name: pmt.name,
            });
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

  return { events, generated, slots };
}

export function buildScenarioFromLedger(
  state: LedgerState,
  asOf: string,
  horizonDays: number = 90,
  includeSimulation?: any
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
  const events: any[] = [];

  // 1. Materialize Income Occurrences
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
        events.push({
          date: current,
          amount_cents: amount,
          type: "income",
          name: inc.name,
        });
        firstInWindow = false;
      }
      const nextDate = getNextDate(current, inc.frequency, incomeAnchorDay);
      if (nextDate <= current) break;
      current = nextDate;
      guard++;
    }
  }

  const bills = projectBillPayments(state, asOf, windowEnd);
  events.push(...bills.events);

  // 3. Future-dated posted transactions are events, not opening cash.
  const futureTransactions = state.transactions.filter(
    (tx) => tx.date > asOf && tx.date < windowEnd
  );
  for (const tx of futureTransactions) {
    const type = tx.type === "Income" ? "income" : tx.type === "Expense" ? "expense" : "adjustment";
    events.push({
      date: tx.date,
      amount_cents: tx.amount_cents,
      type,
      name: tx.description || tx.category || "Planned transaction",
    });
  }

  // 4. Entered debt minimums become ordinary cash outflows (Contract callers add events;
  // the engine still does not auto-inject). Linked bills cover only their matching slot.
  events.push(...liabilityMinPaymentEvents(
    state.liabilities ?? [], state.payments, state.bill_occurrences, state.transactions, bills.generated, asOf, windowEnd,
  ));

  const futureOutflow = state.transactions
    .filter((tx) => tx.date > asOf)
    .reduce((sum, tx) => sum + BigInt(tx.amount_cents), 0n);
  const startingBalance = toSafeNumber(BigInt(state.current_balance_cents) - futureOutflow);

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
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  if (payment.recurrence === "One-time" && payment.due_date) {
    const [dueYear, dueMonth] = payment.due_date.split("-").map(Number);
    return dueYear === year && dueMonth === month ? payment.due_date : null;
  }
  return null;
}

function liabilityMinPaymentEvents(
  liabilities: LiabilityItem[],
  payments: PaymentItem[],
  occurrences: {
    payment_id: number | string;
    due_date: string;
    original_due_date?: string | null;
    paid: boolean;
    transaction_id?: number | string | null;
  }[],
  transactions: { id?: number | string; amount_cents: number }[],
  generatedSlots: ReadonlySet<string>,
  asOf: string,
  windowEnd: string
): any[] {
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
  const [endYear, endMonth] = windowEnd.split("-").map(Number);
  const totalMonths = (endYear - startYear) * 12 + (endMonth - startMonth) + 2;
  const events: any[] = [];

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

    let remainingBalance = liability.balance_cents;
    let firstDue = true;
    for (let i = 0; i < totalMonths; i++) {
      const curM = startMonth + i;
      const curY = startYear + Math.floor((curM - 1) / 12);
      const actualM = ((curM - 1) % 12) + 1;
      const maxD = new Date(Date.UTC(curY, actualM, 0)).getUTCDate();
      if (!firstDue) {
        const interest = toSafeNumber(
          roundHalfAway(
            BigInt(remainingBalance) * BigInt(liability.apr_basis_points),
            120_000n
          )
        );
        remainingBalance = toSafeNumber(
          checkedAdd(BigInt(remainingBalance), BigInt(interest))
        );
      }
      firstDue = false;
      const amount = planningMinimumPaymentCents(liability, remainingBalance);
      if (amount <= 0) break;
      const d = Math.min(dueDay, maxD);
      const fallbackDueIso = `${curY}-${String(actualM).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      // The linked bill owns this debt's slot for the month. Using the debt's stored
      // due day here would charge a second minimum whenever the two dates differ.
      const dueIso = linkedPayment
        ? linkedPaymentSlot(linkedPayment, curY, actualM) ?? fallbackDueIso
        : fallbackDueIso;
      // A minimum whose due day passed earlier this month is still owed. Project it
      // at the start of the window so today's available-cash estimate includes it.
      const eventDate = dueIso < asOf ? asOf : dueIso;
      let coveredCents = 0;
      if (linkedPayment) {
        const slots = occurrenceSlots.get(String(liability.linked_payment_id));
        let occurrence = slots?.get(dueIso);
        // A past edit can change the bill's due day while an occurrence keeps the
        // original slot. The month still identifies the same scheduled payment.
        if (!occurrence && linkedPayment.recurrence === "Monthly" && slots) {
          const month = dueIso.slice(0, 7);
          for (const candidate of slots.values()) {
            if ((candidate.original_due_date || candidate.due_date).slice(0, 7) === month) {
              occurrence = candidate;
              break;
            }
          }
        }
        const occurrenceAmount = occurrence?.paid && occurrence.transaction_id != null
          ? Math.abs(transactionById.get(String(occurrence.transaction_id))?.amount_cents ?? linkedPayment.amount_cents)
          : linkedPayment.amount_cents;
        const occurrenceCovers = occurrence !== undefined;
        const generatedCovers = generatedSlots.has(`${linkedPayment.id}::${dueIso}`);
        if (occurrenceCovers || generatedCovers) coveredCents = occurrenceAmount;
        const paidCoverage = occurrenceCovers && occurrence?.paid;
        const shortfall = Math.max(0, amount - coveredCents);
        const principalReduction = paidCoverage ? shortfall : amount;
        if (eventDate < windowEnd && shortfall > 0) {
          events.push({ date: eventDate, amount_cents: -shortfall, type: "expense", name });
        }
        if (eventDate < windowEnd) remainingBalance -= principalReduction;
        continue;
      }
      if (eventDate < windowEnd) {
        events.push({ date: eventDate, amount_cents: -amount, type: "expense", name });
        remainingBalance -= amount;
      }
      if (`${curY}-${String(actualM).padStart(2, "0")}-01` >= windowEnd) break;
    }
  }
  return events;
}
