"use client";

import React, { useRef, useState } from "react";
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

type SettingsDraft = ReturnType<typeof draftFrom>;
type SettingsDraftKey = keyof SettingsDraft;

export function AdvancedView({
  assumptions,
  outcome,
  asOf,
  showGuidance,
  onApply,
  onDraftOutcome,
  saving,
}: {
  assumptions: Assumptions;
  outcome: ModelOutcome | null;
  asOf: string;
  showGuidance: boolean;
  onApply: (next: Assumptions) => Promise<string | null>;
  onDraftOutcome: (failed: boolean) => void;
  saving: boolean;
}) {
  // Only fields this tab has edited are kept locally. Every other field follows
  // the applied assumptions, including a valid update from another tab or the
  // global settings recovery button. This prevents an applied refresh from
  // overwriting a typed or failed value without freezing the whole form.
  const [overrides, setOverrides] = useState<Partial<SettingsDraft>>({});
  const [error, setError] = useState<string | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);
  // The prop only updates after the parent renders. This ref makes a second
  // submit in the same event loop turn fail immediately, before any state has
  // committed and while the user's exact submitted values are still visible.
  const submitInFlightRef = useRef(false);
  const applied = draftFrom(assumptions);
  const draft: SettingsDraft = { ...applied, ...overrides };
  const hasDraft = Object.keys(overrides).length > 0;
  const pending = saving || savingDraft;

  function set<K extends SettingsDraftKey>(key: K, value: string) {
    if (pending || submitInFlightRef.current) return;
    setOverrides((current) => {
      const next = { ...current };
      if (value === applied[key]) delete next[key];
      else next[key] = value;
      return next;
    });
  }

  async function submit(next: Assumptions): Promise<void> {
    if (saving || submitInFlightRef.current) return;
    submitInFlightRef.current = true;
    setSavingDraft(true);
    try {
      const persistenceError = await onApply(next);
      if (persistenceError) {
        // A real persistence failure keeps the submitted values and its error.
        setError(persistenceError);
        onDraftOutcome(true);
        return;
      }
      setError(null);
      setOverrides({});
      onDraftOutcome(false);
    } finally {
      submitInFlightRef.current = false;
      setSavingDraft(false);
    }
  }

  async function apply(event: React.FormEvent) {
    event.preventDefault();
    if (saving || submitInFlightRef.current) return;
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
      // A validation failure never reached storage, so it is not a saved draft.
      setError(problem);
      return;
    }
    await submit(next);
  }

  async function useDefaults() {
    if (saving || submitInFlightRef.current) return;
    if (hasDraft && !window.confirm(
      "If the defaults are saved, this discards the unsaved settings values you changed here. Continue?"
    )) {
      return;
    }
    await submit(DEFAULT_ASSUMPTIONS);
  }

  function discardDraft() {
    // Explicit discard returns the form to the applied settings. It does not
    // write, and it releases this form's failed-draft marker. It cannot run
    // while a save is pending, because that save still owes this form an answer.
    if (saving || submitInFlightRef.current) return;
    setOverrides({});
    setError(null);
    onDraftOutcome(false);
  }

  return (
    <div className="space-y-6">
      <Panel
        title="Assumptions behind every result"
        lede="Changing these updates the same plan used on Home, Bills, Plan, and Future. There is not a separate advanced forecast."
      >
        <form onSubmit={apply} aria-busy={pending}>
          <fieldset
            disabled={pending}
            aria-label="Forecast assumptions"
            className="m-0 grid w-full min-w-0 grid-cols-1 gap-3 border-0 p-0 sm:grid-cols-2"
          >
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
              <Button type="button" variant="quiet" onClick={useDefaults}>
                Use the default assumptions
              </Button>
              {(hasDraft || error) && (
                <Button type="button" variant="quiet" onClick={discardDraft}>
                  Discard settings draft
                </Button>
              )}
            </div>
          </fieldset>
        </form>
        <p className={`mt-3 text-sm ${hasDraft ? "font-medium text-ink" : "text-muted"}`} role="status">
          {hasDraft
            ? "Unsaved settings draft. Forecasts use checked settings, not the draft."
            : outcome
              ? "These fields match the applied settings used by results."
              : "No forecast is using these settings right now."}
        </p>
        <p className="mt-3 text-sm text-muted">
          This screen limits modeled futures to {UI_MAX_RUNS} so the page stays responsive. The engine can run more,
          but those extra runs are not offered here. A higher rank makes the cautious amount less cautious.
        </p>
      </Panel>

      {outcome && (showGuidance ? <Panel title="Technical result" lede="These fields are the engine output for the assumptions currently applied. They are estimates.">
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
      </Panel> : (
        <Notice tone="info">Modeled spending and risk results need a bill or other upcoming payment. You can still change the assumptions above.</Notice>
      ))}
    </div>
  );
}
