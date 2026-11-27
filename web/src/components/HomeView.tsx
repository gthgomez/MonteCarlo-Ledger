"use client";

import React, { useEffect, useRef, useState } from "react";
import { ArrowDownLeft, ArrowRight, ArrowUpRight, CalendarDays, ShieldCheck } from "lucide-react";
import { cautiousAmountHeading } from "@/lib/assumptions";
import { formatDateLabel } from "@/lib/dates";
import { createStarterLedger, parseDollarsToCents } from "@/lib/ledger-edits";
import { formatMoney } from "@/lib/money-format";
import { type Insight, type PlanSlice, type PositionCopy } from "@/lib/present";
import { type Section } from "@/lib/sections";
import { type PersistenceResult } from "@/lib/sync-state";
import type { IncomeItem, LedgerState, TransactionItem } from "@/lib/types";
import { Button, Explain, fieldClass, Notice } from "./ui";

/** Everything Home needs to draw a forecast. Absence of this object means no
 * forecast is shown; it never stands in for a cached or invented one. */
export interface HomeForecast {
  copy: PositionCopy;
  nextPayday: { date: string; name: string; amount_cents: number } | null;
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
  recentActivity: TransactionItem[];
  openStarter?: boolean;
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
    nextPayday,
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
  const spendLabel = hasGap
    ? (hasReserve ? "Gap to your safety reserve" : "Modeled cash shortfall")
    : cautiousAmountHeading(quantileNum, quantileDen);
  const spendDetail = hasGap
    ? hasReserve
      ? `There’s no room for extra spending in this estimate. Going below your ${formatMoney(reserveCents)} reserve does not necessarily mean going below zero.`
      : "The selected modeled low point goes below zero without extra spending. This is an estimate, not a guarantee."
    : `Estimated room over your ${horizonDays}-day plan after keeping ${formatMoney(reserveCents)} in reserve. This is separate from today’s cash.`;

  return (
    <>
      <div className="home-position">
        {safeSpendCents !== null ? (
          <section className={`home-hero ${hasGap ? "home-hero-risk" : ""}`}>
            <span className="home-hero-kicker"><ShieldCheck size={17} aria-hidden="true" /> {hasGap ? "Needs attention" : quantileNum * 10 === quantileDen ? "Safe-to-Spend estimate" : "Spending outlook"} <span aria-hidden="true">·</span> {horizonDays} days</span>
            <h2>{spendLabel}</h2>
            <p className="home-hero-value">{formatMoney(Math.abs(safeSpendCents))}</p>
            <p className="home-hero-detail">{spendDetail}</p>
            <button type="button" className="home-hero-link" disabled={saving} onClick={() => onNavigate("plan")}>
              Explore a what-if <ArrowRight size={16} aria-hidden="true" />
            </button>
          </section>
        ) : (
          <section className="home-hero home-hero-unavailable">
            <span className="home-hero-kicker"><ShieldCheck size={17} aria-hidden="true" /> Spending outlook</span>
            <h2>Not enough information to suggest spending</h2>
            <p className="home-hero-detail">{guidanceIssue}</p>
            <Button type="button" variant="quiet" disabled={saving} onClick={() => onNavigate("bills")}>Review bills</Button>
          </section>
        )}
        <div className="home-position-details">
          <section>
            <h2>Money available now</h2>
            <p className="home-position-value">{formatMoney(startingBalanceCents)}</p>
            <p>Recorded through today. Check this against your actual cash.</p>
          </section>
          <section>
            <h2>Lowest point if the schedule is exact</h2>
            <p className="home-position-value">{formatMoney(plannedLowCents)}</p>
            <p>On {formatDateLabel(plannedLowDate)}, inside the {horizonDays}-day plan.</p>
          </section>
          <section>
            <h2>Next expected payday</h2>
            {nextPayday ? (
              <>
                <p className="home-position-value">{formatDateLabel(nextPayday.date)}</p>
                <p>{nextPayday.name} · {formatMoney(nextPayday.amount_cents)}</p>
              </>
            ) : <p>No paycheck is scheduled inside this plan window.</p>}
          </section>
        </div>
      </div>
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

      <section className="workspace-panel">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 text-lg font-semibold"><CalendarDays size={19} aria-hidden="true" /> The next {previewDays} {previewDays === 1 ? "day" : "days"}, if the schedule is exact</h2>
          <Button type="button" variant="quiet" disabled={saving} onClick={() => onNavigate("future")}>
            Open forecast <ArrowRight size={16} aria-hidden="true" />
          </Button>
        </div>
        <dl className="home-flow-summary">
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
        <p className="max-w-3xl text-sm text-ink">{copy.lead}</p>
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
      {safeSpendCents === null && <p className="max-w-3xl text-sm text-muted">{copy.lead}</p>}
    </>
  );
}

