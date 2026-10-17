/**
 * Debt / amortization domain for MonteCarlo Contract 2.0 (debt 1.0).
 * Pure and clock-free. Integer cents and roundHalfAway only.
 */

import { ContractError, MAX_MONEY_CENTS, roundHalfAway } from "./money";

export const STRATEGIES = ["snowball", "avalanche"] as const;
export type DebtStrategy = (typeof STRATEGIES)[number];

const KINDS = ["installment", "revolving"] as const;
const REQUIRED_NON_NEGATIVE = ["balance_cents", "apr_basis_points", "min_payment_cents"] as const;
const OPTIONAL_NON_NEGATIVE = ["min_payment_percent_bps", "min_payment_floor_cents"] as const;
const MAX_MONTHS = 360;
const APR_DENOMINATOR = 120000n;
const PERCENT_DENOMINATOR = 10000n;

function parseIsoDate(str: string): { year: number; month: number; day: number } {
  const parts = str.split("-").map(Number);
  if (parts.length !== 3 || parts.some(isNaN)) {
    throw new ContractError("INVALID_DATE", str);
  }
  return { year: parts[0], month: parts[1], day: parts[2] };
}

function formatIsoDate(year: number, month: number, day: number): string {
  const y = String(year).padStart(4, "0");
  const m = String(month).padStart(2, "0");
  const d = String(day).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addMonths(iso: string, months: number): string {
  const parsed = parseIsoDate(iso);
  const totalMonths = parsed.year * 12 + (parsed.month - 1) + months;
  const year = Math.floor(totalMonths / 12);
  const month = (totalMonths % 12) + 1;
  const maxDay = daysInMonth(year, month);
  const day = Math.min(parsed.day, maxDay);
  return formatIsoDate(year, month, day);
}

export function validateLiabilities(liabilities: any): void {
  if (!Array.isArray(liabilities)) {
    throw new ContractError("SCHEMA_INVALID", "liabilities must be an array");
  }
  const seen = new Set<string>();
  for (let index = 0; index < liabilities.length; index++) {
    const liability = liabilities[index];
    if (typeof liability !== "object" || liability === null || Array.isArray(liability)) {
      throw new ContractError("SCHEMA_INVALID", `liability[${index}] must be an object`);
    }
    const lid = liability.id;
    if (typeof lid !== "string") {
      throw new ContractError("SCHEMA_INVALID", `liability[${index}] id must be a string`);
    }
    if (seen.has(lid)) {
      throw new ContractError("SCHEMA_INVALID", `duplicate liability id '${lid}'`);
    }
    seen.add(lid);
    const kind = liability.kind ?? "installment";
    if (!KINDS.includes(kind)) {
      throw new ContractError("SCHEMA_INVALID", `liability '${lid}' kind '${kind}'`);
    }
    for (const field of REQUIRED_NON_NEGATIVE) {
      const value = liability[field];
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
        throw new ContractError("SCHEMA_INVALID", `liability '${lid}' ${field} must be an integer >= 0`);
      }
    }
    for (const field of OPTIONAL_NON_NEGATIVE) {
      if (field in liability) {
        const value = liability[field];
        if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
          throw new ContractError("SCHEMA_INVALID", `liability '${lid}' ${field} must be an integer >= 0`);
        }
      }
    }
  }
}

function monthlyInterest(balance: bigint, aprBasisPoints: bigint): bigint {
  return roundHalfAway(balance * aprBasisPoints, APR_DENOMINATOR);
}

function minimumPayment(liability: any, balanceAfterInterest: bigint): bigint {
  if (balanceAfterInterest <= 0n) {
    return 0n;
  }
  if ((liability.kind ?? "installment") !== "revolving") {
    const minPmt = BigInt(liability.min_payment_cents);
    return minPmt < balanceAfterInterest ? minPmt : balanceAfterInterest;
  }
  const percentBps = BigInt(liability.min_payment_percent_bps ?? 0);
  const percent = roundHalfAway(balanceAfterInterest * percentBps, PERCENT_DENOMINATOR);
  const floor = BigInt(liability.min_payment_floor_cents ?? 0);
  const target = percent > floor ? percent : floor;
  return target < balanceAfterInterest ? target : balanceAfterInterest;
}

export function amortize(
  asOf: string,
  liabilities: any[],
  strategy: string,
  extraMonthlyPaymentCents: number = 0
): any {
  if (!STRATEGIES.includes(strategy as DebtStrategy)) {
    throw new ContractError("SCHEMA_INVALID", `unknown debt strategy '${strategy}'`);
  }
  validateLiabilities(liabilities);

  const balances: Record<string, bigint> = {};
  for (const l of liabilities) {
    balances[l.id] = BigInt(l.balance_cents);
  }

  let months = 0;
  let totalInterest = 0n;
  let totalPaid = 0n;
  const schedule: any[] = [];
  let overflowed = false;

  const extraPoolBig = BigInt(extraMonthlyPaymentCents);

  while (months < MAX_MONTHS && Object.values(balances).some((b) => b > 0n) && !overflowed) {
    months += 1;
    const monthDate = addMonths(asOf, months);

    const active = liabilities.filter((l) => balances[l.id] > 0n);
    let order: any[];
    if (strategy === "snowball") {
      order = [...active].sort((a, b) => {
        const balA = balances[a.id];
        const balB = balances[b.id];
        if (balA < balB) return -1;
        if (balA > balB) return 1;
        return liabilities.indexOf(a) - liabilities.indexOf(b);
      });
    } else {
      order = [...active].sort((a, b) => {
        const aprDiff = b.apr_basis_points - a.apr_basis_points;
        if (aprDiff !== 0) return aprDiff;
        return liabilities.indexOf(a) - liabilities.indexOf(b);
      });
    }

    let extraPool = extraPoolBig;
    const monthRows: Record<string, any> = {};

    for (const liability of order) {
      const lid = liability.id;
      const interest = monthlyInterest(balances[lid], BigInt(liability.apr_basis_points));
      if (interest > MAX_MONEY_CENTS - balances[lid]) {
        overflowed = true;
        break;
      }
      const starting = balances[lid];
      balances[lid] += interest;
      totalInterest += interest;
      const payment = minimumPayment(liability, balances[lid]);
      balances[lid] -= payment;
      totalPaid += payment;

      const row = {
        month: months,
        date: monthDate,
        liability_id: lid,
        starting_balance_cents: Number(starting),
        payment_cents: Number(payment),
        interest_cents: Number(interest),
        principal_cents: Number(payment - interest),
        ending_balance_cents: Number(balances[lid]),
      };
      schedule.push(row);
      monthRows[lid] = row;
    }

    if (!overflowed) {
      for (const liability of order) {
        if (extraPool <= 0n) break;
        const lid = liability.id;
        if (balances[lid] <= 0n) continue;
        const extra = extraPool < balances[lid] ? extraPool : balances[lid];
        balances[lid] -= extra;
        extraPool -= extra;
        totalPaid += extra;
        const row = monthRows[lid];
        row.payment_cents += Number(extra);
        row.principal_cents += Number(extra);
        row.ending_balance_cents = Number(balances[lid]);
      }
    }
  }

  const didNotConverge = overflowed || Object.values(balances).some((b) => b > 0n);
  return {
    strategy,
    extra_monthly_payment_cents: extraMonthlyPaymentCents,
    months_to_payoff: months,
    payoff_date: addMonths(asOf, months),
    total_interest_cents: Number(totalInterest),
    total_paid_cents: Number(totalPaid),
    did_not_converge: didNotConverge,
    schedule,
  };
}
