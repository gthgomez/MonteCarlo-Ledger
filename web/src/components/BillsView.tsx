"use client";

import React, { useMemo, useState } from "react";
import { type Assumptions } from "@/lib/assumptions";
import { addDaysIso, formatDateLabel, relativeDay } from "@/lib/dates";
import {
  addBill,
  dollarsToCents,
  linkPostedExpenseToPastOneTimeBill,
  markBillOccurrencePaid,
  markPastOneTimeBillPaidWithoutExpense,
  moveBillOccurrence,
  postedExpenseMatchesForPastOneTimeBill,
  removePayment,
  type EditResult,
} from "@/lib/ledger-edits";
import { formatMoney } from "@/lib/money-format";
import type { OverdueAssessment } from "@/lib/overdue";
import { type PlanSlice } from "@/lib/present";
import {
  paymentOccurrenceKey,
  projectBillPayments,
  unresolvedPastOneTimeSlots,
} from "@/lib/scenario-builder";
import type { PersistenceResult } from "@/lib/sync-state";
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
  overdue: OverdueAssessment;
  onEdit: (result: EditResult, draftKey?: string) => Promise<PersistenceResult>;
}) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("100");
  const [recurrence, setRecurrence] = useState<PaymentItem["recurrence"]>("Monthly");
  const [dueDay, setDueDay] = useState("15");
  const [dueDateInput, setDueDate] = useState<string | null>(null);
  const dueDate = dueDateInput ?? asOf;
  const [auto, setAuto] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [moveDates, setMoveDates] = useState<Record<string, string>>({});
  const [linkChoices, setLinkChoices] = useState<Record<string, string>>({});
  const [confirmNewExpense, setConfirmNewExpense] = useState<Record<string, boolean>>({});
  // One unlinked treatment per unresolved slot: link, already reflected in cash,
  // or a new expense. This is a person's explicit choice, never inferred.
  const [resolutionChoices, setResolutionChoices] = useState<
    Record<string, "link" | "reflected" | "new">
  >({});
  const billsVary = assumptions.expenseVariationMin !== 0 || assumptions.expenseVariationMax !== 0;
  const billSlots = useMemo(
    () => projectBillPayments(state, asOf, addDaysIso(asOf, horizonDays)).slots
      .sort((left, right) => left.dueDate.localeCompare(right.dueDate)),
    [state, asOf, horizonDays]
  );
  // Only an unresolved past one-time slot gets the "link a recorded expense" path.
  // Ordinary occupied slots keep the standard Mark paid behavior and copy.
  const unresolvedKeys = useMemo(
    () => new Set(
      unresolvedPastOneTimeSlots(state, asOf)
        .filter((slot) => slot.payment.id !== undefined)
        .map((slot) => paymentOccurrenceKey(slot.payment.id as number | string, slot.slotDate))
    ),
    [state, asOf]
  );
  const upcoming = slice.events.filter((event) => event.amount_cents < 0);

  function chooseResolution(key: string, choice: "link" | "reflected" | "new") {
    setResolutionChoices((current) => ({ ...current, [key]: choice }));
    if (choice !== "new") {
      setConfirmNewExpense((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
    if (choice !== "link") {
      setLinkChoices((current) => {
        if (!(key in current)) return current;
        const next = { ...current };
        delete next[key];
        return next;
      });
    }
  }

  async function settleRow(key: string, result: EditResult) {
    if (!(await onEdit(result, `bills:slot:${key}`)).ok) return;
    setLinkChoices((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setConfirmNewExpense((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
    setResolutionChoices((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  async function moveRow(key: string, result: EditResult) {
    const saved = await onEdit(result, `bills:slot:${key}`);
    if (!saved.ok) return;
    setMoveDates((current) => {
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  async function submit(event: React.FormEvent) {
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
    const saved = await onEdit(result, "bills:add");
    if (!saved.ok) {
      setError(saved.error);
      return;
    }
    setError(null);
    setName("");
  }

  return (
    <div className="space-y-6">
      {overdue.count > 0 && (
        <Notice tone="warning" title={`${overdue.count} past-due ${overdue.count === 1 ? "bill" : "bills"} to review`}>
          They total {formatMoney(overdue.total_cents)}
          {overdue.earliest_date ? `, earliest ${formatDateLabel(overdue.earliest_date)}` : ""}.{" "}
          {(overdue.unresolved_one_time_count ?? 0) > 0
            ? "A one-time bill with no linked bill record is not in the plan until you resolve it below: link a recorded expense, mark it paid if the payment is already reflected in your current cash, record it if it is not, or move it. A missing link does not prove no payment was made; nothing was added automatically."
            : "The forecast counts them today while they are unpaid."}
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
                <Button
                  type="button"
                  variant="quiet"
                  onClick={() => void onEdit(removePayment(state, payment.id ?? ""))}
                >
                  Remove {payment.name}
                </Button>
              </div>
            </li>
          ))}
        </ul>
        {billSlots.length > 0 && (
          <div className="mt-6 border-t border-line pt-4">
            <h3 className="font-semibold">Record or move a payment</h3>
            <p className="mt-1 text-sm text-muted">
              Marking an ordinary bill paid records the expense today. For a past one-time bill with no linked
              bill record, choose what happened: link the full posted expense if it is already in Money, mark it
              paid without a debit when the payment is already reflected in the cash you entered (for example, it
              is in “Money you have now”), or record a new expense only if the payment is not recorded and current
              cash excludes it. If it pays a debt, use the lender’s balance to update the amount still owed in Plan.
            </p>
            <ul className="mt-2 divide-y divide-line">
              {billSlots.map(({ payment, slotDate, dueDate }) => {
                if (payment.id === undefined) return null;
                const paymentId = payment.id;
                const key = paymentOccurrenceKey(paymentId, slotDate);
                const selectedDate = moveDates[key] ?? (dueDate < asOf ? asOf : dueDate);
                const isUnresolved = unresolvedKeys.has(key);
                const matches = isUnresolved
                  ? postedExpenseMatchesForPastOneTimeBill(state, paymentId, slotDate, asOf)
                  : [];
                const resolution = resolutionChoices[key];
                const choice = linkChoices[key] ?? "";
                const dueLabel = formatDateLabel(dueDate);
                return (
                  <li key={key} aria-label={`${payment.name} due ${dueLabel}`} className="grid gap-2 py-3 text-sm">
                    <span>{payment.name} · due {dueLabel} · {formatMoney(payment.amount_cents)}</span>
                    {isUnresolved && (
                      <fieldset className="grid gap-2 rounded-lg border border-line p-3">
                        <legend className="px-1 font-medium">What happened to this bill?</legend>
                        <p className="text-muted">
                          No linked bill record exists for this one-time bill. That does not prove no payment was
                          made. Choose one treatment; nothing is inferred from the opening balance.
                        </p>
                        <label className="flex items-start gap-2">
                          <input
                            type="radio"
                            name={`bill-resolution-${key}`}
                            checked={resolution === "link"}
                            disabled={matches.length === 0}
                            onChange={() => chooseResolution(key, "link")}
                          />
                          <span>
                            An expense for the full amount is already recorded in Money. Link it; this does not
                            change your balance or add a transaction.
                          </span>
                        </label>
                        {matches.length === 0 ? (
                          <p className="pl-6 text-muted">
                            Only a single recorded expense for the full amount can be linked. If you paid this in
                            parts or recorded a different amount, review the entries in Money instead of adding it again.
                          </p>
                        ) : resolution === "link" ? (
                          <div className="grid gap-2 pl-6">
                            <div className="flex flex-wrap items-center gap-2">
                              <select
                                className={`${fieldClass} w-auto`}
                                aria-label={`Recorded expense for ${payment.name} due ${dueLabel}`}
                                value={choice}
                                onChange={(event) => setLinkChoices((current) => ({ ...current, [key]: event.target.value }))}
                              >
                                <option value="">Select a recorded expense…</option>
                                {matches.map((match) => (
                                  <option key={String(match.id)} value={String(match.id)}>
                                    {formatDateLabel(match.date)} · {formatMoney(match.amountCents)} · {match.description} · {match.id}
                                  </option>
                                ))}
                              </select>
                              <Button
                                type="button"
                                variant="quiet"
                                disabled={!choice}
                                onClick={() => void settleRow(
                                  key,
                                  linkPostedExpenseToPastOneTimeBill(state, paymentId, slotDate, choice, asOf),
                                )}
                              >
                                Link recorded expense
                              </Button>
                            </div>
                          </div>
                        ) : null}
                        <label className="flex items-start gap-2">
                          <input
                            type="radio"
                            name={`bill-resolution-${key}`}
                            checked={resolution === "reflected"}
                            onChange={() => chooseResolution(key, "reflected")}
                          />
                          <span>
                            The payment is already reflected in the cash I have now. Mark it paid without a debit.
                            Use this when, for example, yesterday’s payment is already in “Money you have now”.
                          </span>
                        </label>
                        {resolution === "reflected" && (
                          <div className="grid gap-2 pl-6">
                            <p className="text-muted">
                              This records the bill as paid and adds no transaction or new expense. Your current
                              balance stays unchanged.
                            </p>
                            <div>
                              <Button
                                type="button"
                                variant="quiet"
                                onClick={() => void settleRow(
                                  key,
                                  markPastOneTimeBillPaidWithoutExpense(state, paymentId, slotDate, asOf),
                                )}
                              >
                                Mark paid without new expense
                              </Button>
                            </div>
                          </div>
                        )}
                        <label className="flex items-start gap-2">
                          <input
                            type="radio"
                            name={`bill-resolution-${key}`}
                            checked={resolution === "new"}
                            onChange={() => chooseResolution(key, "new")}
                          />
                          <span>
                            I paid it, but the payment is not recorded in Money and my current cash does not include
                            it. This records a new expense and lowers the balance.
                          </span>
                        </label>
                        {resolution === "new" && (
                          <div className="grid gap-2 pl-6">
                            <p className="text-muted">
                              Recording adds a {formatMoney(payment.amount_cents)} expense dated today. To
                              record the original date instead, add the expense in Money and then link it.
                              Do not do either if your current cash already reflects the payment.
                            </p>
                            <label className="flex items-start gap-2">
                              <input
                                type="checkbox"
                                checked={confirmNewExpense[key] ?? false}
                                onChange={(event) =>
                                  setConfirmNewExpense((current) => ({ ...current, [key]: event.target.checked }))
                                }
                              />
                              <span>I confirm this payment is not already recorded and is not reflected in my current cash.</span>
                            </label>
                            <div>
                              <Button
                                type="button"
                                variant="quiet"
                                disabled={!confirmNewExpense[key]}
                                onClick={() => void settleRow(
                                  key,
                                  markBillOccurrencePaid(state, paymentId, slotDate, asOf),
                                )}
                              >
                                Record new expense
                              </Button>
                            </div>
                          </div>
                        )}
                      </fieldset>
                    )}
                    <div className="flex flex-wrap items-center gap-2">
                      {!isUnresolved && (
                        <Button
                          type="button"
                          variant="quiet"
                          onClick={() => void onEdit(markBillOccurrencePaid(state, paymentId, slotDate, asOf))}
                        >
                          Mark paid
                        </Button>
                      )}
                      <input
                        className={`${fieldClass} w-auto`}
                        type="date"
                        value={selectedDate}
                        onChange={(event) => setMoveDates((current) => ({ ...current, [key]: event.target.value }))}
                        aria-label={`New date for ${payment.name} due ${dueLabel}`}
                      />
                      <Button
                        type="button"
                        variant="quiet"
                        onClick={() => void moveRow(
                          key, moveBillOccurrence(state, paymentId, slotDate, selectedDate),
                        )}
                      >
                        Move
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </Panel>
    </div>
  );
}
