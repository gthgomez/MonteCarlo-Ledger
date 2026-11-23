import { unresolvedPastOneTimeSlots } from "./scenario-builder";
import { LedgerState } from "./types";

export interface OverdueAssessment {
  count: number;
  total_cents: number;
  earliest_date: string | null;
  /** Past-due one-time slots with no stored occurrence; these are not in the cash plan. */
  unresolved_one_time_count?: number;
  unresolved_one_time_cents?: number;
}

/**
 * Unpaid obligations whose due date is before `asOf`.
 *
 * The bill adapter brings recorded unpaid occurrences into the plan on `asOf`.
 * This assessment describes their original overdue state, not extra cash events.
 * A one-time bill with no stored occurrence is reported for resolution but is
 * deliberately not turned into a historical expense.
 */
export function computeOverdueObligations(
  state: LedgerState,
  asOf: string
): OverdueAssessment {
  const amountByPayment = new Map(
    state.payments.map((p) => [String(p.id), p.amount_cents] as const)
  );
  let count = 0;
  let total = 0;
  let earliest: string | null = null;
  for (const occ of state.bill_occurrences) {
    if (occ.paid) continue;
    if (!(occ.due_date < asOf)) continue;
    const amount = amountByPayment.get(String(occ.payment_id));
    if (amount === undefined) continue;
    count += 1;
    total += amount;
    if (earliest === null || occ.due_date < earliest) earliest = occ.due_date;
  }
  let unresolvedCount = 0;
  let unresolvedTotal = 0;
  for (const slot of unresolvedPastOneTimeSlots(state, asOf)) {
    unresolvedCount += 1;
    unresolvedTotal += slot.payment.amount_cents;
    if (earliest === null || slot.dueDate < earliest) earliest = slot.dueDate;
  }
  count += unresolvedCount;
  total += unresolvedTotal;
  const assessment: OverdueAssessment = { count, total_cents: total, earliest_date: earliest };
  if (unresolvedCount > 0) {
    assessment.unresolved_one_time_count = unresolvedCount;
    assessment.unresolved_one_time_cents = unresolvedTotal;
  }
  return assessment;
}
