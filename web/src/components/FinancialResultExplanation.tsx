"use client";

import React from "react";
import { formatMoney } from "./SafeSpendHero";

interface ForecastSlice {
  minimum_balance_cents: number;
  minimum_balance_date: string;
  ending_balance_cents: number;
  first_negative_date: string | null;
}

interface RiskSlice {
  negative_balance_probability_ppm: number;
  minimum_balance_p10_cents: number;
  safe_to_spend_cents: number;
}

export interface FinancialResultExplanationProps {
  asOf: string;
  recordedBalanceCents: number;
  horizonDays: number;
  simulation: { runs: number; seed: number; quantile_num: number; quantile_den: number };
  forecast: ForecastSlice;
  risk: RiskSlice;
  transactionCount: number;
  incomeCount: number;
  paymentCount: number;
  liabilityCount: number;
  isDemo: boolean;
}

export function FinancialResultExplanation({
  asOf,
  recordedBalanceCents,
  horizonDays,
  simulation,
  forecast,
  risk,
  transactionCount,
  incomeCount,
  paymentCount,
  liabilityCount,
  isDemo,
}: FinancialResultExplanationProps) {
  const overdraftPct = (risk.negative_balance_probability_ppm / 10000).toFixed(1);
  const reserveBasis = `p${simulation.quantile_num} trough (nearest-rank ${simulation.quantile_num}/${simulation.quantile_den})`;

  return (
    <section
      className="rounded-2xl border border-slate-800/80 bg-slate-900/40 p-5 space-y-4"
      aria-label="How these numbers were calculated"
    >
      <header>
        <h2 className="text-sm font-bold text-slate-100 uppercase tracking-wider">
          What these numbers mean
        </h2>
        <p className="text-xs text-slate-400 mt-1">
          All figures come from Contract 2.0 engine output for{" "}
          <span className="text-slate-300 font-medium">as-of {asOf}</span>. Nothing below is
          guessed or invented by AI.
        </p>
      </header>

      <dl className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
        <div className="space-y-1">
          <dt className="font-semibold text-slate-300">Recorded position</dt>
          <dd className="text-slate-400">
            Sum of {transactionCount} stored transactions ={" "}
            <span className="text-slate-200 font-medium">{formatMoney(recordedBalanceCents)}</span>.
            This is ledger arithmetic, not a forecast.
          </dd>
        </div>
        <div className="space-y-1">
          <dt className="font-semibold text-slate-300">Deterministic forecast ({horizonDays}d)</dt>
          <dd className="text-slate-400">
            Expected low point {formatMoney(forecast.minimum_balance_cents)} on{" "}
            {forecast.minimum_balance_date}; ending balance{" "}
            {formatMoney(forecast.ending_balance_cents)}.
            {forecast.first_negative_date
              ? ` First shortfall modeled on ${forecast.first_negative_date}.`
              : " No negative balance in the deterministic path."}
          </dd>
        </div>
        <div className="space-y-1">
          <dt className="font-semibold text-slate-300">Monte Carlo risk</dt>
          <dd className="text-slate-400">
            {simulation.runs} runs (seed {simulation.seed}) estimate a{" "}
            <span className="text-slate-200">{overdraftPct}%</span> chance of going negative in
            the window. This is a model probability, not a guarantee.
          </dd>
        </div>
        <div className="space-y-1">
          <dt className="font-semibold text-slate-300">Safe to spend</dt>
          <dd className="text-slate-400">
            {formatMoney(risk.safe_to_spend_cents)} = {reserveBasis} minimum (
            {formatMoney(risk.minimum_balance_p10_cents)}) relative to today&rsquo;s balance.
            Treat as conservative spending headroom, not &ldquo;extra money.&rdquo;
          </dd>
        </div>
      </dl>

      <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-3 text-xs text-slate-400 space-y-1">
        <p className="font-semibold text-slate-300">Inputs & limitations</p>
        <ul className="list-disc list-inside space-y-0.5">
          <li>
            {incomeCount} income source(s), {paymentCount} bill(s), {liabilityCount} liability
            record(s) in this ledger.
          </li>
          {isDemo && <li>Demo household — replace with your data before personal decisions.</li>}
          <li>
            Sparse or stale history widens model uncertainty; probabilities can look precise even
            when evidence is thin.
          </li>
          <li>Debt payoff tabs use amortization only; they are not merged into the cash-flow path.</li>
        </ul>
      </div>
    </section>
  );
}
