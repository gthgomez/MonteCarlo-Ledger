"use client";

import React, { useState } from "react";
import {
  assumptionError,
  DEFAULT_ASSUMPTIONS,
  type Assumptions,
  UI_MAX_HORIZON_DAYS,
  UI_MAX_RUNS,
} from "@/lib/assumptions";
import { dollarsToCents } from "@/lib/ledger-edits";
import { formatMoney } from "@/lib/money-format";
import { type ModelOutcome } from "@/lib/scenarios";
import { Button, fieldClass, Notice, Panel } from "./ui";

function draftFrom(assumptions: Assumptions) {
  return {
    horizonDays: String(assumptions.horizonDays),
    runs: String(assumptions.runs),
    seed: String(assumptions.seed),
    quantile: `${assumptions.quantileNum}/${assumptions.quantileDen}`,
    incomeMin: String(assumptions.incomeVariationMin),
    incomeMax: String(assumptions.incomeVariationMax),
    expenseMin: String(assumptions.expenseVariationMin),
    expenseMax: String(assumptions.expenseVariationMax),
    surprisePercent: String(assumptions.surpriseProbabilityPpm / 10_000),
    surpriseMin: (assumptions.surpriseAmountMin / 100).toFixed(2),
    surpriseMax: (assumptions.surpriseAmountMax / 100).toFixed(2),
    surpriseEvery: String(assumptions.surpriseIntervalDays),
    reserve: (assumptions.reserveCents / 100).toFixed(2),
  };
}

