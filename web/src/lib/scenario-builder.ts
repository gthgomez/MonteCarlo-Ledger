import { LedgerState } from "./types";

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

export function buildScenarioFromLedger(
  state: LedgerState,
  asOf: string,
  horizonDays: number = 90,
  includeSimulation?: any
): any {
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

  // 2. Materialize Bill Payments from persisted occurrence state.
  //    Persisted rows are authoritative; a moved row keeps its scheduled slot via
  //    original_due_date, so the original date is never regenerated. Read-only and
  //    write paths therefore share one projection rule (Android/Python parity).
  const paymentById = new Map(state.payments.map((p) => [String(p.id), p] as const));
  const represented = new Set<string>();
  const suppressed = new Set<string>();
  const occurrenceKey = (paymentId: number | string, date: string) => `${paymentId}::${date}`;
  for (const occ of state.bill_occurrences) {
    const slot = occ.original_due_date || occ.due_date;
    represented.add(occurrenceKey(occ.payment_id, slot));
    if (occ.paid || occ.is_user_modified) {
      suppressed.add(occurrenceKey(occ.payment_id, slot));
    }
    if (occ.is_user_modified) {
      suppressed.add(occurrenceKey(occ.payment_id, occ.due_date));
    }
  }
  for (const occ of state.bill_occurrences) {
    if (occ.paid) continue;
    if (!(occ.due_date >= asOf && occ.due_date < windowEnd)) continue;
    const pmt = paymentById.get(String(occ.payment_id));
    if (!pmt) continue;
    events.push({
      date: occ.due_date,
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
          const key = occurrenceKey(String(pmt.id), dueIso);
          if (!represented.has(key) && !suppressed.has(key)) {
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
          const key = occurrenceKey(String(pmt.id), current);
          if (!represented.has(key) && !suppressed.has(key)) {
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
  const futureOutflow = state.transactions
    .filter((tx) => tx.date > asOf)
    .reduce((sum, tx) => sum + tx.amount_cents, 0);
  const startingBalance = state.current_balance_cents - futureOutflow;

  const scenario: any = {
    contract_version: "2.0",
    scenario_id: `ledger-${asOf}-${horizonDays}`,
    as_of: asOf,
    starting_balance_cents: startingBalance,
    horizon_days: horizonDays,
    events,
  };

  if (state.liabilities && state.liabilities.length > 0) {
    scenario.liabilities = state.liabilities.map((l) => {
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
