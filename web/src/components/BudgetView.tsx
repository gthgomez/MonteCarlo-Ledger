"use client";

import React, { useState } from "react";
import { type BudgetTargets } from "@/lib/budget-targets";
import { dollarsToCents } from "@/lib/ledger-edits";
import { formatMoney } from "@/lib/money-format";
import { categoryOverages, type SpendingSummary, spendingDeltaNote } from "@/lib/present";
import { type PaymentItem } from "@/lib/types";
import { Button, Explain, fieldClass, Notice, Panel } from "./ui";

export function BudgetView({
  current,
  previous,
  payments,
  targets,
  warning,
  onSave,
}: {
  current: SpendingSummary;
  previous: SpendingSummary;
  payments: PaymentItem[];
  targets: BudgetTargets;
  warning: string | null;
  onSave: (targets: BudgetTargets) => string | null;
}) {
  const [limit, setLimit] = useState(targets.monthlyLimitCents === null ? "" : (targets.monthlyLimitCents / 100).toFixed(2));
  const [category, setCategory] = useState("");
  const [categoryAmount, setCategoryAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const note = spendingDeltaNote(current.totalCents, previous.totalCents);
  const overages = categoryOverages(current.byCategory, targets.categories);
  const monthlyBills = payments.filter((payment) => payment.recurrence === "Monthly");
  const monthlyBillCents = monthlyBills.reduce((sum, payment) => sum + payment.amount_cents, 0);

  function save(next: BudgetTargets) {
    const problem = onSave(next);
    setError(problem);
  }

  function submitLimit(event: React.FormEvent) {
    event.preventDefault();
    if (limit.trim() === "") {
      save({ ...targets, monthlyLimitCents: null });
      return;
    }
    const cents = dollarsToCents(Number(limit));
    if (cents === null || cents < 0) {
      setError("Enter a spending target of zero or more, or leave it blank to clear it.");
      return;
    }
    save({ ...targets, monthlyLimitCents: cents });
  }

  function submitCategory(event: React.FormEvent) {
    event.preventDefault();
    const name = category.trim();
    const cents = dollarsToCents(Number(categoryAmount));
    if (!name || cents === null || cents < 0) {
      setError("A category target needs a name and an amount of zero or more.");
      return;
    }
    save({ ...targets, categories: { ...targets.categories, [name]: cents } });
    setCategory("");
    setCategoryAmount("");
  }

  function removeCategory(name: string) {
    const categories = { ...targets.categories };
    delete categories[name];
    save({ ...targets, categories });
  }

  const limitGap =
    targets.monthlyLimitCents === null ? null : targets.monthlyLimitCents - current.totalCents;

  return (
    <div className="space-y-6">
      <Panel
        title="Where recorded money went"
        lede="A budget is simply a plan for where your money goes. Spending here is only what you recorded. Scheduled bills are listed separately so they are not counted twice."
      >
        <p className="text-3xl font-semibold tabular-nums">{formatMoney(current.totalCents)}</p>
        <p className="mt-1 text-sm text-muted">Recorded spending this calendar month.</p>
        {note && <p className="mt-3 text-sm text-ink">{note}</p>}
        {current.byCategory.length === 0 ? (
          <div className="mt-4">
            <Notice tone="info" title="No spending is recorded this month">
              Add an expense under Money. Until you do, this page cannot show where money went.
            </Notice>
          </div>
        ) : (
          <ul className="mt-4 divide-y divide-line">
            {current.byCategory.map((row) => (
              <li key={row.category} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                <span>{row.category}</span>
                <span className="tabular-nums font-semibold">{formatMoney(row.cents)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Your spending targets" lede="Targets are stored only in this browser. They are not part of the forecast and they are not synced.">
        {warning && <Notice tone="warning">{warning}</Notice>}
        {targets.monthlyLimitCents !== null && (
          <p className="mb-3 text-sm text-ink">
            This month you recorded {formatMoney(current.totalCents)} against a target of {formatMoney(targets.monthlyLimitCents)}.
            {limitGap !== null && limitGap >= 0
              ? ` That leaves ${formatMoney(limitGap)} under the target.`
              : limitGap !== null
                ? ` That is ${formatMoney(-limitGap)} over the target you set.`
                : ""}
          </p>
        )}
        {overages.map((row) => (
          <p key={row.category} className="mb-2 text-sm text-ink">
            Recorded {row.category} spending is {formatMoney(row.actualCents)}, which is {formatMoney(row.overCents)} over
            the {formatMoney(row.targetCents)} target you set.
          </p>
        ))}
        <form onSubmit={submitLimit} className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-sm font-medium">
            Monthly spending target ($)
            <input className={`${fieldClass} mt-1`} inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} />
          </label>
          <Button type="submit">Save target</Button>
        </form>
        <form onSubmit={submitCategory} className="mt-4 flex flex-wrap items-end gap-3">
          <label className="text-sm font-medium">
            Category
            <input className={`${fieldClass} mt-1`} value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Groceries" />
          </label>
          <label className="text-sm font-medium">
            Target ($)
            <input className={`${fieldClass} mt-1`} inputMode="decimal" value={categoryAmount} onChange={(e) => setCategoryAmount(e.target.value)} />
          </label>
          <Button type="submit" variant="quiet">
            Save category
          </Button>
        </form>
        {error && (
          <p className="mt-3 text-sm text-danger" role="alert">
            {error}
          </p>
        )}
        <ul className="mt-4 divide-y divide-line">
          {Object.entries(targets.categories).map(([name, cents]) => (
            <li key={name} className="flex items-center justify-between gap-3 py-2 text-sm">
              <span>
                {name} · {formatMoney(cents)}
              </span>
              <Button type="button" variant="quiet" onClick={() => removeCategory(name)}>
                Remove {name}
              </Button>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel title="Bills you already planned" lede="These are the monthly amounts you entered. They are not added to recorded spending.">
        {monthlyBills.length === 0 ? (
          <p className="text-sm text-muted">No monthly bills are entered.</p>
        ) : (
          <>
            <p className="text-sm text-ink">
              Monthly bills you entered add up to {formatMoney(monthlyBillCents)} each cycle. Weekly and one-time bills are
              not converted into a monthly figure here.
            </p>
            <ul className="mt-3 divide-y divide-line">
              {monthlyBills.map((payment) => (
                <li key={String(payment.id)} className="flex justify-between gap-3 py-2 text-sm">
                  <span>{payment.name}</span>
                  <span className="tabular-nums">{formatMoney(payment.amount_cents)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="mt-4">
          <Explain term="recorded spending versus a bill">
            A bill is a payment you expect. Recorded spending is a transaction you entered. If you both schedule rent
            and record the rent payment, they are two different records. This page does not merge them.
          </Explain>
        </div>
      </Panel>
    </div>
  );
}
