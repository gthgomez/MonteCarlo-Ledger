"use client";

import React from "react";
import { cautiousAmountHeading, cautiousAmountShortName, quantilePlainName } from "@/lib/assumptions";
import { addDaysIso, formatDateLabel } from "@/lib/dates";
import { formatMoney, formatProbability } from "@/lib/money-format";
import { formatCautiousSpend } from "@/lib/present";
import { type ModelOutcome } from "@/lib/scenarios";
import type { TimelineRow } from "@/contract/engine";
import { Explain, Notice } from "./ui";
import { TimelineChart } from "./TimelineChart";

function RangeStat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <section className="min-w-0 rounded-xl border border-line bg-surface p-3">
      <h4 className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">{label}</h4>
      <p className="mt-1 text-xl font-semibold tabular-nums tracking-tight text-ink">{value}</p>
      <p className="mt-1 text-xs text-muted">{detail}</p>
    </section>
  );
}

export function FutureView({
  asOf,
  outcome,
  rows,
  showGuidance,
  assumptionsChanged,
}: {
  asOf: string;
  outcome: ModelOutcome;
  rows: TimelineRow[];
  showGuidance: boolean;
  assumptionsChanged: boolean;
}) {
  const rank = quantilePlainName(outcome.quantileNum, outcome.quantileDen);
  const negativeRuns = Math.round((outcome.overdraftPpm / 1_000_000) * outcome.runs);
  const windowEnd = addDaysIso(asOf, Math.max(outcome.horizonDays - 1, 0));
  const isNonDefaultRank = outcome.quantileNum * 10 !== outcome.quantileDen;

  return (
    <div className="space-y-6">
      {assumptionsChanged && (
        <Notice tone="warning">These results use settings you changed under Advanced.</Notice>
      )}

      <section
        aria-labelledby="future-exact-heading"
        className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card"
      >
        <div className="bg-[color:var(--forest)] px-4 py-4 text-[color:var(--forest-text)] sm:px-6">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--signature)]">Exact schedule</p>
            <span className="rounded-full border border-[color:var(--forest-muted)] px-2.5 py-0.5 text-xs font-medium text-[color:var(--forest-muted)]">
              {outcome.horizonDays}-day plan
            </span>
          </div>
          <h2 id="future-exact-heading" className="mt-1 text-xl font-semibold tracking-tight text-[color:var(--forest-text)] sm:text-2xl">
            If every entered date happens
          </h2>
          <p className="mt-1 text-sm text-[color:var(--forest-muted)]">
            From {formatDateLabel(asOf)} through {formatDateLabel(windowEnd)}. This uses only the income and payments you
            entered, on the dates you entered them.
          </p>
        </div>

        <div className="space-y-5 p-4 sm:p-6">
          <p className="max-w-3xl border-l-2 border-accent pl-3 text-base leading-relaxed text-ink sm:text-lg">
            Lowest planned balance {formatMoney(outcome.projectedLowCents)} on{" "}
            {formatDateLabel(outcome.projectedLowDate)}. Ending planned balance{" "}
            {formatMoney(outcome.endingBalanceCents)}.
            {outcome.firstNegativeDate
              ? ` The exact schedule goes negative on ${formatDateLabel(outcome.firstNegativeDate)}.`
              : " The exact schedule does not go negative."}
          </p>

          <dl className="grid gap-3 sm:grid-cols-3">
            <div className="min-w-0 rounded-xl border border-line bg-inset p-3">
              <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">Starting balance</dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums tracking-tight text-ink">
                {formatMoney(outcome.startingBalanceCents)}
              </dd>
              <dd className="text-xs text-muted">As of {formatDateLabel(asOf)}</dd>
            </div>
            <div className="min-w-0 rounded-xl border border-line bg-inset p-3">
              <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">Lowest planned balance</dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums tracking-tight text-ink">
                {formatMoney(outcome.projectedLowCents)}
              </dd>
              <dd className="text-xs text-muted">On {formatDateLabel(outcome.projectedLowDate)}</dd>
            </div>
            <div className="min-w-0 rounded-xl border border-line bg-inset p-3">
              <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">Ending planned balance</dt>
              <dd className="mt-1 text-lg font-semibold tabular-nums tracking-tight text-ink">
                {formatMoney(outcome.endingBalanceCents)}
              </dd>
              <dd className="text-xs text-muted">At the end of the {outcome.horizonDays}-day plan</dd>
            </div>
          </dl>

          <p
            className={`inline-block max-w-full rounded-full border px-3 py-1 text-sm font-medium ${
              outcome.firstNegativeDate
                ? "border-danger bg-danger-soft text-ink"
                : "border-positive bg-positive-soft text-ink"
            }`}
          >
            {outcome.firstNegativeDate
              ? `Exact schedule goes below zero on ${formatDateLabel(outcome.firstNegativeDate)}`
              : "Exact schedule stays at or above zero"}
          </p>

          {isNonDefaultRank && (
            <Notice tone="warning" title="This is not the cautious P10 amount">
              You selected rank {outcome.quantileNum}/{outcome.quantileDen}. About{" "}
              {Math.round((outcome.quantileNum / outcome.quantileDen) * 100)}% of modeled low points are at or below it,
              so spending it would leave those futures at or below your reserve.
            </Notice>
          )}

          {showGuidance && (
            <div className="rounded-xl border border-line bg-accent-soft p-3 sm:p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">
                {cautiousAmountHeading(outcome.quantileNum, outcome.quantileDen)}
              </p>
              <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-ink">
                {outcome.safeSpendCents < 0
                  ? formatCautiousSpend(outcome.safeSpendCents, outcome.reserveCents)
                  : formatMoney(outcome.safeSpendCents)}
              </p>
              <p className="mt-1 text-sm text-muted">
                {outcome.safeSpendCents < 0
                  ? `${cautiousAmountHeading(outcome.quantileNum, outcome.quantileDen)} using the ${rank}: ${formatCautiousSpend(
                      outcome.safeSpendCents,
                      outcome.reserveCents
                    )}.`
                  : `The ${cautiousAmountShortName(outcome.quantileNum, outcome.quantileDen)} uses the ${rank} and is ${formatMoney(
                      outcome.safeSpendCents
                    )}.`}{" "}
                That is separate from the exact-schedule low point.
              </p>
            </div>
          )}

          <TimelineChart
            asOf={asOf}
            startingBalanceCents={outcome.startingBalanceCents}
            events={rows}
            horizonDays={outcome.horizonDays}
          />
        </div>
      </section>

      {outcome.runs < 30 && (
        <Notice tone="warning" title="Too few modeled futures for a reliable tail">
          {outcome.runs} modeled {outcome.runs === 1 ? "future" : "futures"} cannot support a meaningful 10th or 90th
          percentile. Raise Modeled futures under Advanced before treating these ranks as risk estimates.
        </Notice>
      )}

      {showGuidance ? (
        <section
          aria-labelledby="future-modeled-heading"
          className="rounded-2xl border border-line bg-inset p-4 sm:p-6"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">Modeled range</p>
            <span className="rounded-full border border-line bg-surface px-2.5 py-0.5 text-xs font-medium text-muted">
              Secondary estimate
            </span>
          </div>
          <h2 id="future-modeled-heading" className="mt-1 text-lg font-semibold text-ink">
            Possible futures
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            These are ranks from {outcome.runs} modeled futures, seeded so the same assumptions can be repeated. The
            middle rank is a median, not an average. These are simulations, not measured odds from your financial
            history. As of {formatDateLabel(asOf)}.
          </p>

          <div className="mt-4 space-y-3">
            {outcome.overdraftPpm === 0 ? (
              <Notice tone="info" title="None of these modeled futures went negative">
                That is {outcome.runs} modeled {outcome.runs === 1 ? "future" : "futures"} under these assumptions. It
                does not mean there is no risk in real life.
              </Notice>
            ) : (
              <Notice tone="warning" title="Some modeled futures go negative">
                {negativeRuns} of {outcome.runs} modeled futures ({formatProbability(outcome.overdraftPpm)}) went
                negative under the current assumptions. That is a model share, not measured real-world odds.
              </Notice>
            )}
          </div>

          <div className="mt-5">
            <h3 className="text-sm font-semibold text-ink">Lowest balance in each modeled future</h3>
            <div className="mt-2 grid gap-3 sm:grid-cols-3">
              <RangeStat
                label="More difficult low point"
                value={formatMoney(outcome.minimumBalanceP10Cents)}
                detail="Nearest-rank 1/10 of the lowest balance in each modeled future. In the more difficult outcomes, the balance fell to about this level."
              />
              <RangeStat
                label="Middle low point"
                value={formatMoney(outcome.minimumBalanceP50Cents)}
                detail="Nearest-rank median of those low points. This is not an expected value or an average."
              />
              <RangeStat
                label="More favorable low point"
                value={formatMoney(outcome.minimumBalanceP90Cents)}
                detail="Nearest-rank 9/10 of the low points. This is one of the higher low points in the model, not a guarantee."
              />
            </div>
          </div>

          <div className="mt-5">
            <h3 className="text-sm font-semibold text-ink">Ending balance in each modeled future</h3>
            <div className="mt-2 grid gap-3 sm:grid-cols-3">
              <RangeStat
                label="More difficult ending balance"
                value={formatMoney(outcome.endingBalanceP10Cents)}
                detail={`Where the ${outcome.horizonDays}-day window ended in the more difficult futures.`}
              />
              <RangeStat
                label="Middle ending balance"
                value={formatMoney(outcome.endingBalanceP50Cents)}
                detail="Median ending balance. Not an average."
              />
              <RangeStat
                label="More favorable ending balance"
                value={formatMoney(outcome.endingBalanceP90Cents)}
                detail="Where the window ended in the more favorable futures."
              />
            </div>
          </div>
        </section>
      ) : (
        <Notice tone="info" title="Spending and risk estimates aren’t shown yet">
          Check your bill dates and plan window. The schedule above includes only the dated entries that were used.
        </Notice>
      )}

      <Explain term="forecast uncertainty">
        The exact schedule answers “what if every entered date and amount happens?” The modeled futures answer “what
        if income, bills, and surprise expenses move inside the ranges you set?” Missing bills can hide a shortfall; missing
        income can make one look worse. Neither estimate covers events beyond the inputs and ranges you provided.
      </Explain>
    </div>
  );
}
