"use client";

import React, { useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { type Assumptions } from "@/lib/assumptions";
import { addDaysIso, formatDateLabel, relativeDay } from "@/lib/dates";
import {
  addBill,
  linkPostedExpenseToPastBill,
  markBillOccurrencePaid,
  markPastBillPaidWithoutExpense,
  moveBillOccurrence,
  parseDollarsToCents,
  postedExpenseMatchesForPastBill,
  removePayment,
  type EditResult,
} from "@/lib/ledger-edits";
import { formatMoney } from "@/lib/money-format";
import type { OverdueAssessment } from "@/lib/overdue";
import { type PlanSlice } from "@/lib/present";
import {
  firstMonthlyBillDate,
  paymentOccurrenceKey,
  projectBillPayments,
  type ProjectedDebtMinimum,
  unresolvedPastBillSlots,
} from "@/lib/scenario-builder";
import type { PersistenceResult } from "@/lib/sync-state";
import { type LedgerState, type PaymentItem } from "@/lib/types";
import type { EvaluatedTimelineRow } from "@/lib/scenarios";
import { Button, fieldClass, Notice, Panel } from "./ui";

function withoutDraft<T>(drafts: Record<string, T>, key: string): Record<string, T> {
  if (!(key in drafts)) return drafts;
  const next = { ...drafts };
  delete next[key];
  return next;
}

interface MoveDraft {
  paymentId: number | string;
  name: string;
  amountCents: number;
  /** Stable schedule slot, even after the row has left the projected window. */
  slotDate: string;
  /** Exact destination date chosen or pinned when Move was submitted. */
  destination: string;
}

/**
 * The exact payment attempt, not a ledger snapshot. It keeps the stable slot,
 * the person-facing amount, and the posting day submitted to the domain edit so
 * midnight or a retry cannot silently move either date.
 */
interface SettlementDraft {
  paymentId: number | string;
  name: string;
  amountCents: number;
  slotDate: string;
  /** An attempted new debit has a posting date; linking or no-debit alone does not. */
  transactionDate: string | null;
  treatment: "paid" | "new" | "link" | "reflected";
}

function settlementDescription(draft: SettlementDraft): string {
  if (draft.treatment === "link") return "Linking an expense already in Money; no new debit.";
  if (draft.treatment === "reflected") return "Marking it paid without a new debit.";
  return `New ${formatMoney(draft.amountCents)} expense dated ${draft.transactionDate}.`;
}

export function BillsView({
  state,
  asOf,
  slice,
  horizonDays,
  assumptions,
  overdue,
  debtMinimums,
  onEdit,
  onDiscardDraft,
}: {
  state: LedgerState;
  asOf: string;
  slice: PlanSlice<EvaluatedTimelineRow> | null;
  horizonDays: number;
  assumptions: Assumptions;
  overdue: OverdueAssessment;
  debtMinimums: ProjectedDebtMinimum[];
  onEdit: (result: EditResult, draftKey?: string) => Promise<PersistenceResult>;
  onDiscardDraft: (draftKey: string) => void;
}) {
  const [name, setName] = useState("");
  const [amount, setAmount] = useState("100");
  const [recurrence, setRecurrence] = useState<PaymentItem["recurrence"]>("Monthly");
  const [dueDay, setDueDay] = useState("15");
  const [dueDateInput, setDueDate] = useState<string | null>(null);
  // An implicit date is pinned only when a submitted non-Monthly bill needs a
  // displayed "Next date" that must not roll forward while the save is pending
  // or after a failure. A date the person typed stays in dueDateInput.
  const [implicitDueDate, setImplicitDueDate] = useState<string | null>(null);
  const [monthlyAnchorAsOf, setMonthlyAnchorAsOf] = useState<string | null>(null);
  const dueDate = dueDateInput ?? implicitDueDate ?? asOf;
  const [auto, setAuto] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Kept per stable slot, not per visible row: midnight, a horizon change, or a
  // failed move can remove the projected row without discarding the draft.
  const [moveDrafts, setMoveDrafts] = useState<Record<string, MoveDraft>>({});
  // One unsaved settlement attempt per slot, including ordinary Mark paid with
  // no typed values, so a failure still has a guard and a visible exact date.
  const [settlementDrafts, setSettlementDrafts] = useState<Record<string, SettlementDraft>>({});
  const [settlingKey, setSettlingKey] = useState<string | null>(null);
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
  // A past slot without a saved outcome needs explicit review. Ordinary
  // occupied slots keep the standard Mark paid behavior and copy.
  const unresolvedKeys = useMemo(
    () => new Set(
      unresolvedPastBillSlots(state, asOf)
        .filter((slot) => slot.payment.id !== undefined)
        .map((slot) => paymentOccurrenceKey(slot.payment.id as number | string, slot.slotDate))
    ),
    [state, asOf]
  );
  const upcoming = slice?.events.filter((event) => event.amount_cents < 0 && event.source?.kind !== "debt-minimum") ?? null;
  const hasDebtMinimum = debtMinimums.length > 0;
  const paidHistory = useMemo(() => {
    const payments = new Map(state.payments.map((payment) => [String(payment.id), payment]));
    const transactions = new Map(state.transactions.map((entry) => [String(entry.id), entry]));
    return state.bill_occurrences.filter((entry) => entry.paid)
      .sort((a, b) => b.due_date.localeCompare(a.due_date))
      .map((entry) => ({
        entry,
        payment: payments.get(String(entry.payment_id)),
        expense: entry.transaction_id == null ? undefined : transactions.get(String(entry.transaction_id)),
      }));
  }, [state.bill_occurrences, state.payments, state.transactions]);
  // The fallback list is only for drafts whose slot is no longer projected. It
  // deliberately does not add cash events, expose Mark paid, or widen a window.
  const projectedRowKeys = new Set(
    billSlots.flatMap(({ payment, slotDate }) =>
      payment.id === undefined ? [] : [paymentOccurrenceKey(payment.id as number | string, slotDate)]
    )
  );
  const retainedMoves = Object.entries(moveDrafts).filter(([key]) => !projectedRowKeys.has(key));
  const retainedSettlements = Object.entries(settlementDrafts).filter(([key]) => !projectedRowKeys.has(key));
  const paymentIds = new Set(state.payments.map((payment) => String(payment.id)));

  function chooseResolution(key: string, choice: "link" | "reflected" | "new") {
    setResolutionChoices((current) => ({ ...current, [key]: choice }));
    if (choice !== "new") {
      // A new cash debit must be confirmed again after changing treatments.
      setConfirmNewExpense((current) => withoutDraft(current, key));
    }
  }

  function retainMove(draft: MoveDraft) {
    setMoveDrafts((current) => ({
      ...current,
      [paymentOccurrenceKey(draft.paymentId, draft.slotDate)]: draft,
    }));
  }

  function cancelMove(key: string) {
    setMoveDrafts((current) => withoutDraft(current, key));
    onDiscardDraft(`bills:move:${key}`);
  }

  function cancelSettlement(key: string) {
    setSettlementDrafts((current) => withoutDraft(current, key));
    // Cancelling an attempt cannot authorize a fresh debit with a different date.
    setConfirmNewExpense((current) => withoutDraft(current, key));
    onDiscardDraft(`bills:settlement:${key}`);
  }

  function settlementDraft(
    payment: PaymentItem,
    slotDate: string,
    key: string,
    treatment: SettlementDraft["treatment"]
  ): SettlementDraft {
    return {
      paymentId: payment.id as number | string,
      name: payment.name,
      amountCents: payment.amount_cents,
      slotDate,
      // A retry keeps the first attempt's posting day; only a new attempt uses today.
      transactionDate: settlementDrafts[key]?.transactionDate
        ?? (treatment === "paid" || treatment === "new" ? asOf : null),
      treatment,
    };
  }

  function clearSlotDrafts(key: string) {
    cancelMove(key);
    cancelSettlement(key);
    setLinkChoices((current) => withoutDraft(current, key));
    setResolutionChoices((current) => withoutDraft(current, key));
  }

  async function settleRow(
    key: string,
    draft: SettlementDraft,
    build: (pinned: SettlementDraft) => EditResult
  ) {
    const result = build(draft);
    if (!result.ok) {
      // Rejected validation never became a draft, so it must not pin a date.
      await onEdit(result);
      return;
    }
    const hasMoveDraft = key in moveDrafts;
    if (
      hasMoveDraft &&
      !window.confirm(
        "This bill has an unsaved moved date. Marking it paid discards that move draft. Mark paid and discard the move?"
      )
    ) {
      return;
    }
    retainSettlement(draft);
    setSettlingKey(key);
    try {
      if ((await onEdit(result, `bills:settlement:${key}`)).ok) clearSlotDrafts(key);
    } finally {
      setSettlingKey(null);
    }
  }

  function retainSettlement(draft: SettlementDraft) {
    setSettlementDrafts((current) => ({
      ...current,
      [paymentOccurrenceKey(draft.paymentId, draft.slotDate)]: draft,
    }));
  }

  async function moveRow(draft: MoveDraft) {
    const key = paymentOccurrenceKey(draft.paymentId, draft.slotDate);
    const result = moveBillOccurrence(state, draft.paymentId, draft.slotDate, draft.destination);
    if (!result.ok) {
      // Typed move drafts are already retained; only a valid submission pins an
      // untouched default so midnight cannot change the move while it is pending.
      await onEdit(result);
      return;
    }
    if (
      (key in resolutionChoices || key in settlementDrafts) &&
      !window.confirm("Moving this bill discards its unsaved payment choice. Move it?")
    ) {
      return;
    }
    retainMove(draft);
    if ((await onEdit(result, `bills:move:${key}`)).ok) clearSlotDrafts(key);
  }

  function buildBillExpense(draft: SettlementDraft): EditResult {
    if (draft.transactionDate === null) return { ok: false, error: "No posting date was selected for this expense." };
    return markBillOccurrencePaid(state, draft.paymentId, draft.slotDate, draft.transactionDate);
  }

  function retrySettlement(draft: SettlementDraft) {
    const key = paymentOccurrenceKey(draft.paymentId, draft.slotDate);
    void settleRow(key, draft, buildBillExpense);
  }

  async function removeBill(paymentId: number | string) {
    // The last separator belongs to the slot date; imported payment IDs are opaque.
    const draftKeys = [
      ...new Set([...Object.keys(moveDrafts), ...Object.keys(resolutionChoices), ...Object.keys(settlementDrafts)]),
    ].filter((key) => key.slice(0, key.lastIndexOf("::")) === String(paymentId));
    if (draftKeys.length && !window.confirm("Removing this bill also discards its unsaved drafts. Remove it?")) return;
    if (!(await onEdit(removePayment(state, paymentId))).ok) return;
    for (const key of draftKeys) {
      clearSlotDrafts(key);
    }
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const cents = parseDollarsToCents(amount);
    if (cents === null) {
      setError("Enter a bill amount greater than zero.");
      return;
    }
    const submittedDueDate = dueDate;
    const result = addBill(state, {
      name,
      amountCents: cents,
      recurrence,
      dueDay: Number(dueDay),
      asOf: monthlyAnchorAsOf ?? asOf,
      dueDate: submittedDueDate,
      autoWithdraw: auto,
    });
    if (!result.ok) {
      setError(result.error);
      return;
    }
    if (recurrence !== "Monthly" && dueDateInput === null) {
      setImplicitDueDate(submittedDueDate);
    } else if (recurrence === "Monthly") {
      setMonthlyAnchorAsOf((current) => current ?? asOf);
    }
    const saved = await onEdit(result, "bills:add");
    if (!saved.ok) {
      setError(saved.error);
      return;
    }
    setError(null);
    setName("");
    // A fresh default stays live; an explicitly typed date remains in its input.
    setImplicitDueDate(null);
    setMonthlyAnchorAsOf(null);
  }

  return (
    <div className="space-y-6">
      {overdue.count > 0 && (
        <Notice tone="warning" title={`${overdue.count} past-due ${overdue.count === 1 ? "bill" : "bills"} to review`}>
          They total {formatMoney(overdue.total_cents)}
          {overdue.earliest_date ? `, earliest ${formatDateLabel(overdue.earliest_date)}` : ""}.{" "}
          {(overdue.unresolved_recurring_count ?? 0) > 0
            ? "A recurring payment needs a decision. Review the first unresolved payment for each affected schedule below. No expense was added automatically."
            : (overdue.unresolved_one_time_count ?? 0) > 0
            ? "A one-time bill with no linked bill record is not in the plan until you resolve it below: link a recorded expense, mark it paid if the payment is already reflected in your current cash, record it if it is not, or move it. A missing link does not prove no payment was made; nothing was added automatically."
            : upcoming
              ? "The forecast counts them today while they are unpaid."
              : "These unpaid occurrences are saved, but no forecast is available."}
        </Notice>
      )}
      {upcoming && <Panel
        title="Payments coming up"
        lede={`These are bills and required debt minimums on the schedule for the next ${horizonDays} days. Nothing here has been marked paid.`}
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
              <li key={`${event.date}-${event.name}-${index}`} className="grid gap-1 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(0,auto)]">
                <div className="min-w-0">
                  <p className="break-words font-medium">{event.name}</p>
                  <p className="text-muted">
                    {event.source?.kind === "bill" && event.source.dueDate < asOf
                      ? `Overdue since ${formatDateLabel(event.source.dueDate)} · counted today`
                      : `${formatDateLabel(event.date)} · ${relativeDay(asOf, event.date)} · ${
                        event.source?.kind === "posted-transaction" ? "Future-dated entry" : "Unpaid"
                      }`}
                  </p>
                </div>
                <div className="min-w-0 break-words text-left sm:text-right">
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
      </Panel>}

      {hasDebtMinimum && (
        <Panel
          title="Required debt minimums"
          lede="These amounts come from the balance, minimum payment, and due day recorded in Plan. They are not bills entered in this section, and changing a bill here does not change them."
        >
          <ul className="divide-y divide-line">
            {debtMinimums.map((minimum, index) => (
              <li key={`${minimum.liability_id}-${minimum.date}-${index}`} className="grid gap-1 py-3 text-sm sm:grid-cols-[1fr_auto]">
                <div>
                  <p className="font-medium">{minimum.name}</p>
                  <p className="text-muted">
                    {formatDateLabel(minimum.date)} · {relativeDay(asOf, minimum.date)} · required debt minimum
                    {minimum.due_day_of_month === null ? " (no due day set; assumed the 1st)" : ` · due day ${minimum.due_day_of_month}`}
                  </p>
                </div>
                <p className="tabular-nums font-semibold sm:text-right">{formatMoney(-minimum.amount_cents)}</p>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-sm text-muted">Update the debt in Plan. A debt with no due day is assumed to be due on the 1st.</p>
        </Panel>
      )}

      <details className="workspace-panel group">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 font-semibold [&::-webkit-details-marker]:hidden">
          <span>Payment history</span>
          <span className="flex items-center gap-2 text-sm font-normal text-muted">
            {paidHistory.length} marked paid <ChevronDown size={16} className="group-open:rotate-180" aria-hidden="true" />
          </span>
        </summary>
        {paidHistory.length === 0 ? (
          <p className="text-sm text-muted">No saved bill occurrences have been marked paid.</p>
        ) : (
          <ul className="mt-2 divide-y divide-line">
            {paidHistory.map(({ entry, payment, expense }) => (
              <li key={paymentOccurrenceKey(entry.payment_id, entry.original_due_date ?? entry.due_date)}
                className="grid gap-1 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto]">
                <div className="min-w-0">
                  <p className="break-words font-semibold">{payment?.name ?? "Archived bill"}</p>
                  <p className="text-muted">Due {formatDateLabel(entry.due_date)} · Marked paid</p>
                </div>
                <p className="min-w-0 break-words tabular-nums sm:text-right">
                  {expense ? `${formatMoney(expense.amount_cents)} on ${formatDateLabel(expense.date)}` : "No linked expense"}
                </p>
              </li>
            ))}
          </ul>
        )}
      </details>

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
              <input className={`${fieldClass} mt-1`} type="number" min="1" max="31" value={dueDay} onChange={(e) => {
                setDueDay(e.target.value);
                setMonthlyAnchorAsOf(null);
              }} />
              {/^(?:[1-9]|[12][0-9]|3[01])$/.test(dueDay) && (
                <span className="mt-1 block font-normal text-muted">First due {formatDateLabel(firstMonthlyBillDate(monthlyAnchorAsOf ?? asOf, Number(dueDay)))}</span>
              )}
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
              <div className="min-w-0">
                <p className="break-words font-medium">{payment.name}</p>
                <p className="text-muted">
                  {payment.recurrence}
                  {payment.recurrence === "Monthly" && payment.due_day ? ` · due day ${payment.due_day}` : ""}
                  {payment.due_date ? ` · ${payment.recurrence === "One-time" ? "on" : "starts"} ${formatDateLabel(payment.due_date)}` : ""}
                  {payment.is_auto_withdraw ? " · you marked this as leaving on its own" : " · amount you entered"}
                </p>
              </div>
              <div className="flex min-w-0 flex-wrap items-center gap-3">
                <span className="min-w-0 break-words tabular-nums font-semibold">{formatMoney(payment.amount_cents)}</span>
                <Button
                  type="button"
                  variant="quiet"
                  onClick={() => void removeBill(payment.id ?? "")}
                >
                  Remove {payment.name}
                </Button>
              </div>
            </li>
          ))}
        </ul>
        {(billSlots.length > 0 || retainedMoves.length > 0 || retainedSettlements.length > 0) && (
          <div className="mt-6 border-t border-line pt-4">
            <h3 className="font-semibold">Record or move a payment</h3>
            <p className="mt-1 text-sm text-muted">
              Marking an ordinary bill paid records an expense dated the day you submit Mark paid; a retry keeps
              that same posting date.
               For a past bill with no linked bill record, choose what happened: link the full posted
              expense if it is already in Money, mark it paid without a debit when the payment is already reflected
              in the cash you entered (for example, it is in “Money you have now”), or record a new expense only if
              the payment is not recorded and current cash excludes it. If it pays a debt, use the lender’s balance
              to update the amount still owed in Plan.
            </p>
            <ul className="mt-2 divide-y divide-line">
              {billSlots.map(({ payment, slotDate, dueDate }) => {
                if (payment.id === undefined) return null;
                const paymentId = payment.id;
                const key = paymentOccurrenceKey(paymentId, slotDate);
                const moveDraft = moveDrafts[key];
                const settlementAttempt = settlementDrafts[key];
                const selectedDate = moveDraft?.destination ?? (dueDate < asOf ? asOf : dueDate);
                const isUnresolved = unresolvedKeys.has(key);
                const matches = isUnresolved
                  ? postedExpenseMatchesForPastBill(state, paymentId, slotDate, asOf)
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
                           No linked bill record exists for this bill. That does not prove no payment was
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
                                disabled={!choice || settlingKey !== null}
                                onClick={() => void settleRow(
                                  key,
                                  settlementDraft(payment, slotDate, key, "link"),
                                   () => linkPostedExpenseToPastBill(state, paymentId, slotDate, choice, asOf),
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
                                disabled={settlingKey !== null}
                                onClick={() => void settleRow(
                                  key,
                                  settlementDraft(payment, slotDate, key, "reflected"),
                                   () => markPastBillPaidWithoutExpense(state, paymentId, slotDate, asOf),
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
                              Recording adds a {formatMoney(payment.amount_cents)} expense dated{" "}
                              {formatDateLabel(settlementAttempt?.transactionDate ?? asOf)}
                              {settlementAttempt?.transactionDate ? "; a retry keeps that attempted posting date" : ""}. To record
                              a different date instead, add the expense in Money and then link it. Do not do either
                              if your current cash already reflects the payment.
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
                                disabled={!confirmNewExpense[key] || settlingKey !== null}
                                onClick={() => void settleRow(
                                  key,
                                  settlementDraft(payment, slotDate, key, "new"),
                                  buildBillExpense,
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
                          disabled={settlingKey !== null}
                          onClick={() => void settleRow(
                            key,
                            settlementDraft(payment, slotDate, key, "paid"),
                            buildBillExpense,
                          )}
                        >
                          Mark paid
                        </Button>
                      )}
                      <input
                        className={`${fieldClass} w-auto`}
                        type="date"
                        value={selectedDate}
                        onChange={(event) =>
                          retainMove({
                            paymentId,
                            name: payment.name,
                            amountCents: payment.amount_cents,
                            slotDate,
                            destination: event.target.value,
                          })
                        }
                        aria-label={`New date for ${payment.name} due ${dueLabel}`}
                      />
                      <Button
                        type="button"
                        variant="quiet"
                        onClick={() =>
                          void moveRow({
                            paymentId,
                            name: payment.name,
                            amountCents: payment.amount_cents,
                            slotDate,
                            destination: selectedDate,
                          })
                        }
                      >
                        Move
                      </Button>
                      {moveDraft && (
                        <Button type="button" variant="quiet" onClick={() => cancelMove(key)}>
                          Cancel move
                        </Button>
                      )}
                    </div>
                    {settlementAttempt && (
                      <div className="rounded-lg border border-warning bg-warning-soft p-2">
                        <p className="text-muted">
                          {settlingKey === key ? "Saving the payment attempt." : "Payment attempt not saved."}{" "}
                          {settlementDescription(settlementAttempt)}
                        </p>
                        {isUnresolved && settlementAttempt.transactionDate !== null && settlingKey !== key && (
                          <p className="text-muted">
                            This bill is now past due. Choose one of the review treatments above; a new
                            expense keeps the attempted posting date shown here.
                          </p>
                        )}
                        <div>
                          <Button
                            type="button"
                            variant="quiet"
                            disabled={settlingKey !== null}
                            onClick={() => cancelSettlement(key)}
                          >
                            Cancel payment attempt
                          </Button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
            {retainedMoves.length > 0 && (
              <div className="mt-4 rounded-lg border border-warning bg-warning-soft p-3">
                <h4 className="font-semibold">Kept move drafts</h4>
                <p className="mt-1 text-sm text-muted">
                  These bills’ scheduled slots are no longer in the projected list. Your unsaved move is kept
                  here; it is not saved, and it is not part of the forecast, until the move succeeds. Cancel
                  discards only that draft.
                </p>
                <ul className="mt-2 divide-y divide-line">
                  {retainedMoves.map(([key, draft]) => {
                    const slotLabel = `${draft.name}, original slot ${formatDateLabel(draft.slotDate)}`;
                    const missingPayment = !paymentIds.has(String(draft.paymentId));
                    return (
                      <li key={key} aria-label={`Kept move for ${slotLabel}`} className="grid gap-2 py-3 text-sm">
                        <span>
                          {draft.name} · original slot {formatDateLabel(draft.slotDate)} ({draft.slotDate}) ·{" "}
                          {formatMoney(draft.amountCents)}
                        </span>
                        <p className="text-muted">
                          New date <span className="font-medium text-ink">{draft.destination}</span> — not saved
                          to the ledger until the move succeeds.
                        </p>
                        {missingPayment && (
                          <p className="text-muted">This bill is no longer in the ledger. Copy the date or cancel the move.</p>
                        )}
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            className={`${fieldClass} w-auto`}
                            type="date"
                            value={draft.destination}
                            onChange={(event) =>
                              retainMove({ ...draft, destination: event.target.value })
                            }
                            aria-label={`New date for kept move of ${slotLabel}`}
                          />
                          <Button type="button" variant="quiet" disabled={missingPayment} onClick={() => void moveRow(draft)}>
                            Move
                          </Button>
                          <Button type="button" variant="quiet" onClick={() => cancelMove(key)}>
                            Cancel move
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {retainedSettlements.length > 0 && (
              <div className="mt-4 rounded-lg border border-warning bg-warning-soft p-3">
                <h4 className="font-semibold">Kept payment attempts</h4>
                <p className="mt-1 text-sm text-muted">
                  These bills’ scheduled slots are no longer in the projected list. Your unsaved attempts are
                  kept here. They do not change the saved ledger or forecast. Cancel discards only that attempt.
                </p>
                <ul className="mt-2 divide-y divide-line">
                  {retainedSettlements.map(([key, draft]) => {
                    const slotLabel = `${draft.name}, original slot ${formatDateLabel(draft.slotDate)}`;
                    const missingPayment = !paymentIds.has(String(draft.paymentId));
                    // A slot that is now past due is resolved only through
                    // its explicit review treatments, never a direct paid retry.
                    const needsReview = unresolvedKeys.has(key);
                    const retryable =
                      !missingPayment &&
                      !needsReview &&
                      draft.treatment === "paid" &&
                      draft.transactionDate !== null;
                    return (
                      <li key={key} aria-label={`Kept payment for ${slotLabel}`} className="grid gap-2 py-3 text-sm">
                        <span>
                          {draft.name} · original slot {formatDateLabel(draft.slotDate)} ({draft.slotDate}) ·{" "}
                          {formatMoney(draft.amountCents)}
                        </span>
                        <p className="text-muted">
                          {settlingKey === key
                            ? "Saving this payment attempt; keep this tab open."
                            : "Payment attempt not saved to the ledger yet."}{" "}
                          {settlementDescription(draft)}
                        </p>
                        {needsReview && (
                          <p className="text-muted">
                            This bill is now past due. Use the review treatments in its bill row; a new
                            expense keeps the attempted posting date.
                          </p>
                        )}
                        {missingPayment && (
                          <p className="text-muted">This bill is no longer in the ledger. Copy the date or cancel the attempt.</p>
                        )}
                        <div className="flex flex-wrap items-center gap-2">
                          {draft.transactionDate !== null && (
                            <label className="flex items-center gap-2 text-muted">
                              Attempted expense date
                              <input
                                className={`${fieldClass} w-auto`}
                                type="date"
                                value={draft.transactionDate}
                                disabled
                                aria-label={`Posting date for kept payment of ${slotLabel}`}
                              />
                            </label>
                          )}
                          {retryable && (
                            <Button
                              type="button"
                              variant="quiet"
                              disabled={settlingKey !== null}
                              onClick={() => retrySettlement(draft)}
                            >
                              Retry Mark paid
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="quiet"
                            disabled={settlingKey !== null}
                            onClick={() => cancelSettlement(key)}
                          >
                            Cancel payment attempt
                          </Button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>
        )}
      </Panel>
    </div>
  );
}
