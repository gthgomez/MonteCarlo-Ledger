"use client";

import React, { useState } from "react";
import { cautiousAmountHeading, cautiousAmountShortName } from "@/lib/assumptions";
import { formatDateLabel } from "@/lib/dates";
import { createStarterLedger, dollarsToCents } from "@/lib/ledger-edits";
import { formatMoney } from "@/lib/money-format";
import { type Insight, type PlanSlice, type PositionCopy } from "@/lib/present";
import { type Section } from "@/lib/sections";
import { type PersistenceResult } from "@/lib/sync-state";
import type { IncomeItem, LedgerState } from "@/lib/types";
import { Button, Explain, fieldClass, Metric, Notice } from "./ui";

/** Everything Home needs to draw a forecast. Absence of this object means no
 * forecast is shown; it never stands in for a cached or invented one. */
export interface HomeForecast {
  copy: PositionCopy;
  startingBalanceCents: number;
  safeSpendCents: number | null;
  guidanceIssue: string | null;
  plannedLowCents: number;
  plannedLowDate: string;
  slice: PlanSlice;
  insights: Insight[];
  assumptionsChanged: boolean;
  horizonDays: number;
  reserveCents: number;
  quantileNum: number;
  quantileDen: number;
  runs: number;
}

interface HomeViewProps {
  asOf: string;
  usingDemo: boolean;
  needsSchedule: boolean;
  forecast: HomeForecast | null;
  onNavigate: (section: Section) => void;
  onRecordPurchase?: () => void;
  /** Another ledger edit is pending; onboarding and navigation wait for it. */
  saving?: boolean;
  createOwn: (validated: LedgerState) => Promise<PersistenceResult>;
}

/** The forecast body is presentation only. It is omitted entirely when the
 * engine could not produce a valid forecast. */
