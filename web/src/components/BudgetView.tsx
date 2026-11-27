"use client";

import React, { useState } from "react";
import { type BudgetTargets } from "@/lib/budget-targets";
import { parseDollarsToCents } from "@/lib/ledger-edits";
import { formatDollarsInput, formatMoney } from "@/lib/money-format";
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
  onOpenMoney,
  onOpenBills,
}: {
  current: SpendingSummary;
  previous: SpendingSummary;
  payments: PaymentItem[];
  targets: BudgetTargets;
  warning: string | null;
  onSave: (targets: BudgetTargets) => string | null;
  onOpenMoney: () => void;
  onOpenBills: () => void;
}) {
  const [limit, setLimit] = useState(targets.monthlyLimitCents === null ? "" : formatDollarsInput(targets.monthlyLimitCents));
  const [category, setCategory] = useState("");
  const [categoryAmount, setCategoryAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState("");
  const note = spendingDeltaNote(current.totalCents, previous.totalCents);
  const overages = categoryOverages(current.byCategory, targets.categories);
  const monthlyBills = payments.filter((payment) => payment.recurrence === "Monthly");
  const monthlyBillCents = monthlyBills.reduce((sum, payment) => sum + payment.amount_cents, 0);

  function save(next: BudgetTargets) {
    const problem = onSave(next);
    setError(problem);
    setSavedMessage(problem ? "" : "Spending targets saved.");
    return problem === null;
  }

  function submitLimit(event: React.FormEvent) {
    event.preventDefault();
    if (limit.trim() === "") {
      save({ ...targets, monthlyLimitCents: null });
      return;
    }
    const cents = parseDollarsToCents(limit);
    if (cents === null || cents < 0) {
      setError("Enter a spending target of zero or more, or leave it blank to clear it.");
      return;
    }
    save({ ...targets, monthlyLimitCents: cents });
  }

  function submitCategory(event: React.FormEvent) {
    event.preventDefault();
    const name = category.trim();
    const cents = parseDollarsToCents(categoryAmount);
    if (!name || cents === null || cents < 0) {
      setError("A category target needs a name and an amount of zero or more.");
      return;
    }
    if (save({ ...targets, categories: { ...targets.categories, [name]: cents } })) {
      setCategory("");
      setCategoryAmount("");
    }
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
        <dl className="budget-measures">
          <div><dt>Recorded this month</dt><dd>{formatMoney(current.totalCents)}</dd></div>
          <div><dt>Monthly target</dt><dd>{targets.monthlyLimitCents === null ? "Not set" : formatMoney(targets.monthlyLimitCents)}</dd></div>
          <div><dt>{limitGap !== null && limitGap < 0 ? "Over target" : "Left under target"}</dt><dd className={limitGap !== null && limitGap < 0 ? "text-danger" : undefined}>{limitGap === null ? "—" : formatMoney(Math.abs(limitGap))}</dd></div>
        </dl>
        <p className="mt-2 text-sm text-muted">Money left under a target is a budget measure. Safe-to-Spend also accounts for future cash and obligations.</p>
        {note && <p className="mt-3 text-sm text-ink">{note}</p>}
        {current.byCategory.length === 0 ? (
          <div className="mt-4">
            <Notice tone="info" title="No spending is recorded this month">
              Add an expense under Money. Until you do, this page cannot show where money went.
              <div className="mt-2"><Button type="button" variant="quiet" onClick={onOpenMoney}>Open Money</Button></div>
            </Notice>
          </div>
        ) : (
          <ul className="mt-4 divide-y divide-line">
            {current.byCategory.map((row) => (
              <li key={row.category} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                <span className="min-w-0 break-words">{row.category}</span>
                <span className="min-w-0 break-words text-right tabular-nums font-semibold">
                  {formatMoney(row.cents)}
                  {Object.hasOwn(targets.categories, row.category) && (
                    <span className="block text-xs font-normal text-muted">of {formatMoney(targets.categories[row.category])} target</span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Your spending targets" lede="Targets stay in this browser unless you include financial settings in an encrypted vault backup. They do not change the forecast.">
        {warning && <Notice tone="warning">{warning}</Notice>}
        {overages.map((row) => (
          <p key={row.category} className="mb-2 text-sm text-ink">
            Recorded {row.category} spending is {formatMoney(row.actualCents)}, which is {formatMoney(row.overCents)} over
            the {formatMoney(row.targetCents)} target you set.
          </p>
        ))}
        <form onSubmit={submitLimit} className="mt-3 flex flex-wrap items-end gap-3">
          <label className="min-w-0 text-sm font-medium">
            Monthly spending target ($)
            <input className={`${fieldClass} mt-1`} inputMode="decimal" value={limit} onChange={(e) => setLimit(e.target.value)} />
          </label>
          <Button type="submit">Save target</Button>
        </form>
        <form onSubmit={submitCategory} className="mt-4 flex flex-wrap items-end gap-3">
          <label className="min-w-0 text-sm font-medium">
            Category
            <input className={`${fieldClass} mt-1`} value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Groceries" />
          </label>
          <label className="min-w-0 text-sm font-medium">
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
        <p className="mt-2 text-sm text-positive empty:sr-only" role="status">{error ? "" : savedMessage}</p>
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
                   <span className="min-w-0 break-words">{payment.name}</span>
                   <span className="min-w-0 break-words text-right tabular-nums">{formatMoney(payment.amount_cents)}</span>
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
          <Button className="mt-3" type="button" variant="quiet" onClick={onOpenBills}>Open Bills</Button>
        </div>
      </Panel>
    </div>
  );
}
