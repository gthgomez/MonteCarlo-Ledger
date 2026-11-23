import { LedgerState } from "./types";

export interface OverdueAssessment {
  count: number;
  total_cents: number;
  earliest_date: string | null;
}

/**
 * Unpaid obligations whose due date is before `asOf`.
 *
 * The bill adapter brings recorded unpaid occurrences into the plan on `asOf`.
 * This assessment describes their original overdue state, not extra cash events.
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
  return { count, total_cents: total, earliest_date: earliest };
}
