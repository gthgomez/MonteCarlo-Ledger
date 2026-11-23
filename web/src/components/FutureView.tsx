"use client";

import React from "react";
import { quantilePlainName } from "@/lib/assumptions";
import { formatDateLabel } from "@/lib/dates";
import { formatMoney, formatProbability } from "@/lib/money-format";
import { formatCautiousSpend } from "@/lib/present";
import { type ModelOutcome } from "@/lib/scenarios";
import type { TimelineRow } from "@/contract/engine";
import { Explain, Metric, Notice } from "./ui";
import { TimelineChart } from "./TimelineChart";

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
  return (
    <div className="space-y-6">
      {assumptionsChanged && (
        <Notice tone="warning">These results use settings you changed under Advanced.</Notice>
      )}
      {showGuidance ? <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-lg font-semibold">Possible futures</h2>
        <p className="max-w-3xl text-sm text-muted">
          These are ranks from {outcome.runs} modeled futures, seeded so the same assumptions can be repeated. The
          middle rank is a median, not an average. These are simulations, not measured odds from your financial
          history. As of {formatDateLabel(asOf)}.
        </p>
        {outcome.overdraftPpm === 0 ? (
          <Notice tone="info" title="None of these modeled futures went negative">
            That is {outcome.runs} simulations under these assumptions. It does not mean there is no risk in real life.
          </Notice>
        ) : (
          <Notice tone="warning" title="Some modeled futures go negative">
            {formatProbability(outcome.overdraftPpm)} went negative in the model under the current assumptions.
          </Notice>
        )}
      </section>

      <div className="grid gap-4 md:grid-cols-3">
        <Metric
          label="More difficult low point"
          value={formatMoney(outcome.minimumBalanceP10Cents)}
          detail="Nearest-rank 1/10 of the lowest balance in each modeled future. In the more difficult outcomes, the balance fell to about this level."
        />
        <Metric
          label="Middle low point"
          value={formatMoney(outcome.minimumBalanceP50Cents)}
          detail="Nearest-rank median of those low points. This is not an expected value or an average."
        />
        <Metric
          label="More favorable low point"
          value={formatMoney(outcome.minimumBalanceP90Cents)}
          detail="Nearest-rank 9/10 of the low points. This is one of the higher low points in the model, not a guarantee."
        />
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Metric
          label="More difficult ending balance"
          value={formatMoney(outcome.endingBalanceP10Cents)}
          detail={`Where the ${outcome.horizonDays}-day window ended in the more difficult futures.`}
        />
        <Metric
          label="Middle ending balance"
          value={formatMoney(outcome.endingBalanceP50Cents)}
          detail="Median ending balance. Not an average."
        />
        <Metric
          label="More favorable ending balance"
          value={formatMoney(outcome.endingBalanceP90Cents)}
          detail="Where the window ended in the more favorable futures."
        />
      </div>
      </div> : (
        <Notice tone="info" title="Spending and risk estimates aren’t shown yet">
          Check your bill dates and plan window. The schedule below includes only the dated entries that were used.
        </Notice>
      )}

      <section className="rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-6">
        <h2 className="text-lg font-semibold">If the schedule happens exactly as entered</h2>
        <p className="mt-1 text-sm text-muted">
          Lowest planned balance {formatMoney(outcome.projectedLowCents)} on {formatDateLabel(outcome.projectedLowDate)}.
          Ending planned balance {formatMoney(outcome.endingBalanceCents)}.
          {outcome.firstNegativeDate
            ? ` The exact schedule goes negative on ${formatDateLabel(outcome.firstNegativeDate)}.`
            : " The exact schedule does not go negative."}
        </p>
        {showGuidance && <p className="mt-2 text-sm text-muted">
          {outcome.safeSpendCents < 0
            ? `Cautious spending using the ${rank}: ${formatCautiousSpend(outcome.safeSpendCents, outcome.reserveCents)}.`
            : `The cautious amount uses the ${rank} and is ${formatMoney(outcome.safeSpendCents)}.`} That is separate from the
          exact-schedule low point.
        </p>}
        <div className="mt-4">
          <TimelineChart
            asOf={asOf}
            startingBalanceCents={outcome.startingBalanceCents}
            events={rows}
            horizonDays={outcome.horizonDays}
          />
        </div>
      </section>

      <Explain term="forecast uncertainty">
        The exact schedule answers “what if every entered date and amount happens?” The modeled futures answer “what
        if income and surprise expenses move inside the ranges you set?” Missing bills can hide a shortfall; missing
        income can make one look worse. Neither estimate covers events beyond the inputs and ranges you provided.
      </Explain>
    </div>
  );
}
