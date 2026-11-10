"use client";

import React, { useState } from "react";
import { type Assumptions } from "@/lib/assumptions";
import { formatDateLabel, relativeDay } from "@/lib/dates";
import { addBill, dollarsToCents, removePayment, type EditResult } from "@/lib/ledger-edits";
import { formatMoney } from "@/lib/money-format";
import { type PlanSlice } from "@/lib/present";
import { type LedgerState, type PaymentItem } from "@/lib/types";
import { Button, fieldClass, Notice, Panel } from "./ui";

export function BillsView({
  state,
  asOf,
  slice,
  horizonDays,
  assumptions,
  overdue,
  onEdit,
}: {
  state: LedgerState;
  asOf: string;
  slice: PlanSlice;
  horizonDays: number;
  assumptions: Assumptions;
  overdue: { count: number; total_cents: number; earliest_date: string | null };
  onEdit: (result: EditResult) => void;
}) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("100");
  const [recurrence, setRecurrence] = useState<PaymentItem["recurrence"]>("Monthly");
  const [dueDay, setDueDay] = useState("15");
  const [dueDate, setDueDate] = useState(asOf);
  const [auto, setAuto] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const billsVary = assumptions.expenseVariationMin !== 0 || assumptions.expenseVariationMax !== 0;
  const upcoming = slice.events.filter((event) => event.amount_cents < 0);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const cents = dollarsToCents(Number(amount));
    if (cents === null) {
      setError("Enter a bill amount greater than zero.");
      return;
    }
    const result = addBill(state, {
      name,
      amountCents: cents,
      recurrence,
      dueDay: Number(dueDay),
      dueDate,
      autoWithdraw: auto,
    });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setName("");
    onEdit(result);
  }

  return (
    <div className="space-y-6">
      {overdue.count > 0 && (
        <Notice tone="warning" title={`${overdue.count} past-due unpaid ${overdue.count === 1 ? "bill" : "bills"}`}>
          They total {formatMoney(overdue.total_cents)}
          {overdue.earliest_date ? `, earliest ${formatDateLabel(overdue.earliest_date)}` : ""}. The forward plan does
          not include them. This screen cannot mark them paid.
        </Notice>
      )}
      <Panel
        title="Payments coming up"
        lede={`These are bills already on the schedule for the next ${horizonDays} days. An amount is the figure you entered. Nothing here has been marked paid.`}
      >
        {billsVary ? (
          <p className="mb-3 text-sm text-muted">
            Advanced assumptions allow bill amounts to vary, so modeled futures can differ from these figures. The
            exact schedule still uses the amounts below.
          </p>
        ) : (
          <p className="mb-3 text-sm text-muted">Bill amounts are treated as exact in the current assumptions.</p>
        )}
        {upcoming.length === 0 ? (
          <p className="text-sm text-muted">No bills are scheduled in this window.</p>
        ) : (
          <ul className="divide-y divide-line">
            {upcoming.map((event, index) => (
              <li key={`${event.date}-${event.name}-${index}`} className="grid gap-1 py-3 text-sm sm:grid-cols-[1fr_auto]">
                <div>
                  <p className="font-medium">{event.name}</p>
                  <p className="text-muted">
                    {formatDateLabel(event.date)} · {relativeDay(asOf, event.date)} · amount you entered
                  </p>
                </div>
                <div className="text-left sm:text-right">
                  <p className="tabular-nums font-semibold">{formatMoney(-event.amount_cents)}</p>
                  <p className="text-muted">
                    Planned balance after {formatMoney(event.balance_after_cents)}
                    {event.balance_after_cents < 0 ? " · below zero on the exact schedule" : ""}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Recurring bills" lede="Add a payment you make regularly. Deleting it removes it from the plan. It does not cancel a payment at a bank.">
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm font-medium sm:col-span-2">
            Bill name
            <input
              className={`${fieldClass} mt-1`}
              placeholder="e.g. Electric Bill, Rent, Netflix"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="text-sm font-medium">
            Amount ($)
            <input className={`${fieldClass} mt-1`} type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label className="text-sm font-medium">
            How often
            <select className={`${fieldClass} mt-1`} value={recurrence} onChange={(e) => setRecurrence(e.target.value as PaymentItem["recurrence"])}>
              <option>Monthly</option>
              <option>Weekly</option>
              <option>Bi-weekly</option>
              <option>One-time</option>
            </select>
          </label>
          {recurrence === "Monthly" ? (
            <label className="text-sm font-medium">
              Due day (1-31)
              <input className={`${fieldClass} mt-1`} type="number" min="1" max="31" value={dueDay} onChange={(e) => setDueDay(e.target.value)} />
            </label>
          ) : (
            <label className="text-sm font-medium">
              Next date
              <input className={`${fieldClass} mt-1`} type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </label>
          )}
          <label className="flex min-h-11 items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} />
            This leaves the account without a separate reminder
          </label>
          {error && (
            <p className="text-sm text-danger sm:col-span-2" role="alert">
              {error}
            </p>
          )}
          <div className="sm:col-span-2">
            <Button type="submit">Add Recurring Bill</Button>
          </div>
        </form>
        <ul className="mt-4 divide-y divide-line">
          {state.payments.map((payment) => (
            <li key={String(payment.id)} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
              <div>
                <p className="font-medium">{payment.name}</p>
                <p className="text-muted">
                  {payment.recurrence}
                  {payment.recurrence === "Monthly" && payment.due_day ? ` · due day ${payment.due_day}` : ""}
                  {payment.due_date ? ` · ${formatDateLabel(payment.due_date)}` : ""}
                  {payment.is_auto_withdraw ? " · you marked this as leaving on its own" : " · amount you entered"}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="tabular-nums font-semibold">{formatMoney(payment.amount_cents)}</span>
                <Button type="button" variant="quiet" onClick={() => onEdit(removePayment(state, payment.id ?? ""))}>
                  Remove {payment.name}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