export function HomeView({
  asOf,
  usingDemo,
  needsSchedule,
  recentActivity,
  openStarter = false,
  forecast,
  onNavigate,
  onRecordPurchase,
  saving = false,
  createOwn,
}: HomeViewProps) {
  const [open, setOpen] = useState(openStarter);
  const startButton = useRef<HTMLButtonElement>(null);
  const startingBalance = useRef<HTMLInputElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [balanceInvalid, setBalanceInvalid] = useState(false);
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

  useEffect(() => {
    if (open) startingBalance.current?.focus();
  }, [open]);

  async function submitOwn(event: React.FormEvent) {
    event.preventDefault();
    if (submitting || saving) return;
    // The starter form may replace only the demo. A saved ledger, including one
    // restored from Sync, must never be replaced by this form.
    if (!usingDemo) {
      setError("This starter form is only available for the demo. Your saved ledger was not changed.");
      return;
    }
    const balanceCents = parseDollarsToCents(balance, { allowNegative: true });
    if (balance.trim() === "" || balanceCents === null) {
      setError("Enter the money you have now in dollars and cents. Use 0 if you are starting from nothing.");
      setBalanceInvalid(true);
      startingBalance.current?.focus();
      return;
    }
    setBalanceInvalid(false);
    const submittedAsOf = openingAsOf;
    const submittedPayday = payday;
    let income: Parameters<typeof createStarterLedger>[0]["income"] = null;
    if (incomeName.trim() || incomeAmount.trim()) {
      const amountCents = parseDollarsToCents(incomeAmount);
      if (!incomeName.trim() || amountCents === null || amountCents <= 0) {
        setError("A paycheck needs a name and an amount greater than zero, or leave both blank.");
        return;
      }
      income = { name: incomeName, amountCents, frequency, nextPayday: submittedPayday };
    }
    let bill: Parameters<typeof createStarterLedger>[0]["bill"] = null;
    if (billName.trim() || billAmount.trim()) {
      const amountCents = parseDollarsToCents(billAmount);
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
    if (balanceCents !== 0 || bill) setPinnedOpeningAsOf(submittedAsOf);
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
    requestAnimationFrame(() => {
      window.scrollTo(0, 0);
      document.getElementById("content")?.focus({ preventScroll: true });
    });
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
        <section className="home-sample">
          <div>
            <h2 className="font-semibold">Demo data — not your finances.</h2>
            <p className="text-sm text-muted">Explore a sample household or start a plan with your own numbers.</p>
          </div>
          <Button type="button" ref={startButton} disabled={saving} onClick={() => setOpen(true)}>
            Enter my own numbers <ArrowRight size={16} aria-hidden="true" />
          </Button>
        </section>
      )}
      {usingDemo && open && (
        <form onSubmit={submitOwn} className="workspace-panel">
          <fieldset disabled={saving || submitting} className="m-0 min-w-0 space-y-4 border-0 p-0">
          <h2 className="text-lg font-semibold">Your numbers</h2>
          <p className="text-sm text-muted">
            Start with the cash available for bills. A paycheck and bill help build your first forecast; you can add them later.
          </p>
          <h3 className="border-t border-line pt-3 text-sm font-semibold">1. Available money</h3>
          <label className="block text-sm font-medium">
            Money you have now ($)
            <input id="home-opening-balance" ref={startingBalance} className={`${fieldClass} mt-1`} inputMode="decimal" value={balance}
              aria-invalid={balanceInvalid || undefined} aria-describedby={balanceInvalid ? "home-opening-error" : undefined}
              onChange={(e) => {
                setBalance(e.target.value);
                if (balanceInvalid) {
                  setBalanceInvalid(false);
                  setError(null);
                }
              }} />
          </label>
          {balanceInvalid && <p id="home-opening-error" className="text-sm text-danger" role="alert">{error}</p>}
          {pinnedOpeningAsOf !== null && pinnedOpeningAsOf !== asOf && (
            <p className="text-sm text-muted">Opening balance date: {formatDateLabel(pinnedOpeningAsOf)}.</p>
          )}
          <h3 className="border-t border-line pt-3 text-sm font-semibold">2. Upcoming income <span className="font-normal text-muted">· Optional</span></h3>
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
          </div>
          <h3 className="border-t border-line pt-3 text-sm font-semibold">3. Regular bills <span className="font-normal text-muted">· Optional</span></h3>
          <div className="grid gap-3 sm:grid-cols-2">
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
          {error && !balanceInvalid && (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          )}
          <p className="border-t border-line pt-3 text-sm text-muted">After setup, use Plan to add debt minimums and include them in your forecast.</p>
          <div className="flex flex-wrap gap-2">
            <Button type="submit">Save and show my plan</Button>
            <Button type="button" variant="quiet" onClick={() => {
              setOpen(false);
              startButton.current?.focus();
            }}>Back to sample overview</Button>
          </div>
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
      <section className="workspace-panel">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-lg font-semibold">Recent activity</h2>
          <Button type="button" variant="quiet" disabled={saving} onClick={() => onNavigate("money")}>
            Open Money <ArrowRight size={16} aria-hidden="true" />
          </Button>
        </div>
        {recentActivity.length === 0 ? (
          <p className="mt-3 text-sm text-muted">There are no posted entries to show yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-line">
            {recentActivity.map((entry, index) => (
              <li key={entry.id ?? index} className="home-activity-row">
                {entry.amount_cents < 0 ? <ArrowUpRight size={18} aria-hidden="true" /> : <ArrowDownLeft size={18} aria-hidden="true" />}
                <div className="min-w-0">
                  <p className="break-words text-sm font-semibold">{entry.description || entry.category || entry.type}</p>
                  <p className="text-xs text-muted">{formatDateLabel(entry.date)} · {entry.type}</p>
                </div>
                <p className="min-w-0 break-words text-right text-sm font-semibold tabular-nums">{formatMoney(entry.amount_cents)}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
