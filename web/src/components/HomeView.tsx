"use client";

import React, { useState } from "react";
import { formatDateLabel } from "@/lib/dates";
import { createStarterLedger, dollarsToCents } from "@/lib/ledger-edits";
import { formatMoney } from "@/lib/money-format";
import { type Insight, type PlanSlice, type PositionCopy } from "@/lib/present";
import { type Section } from "@/lib/sections";
import { type IncomeItem } from "@/lib/types";
import { Button, Explain, fieldClass, Metric, Notice } from "./ui";

interface HomeViewProps {
  asOf: string;
  usingDemo: boolean;
  needsSetup: boolean;
  copy: PositionCopy;
  recordedBalanceCents: number;
  safeSpendCents: number;
  plannedLowCents: number;
  plannedLowDate: string;
  slice: PlanSlice;
  insights: Insight[];
  assumptionsChanged: boolean;
  horizonDays: number;
  runs: number;
  onNavigate: (section: Section) => void;
  createOwn: (input: Parameters<typeof createStarterLedger>[0]) => { ok: true } | { ok: false; error: string };
}

export function HomeView({
  asOf,
  usingDemo,
  needsSetup,
  copy,
  recordedBalanceCents,
  safeSpendCents,
  plannedLowCents,
  plannedLowDate,
  slice,
  insights,
  assumptionsChanged,
  horizonDays,
  runs,
  onNavigate,
  createOwn,
}: HomeViewProps) {
  const [open, setOpen] = useState(needsSetup && !usingDemo);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState("");
  const [incomeName, setIncomeName] = useState("");
  const [incomeAmount, setIncomeAmount] = useState("");
  const [frequency, setFrequency] = useState<IncomeItem["frequency"]>("Bi-weekly");
  const [payday, setPayday] = useState(asOf);
  const [billName, setBillName] = useState("");
  const [billAmount, setBillAmount] = useState("");
  const [dueDay, setDueDay] = useState("1");

  function submitOwn(event: React.FormEvent) {
    event.preventDefault();
    const balanceCents = dollarsToCents(Number(balance));
    if (balance.trim() === "" || balanceCents === null) {
      setError("Enter the money you have now, in dollars. Use 0 if you are starting from nothing.");
      return;
    }
    let income: Parameters<typeof createStarterLedger>[0]["income"] = null;
    if (incomeName.trim() || incomeAmount.trim()) {
      const amountCents = dollarsToCents(Number(incomeAmount));
      if (!incomeName.trim() || amountCents === null || amountCents <= 0) {
        setError("A paycheck needs a name and an amount greater than zero, or leave both blank.");
        return;
      }
      income = { name: incomeName, amountCents, frequency, nextPayday: payday };
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
    const created = createOwn({ asOf, balanceCents, income, bill });
    if (!created.ok) {
      setError(created.error);
      return;
    }
    setError(null);
    setOpen(false);
  }

  const spendDetail =
    safeSpendCents >= 0
      ? "An estimate of what you could spend while keeping the chosen low point at your reserve. Not a guarantee."
      : "The chosen low point is below zero, so this is not an amount you can spend.";

  return (
    <div className="space-y-6">
      {usingDemo && (
        <Notice tone="info" title="Demo data — not your finances.">
          This is a sample household so you can see how a plan looks. It is not your bank account. Enter your own
          numbers when you want the plan to be about you.
          <div className="mt-3">
            <Button type="button" variant="primary" onClick={() => setOpen(true)}>
              Enter my own numbers
            </Button>
          </div>
        </Notice>
      )}
      {needsSetup && !usingDemo && (
        <Notice tone="warning" title="Start with what you know">
          Start by adding the money you have, your monthly income, and the bills you pay regularly. The plan stays
          quiet until those are entered. Nothing here is guessed.
        </Notice>
      )}
      {(open || (needsSetup && !usingDemo)) && (
        <form onSubmit={submitOwn} className="space-y-4 rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-6">
          <h2 className="text-lg font-semibold">Your numbers</h2>
          <p className="text-sm text-muted">
            A budget is simply a plan for where your money goes. You can leave the paycheck or the bill blank and add
            them later.
          </p>
          <label className="block text-sm font-medium">
            Money you have now ($)
            <input className={`${fieldClass} mt-1`} inputMode="decimal" value={balance} onChange={(e) => setBalance(e.target.value)} />
          </label>
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
              <input className={`${fieldClass} mt-1`} type="date" value={payday} onChange={(e) => setPayday(e.target.value)} />
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
        </form>
      )}

      <p className="max-w-3xl text-base text-ink">{copy.lead}</p>
      {assumptionsChanged && (
        <Notice tone="warning">These results use assumptions you changed under Advanced. They are still estimates.</Notice>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <Metric
          label="Money recorded"
          value={formatMoney(recordedBalanceCents)}
          detail="The sum of transactions in this ledger. Not a forecast."
        />
        <Metric label="Cautious amount to spend" value={formatMoney(safeSpendCents)} detail={spendDetail} />
        <Metric
          label="Lowest point if the schedule is exact"
          value={formatMoney(plannedLowCents)}
          detail={`On ${formatDateLabel(plannedLowDate)}, inside the ${horizonDays}-day plan. This is the exact schedule, separate from the cautious amount.`}
        />
      </div>

      <section className="rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-6">
        <h2 className="text-lg font-semibold">The next 30 days, if the schedule is exact</h2>
        <dl className="mt-4 grid gap-4 sm:grid-cols-3">
          <div>
            <dt className="text-sm text-muted">Scheduled income</dt>
            <dd className="text-xl font-semibold tabular-nums">{formatMoney(slice.scheduledIncomeCents)}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted">Known bills</dt>
            <dd className="text-xl font-semibold tabular-nums">{formatMoney(slice.scheduledOutflowCents)}</dd>
          </div>
          <div>
            <dt className="text-sm text-muted">Planned balance afterward</dt>
            <dd className="text-xl font-semibold tabular-nums">{formatMoney(slice.plannedEndingCents)}</dd>
          </div>
        </dl>
        <p className="mt-3 text-sm text-muted">
          Planned balance is not money you are guaranteed to have. It only follows paychecks and bills already entered.
          {slice.events.length === 0 ? " Nothing is scheduled in these 30 days." : ""}
        </p>
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
                      <Button type="button" variant="quiet" onClick={() => onNavigate(insight.action!.section)}>
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

      <section className="space-y-3 rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-6" aria-label="How these numbers were calculated">
        <h2 className="text-lg font-semibold">What these numbers mean</h2>
        <p className="text-sm text-muted">{copy.caution}</p>
        <p className="text-sm text-ink">
          Technical name: {copy.technicalName}. It comes from {runs} modeled futures. The middle outcome is a median
          rank, not an average.
        </p>
        <div className="grid gap-2">
          <Explain term="cautious amount to spend">
            The lowest balance in the rank you selected, minus any reserve you set. With the default rank, about the
            more difficult tenth of modeled low points. Spending that amount in the model would bring that low point to
            the reserve. It is not cash sitting in a separate pile.
          </Explain>
          <Explain term="exact schedule">
            What the balance would do if every paycheck and bill you entered happens on its date, for the amount you
            entered. No surprises are included in that line.
          </Explain>
          <Explain term="modeled futures">
            The same schedule, with income and occasional surprise expenses moved inside the ranges under Advanced.
            They show how fragile the plan is. They are not promises.
          </Explain>
        </div>
      </section>
    </div>
  );
}
