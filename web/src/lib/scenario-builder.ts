import { LedgerState } from "./types";

function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return date.toISOString().split("T")[0];
}

function getNextDate(iso: string, frequency: string): string {
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
      date.setUTCMonth(date.getUTCMonth() + 1);
      break;
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
    let guard = 0;
    while (current < windowEnd && guard < 1000) {
      if (current >= asOf) {
        events.push({
          date: current,
          amount_cents: inc.amount_cents,
          type: "income",
          name: inc.name,
        });
      }
      const nextDate = getNextDate(current, inc.frequency);
      if (nextDate <= current) break;
      current = nextDate;
      guard++;
    }
  }

  // 2. Materialize Bill Payments
  const paidSet = new Set(
    state.bill_occurrences
      .filter((o) => o.paid)
      .map((o) => `${o.payment_id}::${o.due_date}`)
  );

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
          if (!paidSet.has(`${pmt.id}::${dueIso}`)) {
            events.push({
              date: dueIso,
              amount_cents: -Math.abs(pmt.amount_cents),
              type: "expense",
              name: pmt.name,
            });
          }
        }
      }
    } else if (pmt.due_date) {
      let current = pmt.due_date;
      let guard = 0;
      while (current < windowEnd && guard < 1000) {
        if (current >= asOf) {
          if (!paidSet.has(`${pmt.id}::${current}`)) {
            events.push({
              date: current,
              amount_cents: -Math.abs(pmt.amount_cents),
              type: "expense",
              name: pmt.name,
            });
          }
        }
        if (pmt.recurrence === "One-time") break;
        const nxt = getNextDate(current, pmt.recurrence);
        if (nxt <= current) break;
        current = nxt;
        guard++;
      }
    }
  }

  const scenario: any = {
    contract_version: "2.0",
    scenario_id: `ledger-${asOf}-${horizonDays}`,
    as_of: asOf,
    starting_balance_cents: state.current_balance_cents,
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