export function AdvancedView({
  assumptions,
  outcome,
  asOf,
  onApply,
}: {
  assumptions: Assumptions;
  outcome: ModelOutcome;
  asOf: string;
  onApply: (next: Assumptions) => void;
}) {
  const [draft, setDraft] = useState(() => draftFrom(assumptions));
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof typeof draft>(key: K, value: string) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function apply(event: React.FormEvent) {
    event.preventDefault();
    const [num, den] = draft.quantile.split("/").map(Number);
    const surprisePercent = Number(draft.surprisePercent);
    const surpriseMin = dollarsToCents(Number(draft.surpriseMin));
    const surpriseMax = dollarsToCents(Number(draft.surpriseMax));
    const reserve = dollarsToCents(Number(draft.reserve));
    if (surpriseMin === null || surpriseMax === null || reserve === null || !Number.isFinite(surprisePercent)) {
      setError("Amounts must be dollars and cents. The unexpected-expense chance must be a percent.");
      return;
    }
    const next: Assumptions = {
      horizonDays: Number(draft.horizonDays),
      runs: Number(draft.runs),
      seed: Number(draft.seed),
      quantileNum: num,
      quantileDen: den,
      incomeVariationMin: Number(draft.incomeMin),
      incomeVariationMax: Number(draft.incomeMax),
      expenseVariationMin: Number(draft.expenseMin),
      expenseVariationMax: Number(draft.expenseMax),
      surpriseProbabilityPpm: Math.round(surprisePercent * 10_000),
      surpriseAmountMin: surpriseMin,
      surpriseAmountMax: surpriseMax,
      surpriseIntervalDays: Number(draft.surpriseEvery),
      reserveCents: reserve,
    };
    const problem = assumptionError(next);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    onApply(next);
  }

  return (
    <div className="space-y-6">
      <Panel
        title="Assumptions behind every result"
        lede="Changing these updates the same plan used on Home, Bills, Plan, and Future. There is not a separate advanced forecast."
      >
        <form onSubmit={apply} className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm font-medium">
            Plan window (days, 1–{UI_MAX_HORIZON_DAYS})
            <input className={`${fieldClass} mt-1`} inputMode="numeric" value={draft.horizonDays} onChange={(e) => set("horizonDays", e.target.value)} />
          </label>
          <label className="text-sm font-medium">
            Modeled futures (1–{UI_MAX_RUNS})
            <input className={`${fieldClass} mt-1`} inputMode="numeric" value={draft.runs} onChange={(e) => set("runs", e.target.value)} />
          </label>
          <label className="text-sm font-medium">
            Seed
            <input className={`${fieldClass} mt-1`} inputMode="numeric" value={draft.seed} onChange={(e) => set("seed", e.target.value)} />
          </label>
          <label className="text-sm font-medium">
            Low-point rank used for the cautious amount
            <select className={`${fieldClass} mt-1`} value={draft.quantile} onChange={(e) => set("quantile", e.target.value)}>
              <option value="1/10">More difficult tenth (1/10)</option>
              <option value="1/2">Middle (1/2)</option>
              <option value="9/10">More favorable tenth (9/10)</option>
            </select>
          </label>
          <label className="text-sm font-medium">
            Income can fall to (%)
            <input className={`${fieldClass} mt-1`} inputMode="numeric" value={draft.incomeMin} onChange={(e) => set("incomeMin", e.target.value)} />
          </label>
          <label className="text-sm font-medium">
            Income can rise to (%)
            <input className={`${fieldClass} mt-1`} inputMode="numeric" value={draft.incomeMax} onChange={(e) => set("incomeMax", e.target.value)} />
          </label>
          <label className="text-sm font-medium">
            Bills can fall to (%)
            <input className={`${fieldClass} mt-1`} inputMode="numeric" value={draft.expenseMin} onChange={(e) => set("expenseMin", e.target.value)} />
          </label>
          <label className="text-sm font-medium">
            Bills can rise to (%)
            <input className={`${fieldClass} mt-1`} inputMode="numeric" value={draft.expenseMax} onChange={(e) => set("expenseMax", e.target.value)} />
          </label>
          <label className="text-sm font-medium">
            Unexpected expense chance each check (%)
            <input className={`${fieldClass} mt-1`} inputMode="decimal" value={draft.surprisePercent} onChange={(e) => set("surprisePercent", e.target.value)} />
          </label>
          <label className="text-sm font-medium">
            Check every (days)
            <input className={`${fieldClass} mt-1`} inputMode="numeric" value={draft.surpriseEvery} onChange={(e) => set("surpriseEvery", e.target.value)} />
          </label>
          <label className="text-sm font-medium">
            Smallest unexpected expense ($)
            <input className={`${fieldClass} mt-1`} inputMode="decimal" value={draft.surpriseMin} onChange={(e) => set("surpriseMin", e.target.value)} />
          </label>
          <label className="text-sm font-medium">
            Largest unexpected expense ($)
            <input className={`${fieldClass} mt-1`} inputMode="decimal" value={draft.surpriseMax} onChange={(e) => set("surpriseMax", e.target.value)} />
          </label>
          <label className="text-sm font-medium sm:col-span-2">
            Reserve to subtract from the chosen low point ($)
            <input className={`${fieldClass} mt-1`} inputMode="decimal" value={draft.reserve} onChange={(e) => set("reserve", e.target.value)} />
          </label>
          {error && (
            <p className="text-sm text-danger sm:col-span-2" role="alert">
              {error}
            </p>
          )}
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button type="submit">Update results</Button>
            <Button
              type="button"
              variant="quiet"
              onClick={() => {
                setDraft(draftFrom(DEFAULT_ASSUMPTIONS));
                setError(null);
                onApply(DEFAULT_ASSUMPTIONS);
              }}
            >
              Use the default assumptions
            </Button>
          </div>
        </form>
        <p className="mt-3 text-sm text-muted">
          This screen limits modeled futures to {UI_MAX_RUNS} so the page stays responsive. The engine can run more,
          but those extra runs are not offered here. A higher rank makes the cautious amount less cautious.
        </p>
      </Panel>

      <Panel title="Technical result" lede="These fields are the engine output for the assumptions currently applied. They are estimates.">
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted">As of</dt>
            <dd className="font-medium">{asOf}</dd>
          </div>
          <div>
            <dt className="text-muted">Scenario</dt>
            <dd className="break-all font-medium">{outcome.scenarioId}</dd>
          </div>
          <div>
            <dt className="text-muted">Contract</dt>
            <dd className="font-medium">2.0</dd>
          </div>
          <div>
            <dt className="text-muted">Seed / futures / window</dt>
            <dd className="font-medium">
              {outcome.seed} / {outcome.runs} / {outcome.horizonDays} days
            </dd>
          </div>
          <div>
            <dt className="text-muted">Cautious amount at rank {outcome.quantileNum}/{outcome.quantileDen}</dt>
            <dd className="font-medium tabular-nums">{formatMoney(outcome.safeSpendCents)}</dd>
          </div>
          <div>
            <dt className="text-muted">Negative balance probability (ppm)</dt>
            <dd className="font-medium tabular-nums">{outcome.overdraftPpm}</dd>
          </div>
          <div>
            <dt className="text-muted">minimum_balance_p10 / p50 / p90</dt>
            <dd className="font-medium tabular-nums">
              {formatMoney(outcome.minimumBalanceP10Cents)} / {formatMoney(outcome.minimumBalanceP50Cents)} /{" "}
              {formatMoney(outcome.minimumBalanceP90Cents)}
            </dd>
          </div>
          <div>
            <dt className="text-muted">ending_balance_p10 / p50 / p90</dt>
            <dd className="font-medium tabular-nums">
              {formatMoney(outcome.endingBalanceP10Cents)} / {formatMoney(outcome.endingBalanceP50Cents)} /{" "}
              {formatMoney(outcome.endingBalanceP90Cents)}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Deterministic low point</dt>
            <dd className="font-medium tabular-nums">
              {formatMoney(outcome.projectedLowCents)} on {outcome.projectedLowDate}
            </dd>
          </div>
          <div>
            <dt className="text-muted">Reserve subtracted</dt>
            <dd className="font-medium tabular-nums">{formatMoney(outcome.reserveCents)}</dd>
          </div>
        </dl>
        {outcome.quantileNum !== 1 || outcome.quantileDen !== 10 ? (
          <div className="mt-3">
            <Notice tone="warning">
              The cautious amount is using rank {outcome.quantileNum}/{outcome.quantileDen}, so it is not Safe to Spend
              (P10).
            </Notice>
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted">
            With the default rank, the cautious amount and Safe to Spend (P10) are the same figure.
          </p>
        )}
      </Panel>
    </div>
  );
}
