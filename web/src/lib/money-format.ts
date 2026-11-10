/** Display formatting only. Does not round ledger cents. */

export function formatMoney(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents) / 100;
  return `${sign}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

/**
 * Parts-per-million where 1_000_000 = 100%.
 * Tiny non-zero probabilities are not rounded to 0.0%.
 */
export function formatProbability(ppm: number): string {
  if (!Number.isFinite(ppm)) return "—";
  const percent = ppm / 10_000;
  if (percent === 0) return "0%";
  if (percent > 0 && percent < 0.1) return "under 0.1%";
  const rounded = Math.round(percent * 10) / 10;
  if (Number.isInteger(rounded)) return `${rounded.toFixed(0)}%`;
  return `${rounded.toFixed(1)}%`;
}

export function explainEngineCode(code: string): string {
  switch (code) {
    case "INVALID_AMOUNT":
      return "The amount is not a valid whole number of cents.";
    case "INVALID_DATE":
      return "That date is not a real calendar day.";
    case "EVENT_OUT_OF_HORIZON":
      return "That date is outside the plan window. Pick a date inside the window, or extend it under Advanced.";
    case "NO_INCOME":
      return "There is no paycheck scheduled in this window, so a delay cannot be modeled.";
    case "PAYMENT_NOT_FOUND":
      return "That bill is no longer in the ledger.";
    case "MONEY_OVERFLOW":
      return "A number exceeded the supported range. No result is shown.";
    case "INVALID_HORIZON":
      return "That time window is not supported.";
    case "INVALID_QUANTILE":
      return "That outcome rank is not supported.";
    case "INVALID_RUNS":
      return "That number of modeled futures is not supported.";
    default:
      return "The financial engine could not complete this calculation. No number was substituted.";
  }
}
