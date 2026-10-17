/**
 * Money semantics for MonteCarlo Contract 1.0/2.0. No floating point.
 */

export const MAX_MONEY_CENTS = (1n << 63n) - 1n;
export const MIN_MONEY_CENTS = -MAX_MONEY_CENTS;

export class ContractError extends Error {
  code: string;

  constructor(code: string, message: string = "") {
    super(message ? `${code}: ${message}` : code);
    this.name = "ContractError";
    this.code = code;
  }
}

/**
 * Round n/d to nearest integer, ties away from zero. d > 0.
 */
export function roundHalfAway(n: bigint, d: bigint): bigint {
  if (d <= 0n) {
    throw new Error("denominator must be positive");
  }
  if (n === 0n) {
    return 0n;
  }
  const sign = n > 0n ? 1n : -1n;
  const absN = n > 0n ? n : -n;
  return sign * ((absN + d / 2n) / d);
}

/**
 * Scale an amount by a signed percent variation: (100 + percent)% of the amount.
 */
export function scaleCentsByPercent(amountCents: bigint, percent: bigint): bigint {
  return roundHalfAway(amountCents * (100n + percent), 100n);
}

export function scaleCentsByBasisPoints(amountCents: bigint, bps: bigint): bigint {
  return roundHalfAway(amountCents * bps, 10000n);
}

export function checkedAdd(a: bigint, b: bigint): bigint {
  const r = a + b;
  if (r > MAX_MONEY_CENTS || r < MIN_MONEY_CENTS) {
    throw new ContractError("MONEY_OVERFLOW", `${a} + ${b}`);
  }
  return r;
}