function ForecastBody({
  forecast,
  onNavigate,
  saving,
}: {
  forecast: HomeForecast;
  onNavigate: (section: Section) => void;
  saving: boolean;
}) {
  const {
    copy,
    startingBalanceCents,
    safeSpendCents,
    guidanceIssue,
    plannedLowCents,
    plannedLowDate,
    slice,
    insights,
    assumptionsChanged,
    horizonDays,
    reserveCents,
    quantileNum,
    quantileDen,
    runs,
  } = forecast;
  const previewDays = Math.min(30, horizonDays);
  const hasGap = safeSpendCents !== null && safeSpendCents < 0;
  const hasReserve = reserveCents > 0;

  return (
    <>
      <p className="max-w-3xl text-base text-ink">{copy.lead}</p>
      {assumptionsChanged && (
        <Notice tone="warning">These results use assumptions you changed under Advanced. They are still estimates.</Notice>
      )}
      {quantileNum * 10 !== quantileDen && (
        <Notice tone="warning" title="This is not the cautious P10 amount">
          You selected rank {quantileNum}/{quantileDen}. It is not the conservative 1/10 amount: about{" "}
          {Math.round((quantileNum / quantileDen) * 100)}% of modeled low points are at or below it. Spending it would
          leave those futures at or below your reserve.
        </Notice>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <Metric
          label="Money available now"
          value={formatMoney(startingBalanceCents)}
          detail="Based on ledger entries dated today or earlier. Check it against your bank balance."
        />
        {safeSpendCents !== null ? (
          <Metric
            label={hasGap
              ? (hasReserve ? "Gap to your safety reserve" : "Modeled cash shortfall")
              : quantileNum === 1 && quantileDen === 10
                ? "Cautious amount to spend"
                : quantileNum * 2 === quantileDen
                  ? "Middle modeled amount"
                  : quantileNum * 10 === quantileDen * 9
                    ? "Optimistic modeled amount"
                    : `Modeled amount at rank ${quantileNum}/${quantileDen}`}
            value={formatMoney(Math.abs(safeSpendCents))}
            detail={hasGap
              ? hasReserve
                ? `Nothing is left for extra spending in this estimate. Falling below your ${formatMoney(reserveCents)} reserve does not necessarily mean going below zero.`
                : "The selected modeled low point goes below zero without extra spending. This is an estimate, not a guarantee."
              : `An estimate of what you could spend over the ${horizonDays}-day plan while keeping ${formatMoney(reserveCents)} set aside in the modeled low point. It is not your current balance.`}
          />
        ) : (
          <Notice tone="info" title="Not enough information to suggest spending">
            {guidanceIssue}
            <div className="mt-2">
              <Button type="button" variant="quiet" disabled={saving} onClick={() => onNavigate("bills")}>Review bills</Button>
            </div>
          </Notice>
        )}
        <Metric
          label="Lowest point if the schedule is exact"
          value={formatMoney(plannedLowCents)}
          detail={`On ${formatDateLabel(plannedLowDate)}, inside the ${horizonDays}-day plan. This is the exact schedule, separate from the ${cautiousAmountShortName(quantileNum, quantileDen)}.`}
        />
      </div>

      <section className="rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-6">
        <h2 className="text-lg font-semibold">The next {previewDays} {previewDays === 1 ? "day" : "days"}, if the schedule is exact</h2>
        <dl className="mt-4 grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-sm text-muted">Scheduled income</dt>
            <dd className="text-xl font-semibold tabular-nums">{formatMoney(slice.scheduledIncomeCents)}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted">Scheduled payments and spending</dt>
            <dd className="text-xl font-semibold tabular-nums">{formatMoney(slice.scheduledOutflowCents)}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted">Planned balance afterward</dt>
            <dd className="text-xl font-semibold tabular-nums">{formatMoney(slice.plannedEndingCents)}</dd>
          </div>
        </dl>
        <p className="mt-3 text-sm text-muted">
          {slice.events.length === 0
            ? "No payments or income are scheduled in this period."
            : "This balance follows the dated income, payments, and spending in your ledger."}
        </p>
        {slice.events.length > 0 && (
          <details className="mt-3">
            <summary className="cursor-pointer rounded-md py-2 font-medium">See what is included</summary>
            <ul className="divide-y divide-line">
              {slice.events.map((event, index) => (
                <li key={index} className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2 text-sm">
                  <span>{formatDateLabel(event.date)} · {event.name}</span>
                  <span className="tabular-nums">{formatMoney(event.amount_cents)}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold">What to notice</h2>
        {insights.length === 0 ? (
          <p className="text-sm text-muted">Nothing unusual is showing from the numbers currently entered.</p>
        ) : (
          <ul className="space-y-3">
            {insights.slice(0, 6).map((insight) => (
              <li key={insight.id}>
                <Notice tone={insight.tone === "attention" ? "warning" : insight.tone === "ok" ? "ok" : "info"} title={insight.title}>
                  {insight.detail}
                  {insight.action && (
                    <div className="mt-2">
                      <Button type="button" variant="quiet" disabled={saving} onClick={() => onNavigate(insight.action!.section)}>
                        {insight.action.label}
                      </Button>
                    </div>
                  )}
                </Notice>
              </li>
            ))}
          </ul>
        )}
      </section>

      {safeSpendCents !== null && <section className="space-y-3 rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-6" aria-label="How these numbers were calculated">
        <h2 className="text-lg font-semibold">What these numbers mean</h2>
        <p className="text-sm text-muted">{copy.caution}</p>
        <p className="text-sm text-ink">
          This {horizonDays}-day estimate keeps {formatMoney(reserveCents)} as your reserve.
        </p>
        <p className="text-sm text-ink">
          Technical name: {copy.technicalName}. It comes from {runs} modeled futures. The middle outcome is a median
          rank, not an average.
        </p>
        <div className="grid gap-2">
          <Explain term={cautiousAmountHeading(quantileNum, quantileDen).toLowerCase()}>
            The lowest balance in the rank you selected, minus any reserve you set. With the default rank, about the
            more difficult tenth of modeled low points. Spending that amount in the model would bring that low point to
            the reserve. It is not cash sitting in a separate pile.
          </Explain>
          <Explain term="exact schedule">
            What the balance would do if every paycheck and bill you entered happens on its date, for the amount you
            entered. No surprises are included in that line.
          </Explain>
          <Explain term="modeled futures">
            The same schedule, with income, bills, and occasional surprise expenses moved inside the ranges under Advanced.
            They show how fragile the plan is. They are not promises.
          </Explain>
        </div>
      </section>}
    </>
  );
}

export function HomeView({
  asOf,
  usingDemo,
  needsSchedule,
  forecast,
  onNavigate,
  onRecordPurchase,
  saving = false,
  createOwn,
}: HomeViewProps) {
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState("");
  const [incomeName, setIncomeName] = useState("");
  const [incomeAmount, setIncomeAmount] = useState("");
  const [frequency, setFrequency] = useState<IncomeItem["frequency"]>("Bi-weekly");
  const [paydayInput, setPayday] = useState<string | null>(null);
  // A queued or failed starter save keeps the payday and opening as-of it sent,
  // so a retry after midnight writes the dates the person already saw.
  const [pinnedPayday, setPinnedPayday] = useState<string | null>(null);
  const payday = paydayInput ?? pinnedPayday ?? asOf;
  const [pinnedOpeningAsOf, setPinnedOpeningAsOf] = useState<string | null>(null);
  const openingAsOf = pinnedOpeningAsOf ?? asOf;
  const [billName, setBillName] = useState("");
  const [billAmount, setBillAmount] = useState("");
  const [dueDay, setDueDay] = useState("1");

  async function submitOwn(event: React.FormEvent) {
    event.preventDefault();
    if (submitting || saving) return;
    // The starter form may replace only the demo. A saved ledger, including one
    // restored from Sync, must never be replaced by this form.
    if (!usingDemo) {
      setError("This starter form is only available for the demo. Your saved ledger was not changed.");
      return;
    }
    const balanceCents = dollarsToCents(Number(balance));
    if (balance.trim() === "" || balanceCents === null) {
      setError("Enter the money you have now, in dollars. Use 0 if you are starting from nothing.");
      return;
    }
    const submittedAsOf = openingAsOf;
    const submittedPayday = payday;
    let income: Parameters<typeof createStarterLedger>[0]["income"] = null;
    if (incomeName.trim() || incomeAmount.trim()) {
      const amountCents = dollarsToCents(Number(incomeAmount));
      if (!incomeName.trim() || amountCents === null || amountCents <= 0) {
        setError("A paycheck needs a name and an amount greater than zero, or leave both blank.");
        return;
      }
      income = { name: incomeName, amountCents, frequency, nextPayday: submittedPayday };
    }
    let bill: Parameters<typeof createStarterLedger>[0]["bill"] = null;
    if (billName.trim() || billAmount.trim()) {
      const amountCents = dollarsToCents(Number(billAmount));
      const day = Number(dueDay);
      if (!billName.trim() || amountCents === null || amountCents <= 0 || !Number.isInteger(day) || day < 1 || day > 31) {
        setError("A bill needs a name, an amount greater than zero, and a due day from 1 to 31.");
        return;
      }
      bill = { name: billName, amountCents, dueDay: day };
    }
    const starter = createStarterLedger({ asOf: submittedAsOf, balanceCents, income, bill });
    if (!starter.ok) {
      setError(starter.error);
      return;
    }
    if (balanceCents !== 0) setPinnedOpeningAsOf(submittedAsOf);
    if (income && paydayInput === null) setPinnedPayday(submittedPayday);
    setSubmitting(true);
    const created = await createOwn(starter.state);
    setSubmitting(false);
    if (!created.ok) {
      setError(created.error);
      return;
    }
    setError(null);
    setPinnedOpeningAsOf((current) => (current === submittedAsOf ? null : current));
    setPinnedPayday((current) => (current === submittedPayday ? null : current));
    setOpen(false);
  }

  return (
    <div className="space-y-6">
      {!usingDemo && (onRecordPurchase || forecast) && (
        <div className="flex flex-wrap gap-3">
          {onRecordPurchase && (
            <Button type="button" disabled={saving} onClick={onRecordPurchase}>
              Record a purchase
            </Button>
          )}
          {forecast && (
            <Button type="button" variant="quiet" disabled={saving} onClick={() => onNavigate("plan")}>
              Check a purchase
            </Button>
          )}
        </div>
      )}
      {usingDemo && (
        <Notice tone="info" title="Demo data — not your finances.">
          This is a sample household so you can see how a plan looks. It is not your bank account. Enter your own
          numbers when you want the plan to be about you.
          <div className="mt-3">
            <Button type="button" variant="primary" disabled={saving} onClick={() => setOpen(true)}>
              Enter my own numbers
            </Button>
          </div>
        </Notice>
      )}
      {usingDemo && open && (
        <form onSubmit={submitOwn} className="space-y-4 rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-6">
          <fieldset disabled={saving || submitting} className="m-0 min-w-0 space-y-4 border-0 p-0">
          <h2 className="text-lg font-semibold">Your numbers</h2>
          <p className="text-sm text-muted">
            A budget is simply a plan for where your money goes. You can leave the paycheck or the bill blank and add
            them later.
          </p>
          <label className="block text-sm font-medium">
            Money you have now ($)
            <input className={`${fieldClass} mt-1`} inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} />
          </label>
          {pinnedOpeningAsOf !== null && pinnedOpeningAsOf !== asOf && (
            <p className="text-sm text-muted">Opening balance date: {formatDateLabel(pinnedOpeningAsOf)}.</p>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block text-sm font-medium">
              Paycheck name
              <input className={`${fieldClass} mt-1`} value={incomeName} onChange={(e) => setIncomeName(e.target.value)} placeholder="Job" />
            </label>
            <label className="block text-sm font-medium">
              Take-home amount ($)
              <input className={`${fieldClass} mt-1`} inputMode="decimal" value={incomeAmount} onChange={(e) => setIncomeAmount(e.target.value)} />
            </label>
            <label className="block text-sm font-medium">
              How often
              <select className={`${fieldClass} mt-1`} value={frequency} onChange={(e) => setFrequency(e.target.value as IncomeItem["frequency"])}>
                <option>Weekly</option>
                <option>Bi-weekly</option>
                <option>Monthly</option>
              </select>
            </label>
            <label className="block text-sm font-medium">
              Next payday
              <input
                className={`${fieldClass} mt-1`}
                type="date"
                value={payday}
                onChange={(e) => {
                  setPayday(e.target.value);
                  setPinnedPayday(null);
                }}
              />
            </label>
            <label className="block text-sm font-medium">
              A regular bill
              <input className={`${fieldClass} mt-1`} value={billName} onChange={(e) => setBillName(e.target.value)} placeholder="Rent" />
            </label>
            <label className="block text-sm font-medium">
              Bill amount ($)
              <input className={`${fieldClass} mt-1`} inputMode="decimal" value={billAmount} onChange={(e) => setBillAmount(e.target.value)} />
            </label>
            <label className="block text-sm font-medium">
              Due day
              <input className={`${fieldClass} mt-1`} inputMode="numeric" value={dueDay} onChange={(e) => setDueDay(e.target.value)} />
            </label>
          </div>
          {error && (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          )}
          <Button type="submit">Save and show my plan</Button>
          </fieldset>
        </form>
      )}
      {needsSchedule && !usingDemo && (
        <Notice tone="warning" title="Add your paycheck and bills">
          Your recorded money and any debt entries are already saved. Add a paycheck or a bill to include upcoming
          money and payments in the plan. Nothing already recorded is replaced.
          <div className="mt-3 flex flex-wrap gap-3">
            <Button type="button" variant="primary" disabled={saving} onClick={() => onNavigate("money")}>
              Add a paycheck
            </Button>
            <Button type="button" variant="quiet" disabled={saving} onClick={() => onNavigate("bills")}>
              Add a bill
            </Button>
          </div>
        </Notice>
      )}

      {forecast && <ForecastBody forecast={forecast} onNavigate={onNavigate} saving={saving} />}
    </div>
  );
}
