"use client";

import React, { useEffect, useRef, useState } from "react";
import { formatDateLabel, isIsoDate } from "@/lib/dates";
import {
  addIncomeSchedule,
  dollarsToCents,
  parseDollarsToCents,
  reconcileBalance,
  recordCashflow,
  recordPaydayReceipt,
  removeIncome,
  type EditResult,
} from "@/lib/ledger-edits";
import { formatDollarsInput, formatMoney } from "@/lib/money-format";
import { cashMinusEnteredDebt, enteredDebtCents, transactionSumCents } from "@/lib/present";
import { nextIncomeDate } from "@/lib/scenario-builder";
import { type PersistenceResult } from "@/lib/sync-state";
import { type IncomeItem, type LedgerState } from "@/lib/types";
import { MoneyActivity } from "./MoneyActivity";
import { Button, Explain, fieldClass, Notice, Panel } from "./ui";

const RECONCILE_UNAVAILABLE_MESSAGE =
  "Reconcile was not submitted because the current cash summary and adjustment preview are unavailable.";

export type PurchaseToRecord = { amountCents: number; date: string };

/**
 * One explicit payday receipt. The schedule and ledger revision are captured
 * when the form opens; the actual receipt date and amount stay independent.
 */
interface PaydayReceiptDraft {
  draftKey: string;
  incomeId: number | string;
  name: string;
  scheduledDate: string;
  firstScheduledDate: string;
  expectedAmountCents: number;
  expectedUpdatedAt: string;
  date: string;
  amount: string;
  description: string;
}

export function MoneyView({
  state,
  asOf,
  startingBalanceCents,
  onEdit,
  onDiscardDraft,
  saving,
  purchaseToRecord,
  activitySearch,
}: {
  state: LedgerState;
  asOf: string;
  startingBalanceCents: number | null;
  onEdit: (result: EditResult, draftKey?: string) => Promise<PersistenceResult>;
  onDiscardDraft: (draftKey: string) => void;
  saving: boolean;
  purchaseToRecord?: PurchaseToRecord;
  activitySearch?: { text: string; request: number };
}) {
  const [kind, setKind] = useState<"Expense" | "Income">("Expense");
  const [amount, setAmount] = useState(() =>
    purchaseToRecord ? formatDollarsInput(purchaseToRecord.amountCents) : ""
  );
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [dateInput, setDate] = useState<string | null>(purchaseToRecord?.date ?? null);
  // An implicit date sent to a write stays visible while that write is queued or
  // failed. A successful write releases it, so a fresh untouched form follows asOf.
  const [pinnedDate, setPinnedDate] = useState<string | null>(null);
  const date = dateInput ?? pinnedDate ?? asOf;
  const [formError, setFormError] = useState<string | null>(null);
  const [recordNotice, setRecordNotice] = useState("");

  const [incomeName, setIncomeName] = useState("");
  const [incomeAmount, setIncomeAmount] = useState("");
  const [frequency, setFrequency] = useState<IncomeItem["frequency"]>("Bi-weekly");
  const [paydayInput, setPayday] = useState<string | null>(null);
  const [pinnedPayday, setPinnedPayday] = useState<string | null>(null);
  const payday = paydayInput ?? pinnedPayday ?? asOf;
  const [incomeError, setIncomeError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<PaydayReceiptDraft | null>(null);
  const [receiptError, setReceiptError] = useState<string | null>(null);
  const [receiptNotice, setReceiptNotice] = useState("");
  const receiptTriggerRef = useRef<HTMLButtonElement | null>(null);
  const restoreReceiptFocusRef = useRef(false);

  const [reconcile, setReconcile] = useState(() =>
    startingBalanceCents === null ? "" : formatDollarsInput(startingBalanceCents)
  );
  const [pinnedReconcileDate, setPinnedReconcileDate] = useState<string | null>(null);
  const reconcileDate = pinnedReconcileDate ?? asOf;
  const [reconcileError, setReconcileError] = useState<string | null>(null);

  const sum = transactionSumCents(state.transactions);
  const matches = sum === state.current_balance_cents;
  const debt = enteredDebtCents(state.liabilities);
  const net = startingBalanceCents === null ? null : cashMinusEnteredDebt(startingBalanceCents, state.liabilities);
  const futureCount = state.transactions.filter((tx) => tx.date > asOf).length;
  const reconcileCents = parseDollarsToCents(reconcile, { allowNegative: true });
  // A pending/failed reconcile keeps its original date, but a pin never makes
  // an unavailable or stale cash summary a valid basis for a preview.
  const reconcileBaseCents =
    startingBalanceCents === null || pinnedReconcileDate === null
      ? startingBalanceCents
      : transactionSumCents(state.transactions.filter((tx) => tx.date <= pinnedReconcileDate));
  const reconcileDiff =
    reconcileCents === null || reconcileBaseCents === null
      ? null
      : reconcileCents - reconcileBaseCents;
  // Reconciliation changes the ledger by the difference between the typed
  // balance and the checked cash basis. Without a forecast/current balance there
  // is no verified basis, so the adjustment preview and submission are withheld.
  const reconcilePreviewUnavailable = reconcileBaseCents === null;

  useEffect(() => {
    if (!reconcilePreviewUnavailable) {
      setReconcileError((current) => (current === RECONCILE_UNAVAILABLE_MESSAGE ? null : current));
    }
  }, [reconcilePreviewUnavailable]);

  useEffect(() => {
    if (receipt !== null || saving || !restoreReceiptFocusRef.current) return;
    restoreReceiptFocusRef.current = false;
    receiptTriggerRef.current?.focus();
  }, [receipt, saving]);

  async function submitRecord(event: React.FormEvent) {
    event.preventDefault();
    setRecordNotice("");
    const cents = parseDollarsToCents(amount);
    if (cents === null || cents <= 0) {
      setFormError("Enter an amount greater than zero with no more than two decimal places.");
      return;
    }
    const submittedAmount = amount;
    const submittedDescription = description;
    const submittedDate = date;
    const result = recordCashflow(state, {
      date: submittedDate,
      kind,
      amountCents: cents,
      category,
      description,
    });
    if (!result.ok) {
      setFormError(result.error);
      return;
    }
    setFormError(null);
    setPinnedDate(submittedDate);
    const saved = await onEdit(result, "money:record");
    if (!saved.ok) {
      // Keep the submitted draft visible so the user can retry without retyping.
      // The date pin also makes the retry reuse the date this attempt communicated.
      setFormError(saved.error);
      return;
    }
    setFormError(null);
    setPinnedDate((current) => (current === submittedDate ? null : current));
    setRecordNotice(
      `${submittedDate > asOf ? "Scheduled" : "Recorded"} ${formatMoney(cents)} ${
        kind === "Expense" ? "out" : "in"
      } on ${formatDateLabel(submittedDate)}.`
    );
    // Clear only what was actually submitted. A value changed while the write
    // was pending belongs to the next draft and must survive the previous save.
    setAmount((current) => (current === submittedAmount ? "" : current));
    setDescription((current) => (current === submittedDescription ? "" : current));
  }

  async function submitIncome(event: React.FormEvent) {
    event.preventDefault();
    const cents = dollarsToCents(Number(incomeAmount));
    if (cents === null) {
      setIncomeError("Enter the take-home amount.");
      return;
    }
    const submittedName = incomeName;
    const submittedPayday = payday;
    const result = addIncomeSchedule(state, {
      name: incomeName,
      amountCents: cents,
      frequency,
      nextPayday: submittedPayday,
    });
    if (!result.ok) {
      setIncomeError(result.error);
      return;
    }
    setIncomeError(null);
    setPinnedPayday(submittedPayday);
    const saved = await onEdit(result, "money:income");
    if (!saved.ok) {
      setIncomeError(saved.error);
      return;
    }
    setIncomeError(null);
    setPinnedPayday((current) => (current === submittedPayday ? null : current));
    setIncomeName((current) => (current === submittedName ? "" : current));
  }

  function openReceipt(income: IncomeItem, trigger?: HTMLButtonElement | null) {
    if (income.id === undefined) return;
    // The persisted date is the first still-unconfirmed occurrence. Defaulting
    // to a rolled-forward projection would consume a different paycheck.
    const scheduledDate = income.next_payday;
    // The plan uses expected_amount for the next projected paycheck; fall back
    // to the usual take-home amount when no one-off expectation is recorded.
    const expectedCents = income.expected_amount ?? income.amount_cents;
    receiptTriggerRef.current = trigger ?? null;
    restoreReceiptFocusRef.current = false;
    setReceipt({
      draftKey: `money:receipt:${String(income.id)}:${scheduledDate}`,
      incomeId: income.id,
      name: income.name,
      scheduledDate,
      firstScheduledDate: scheduledDate,
      expectedAmountCents: expectedCents,
      expectedUpdatedAt: state.updated_at,
      date: asOf,
      amount: formatDollarsInput(expectedCents),
      description: "",
    });
    setReceiptError(null);
    setReceiptNotice("");
  }

  function cancelReceipt() {
    if (!receipt) return;
    onDiscardDraft(receipt.draftKey);
    restoreReceiptFocusRef.current = true;
    setReceipt(null);
    setReceiptError(null);
  }

  async function submitReceipt(event: React.FormEvent) {
    event.preventDefault();
    if (!receipt || saving) return;
    const cents = parseDollarsToCents(receipt.amount);
    if (cents === null || cents <= 0) {
      setReceiptError("Enter the amount actually received, greater than zero with no more than two decimal places.");
      return;
    }
    if (!isIsoDate(receipt.date)) {
      setReceiptError("Use a valid calendar date for the receipt.");
      return;
    }
    if (receipt.date > asOf) {
      setReceiptError("The receipt date cannot be after today. Change the date or record it on that day.");
      return;
    }
    const submittedName = receipt.name;
    const submittedDate = receipt.date;
    const result = recordPaydayReceipt(state, {
      incomeId: receipt.incomeId,
      scheduledDate: receipt.scheduledDate,
      expectedUpdatedAt: receipt.expectedUpdatedAt,
      date: receipt.date,
      amountCents: cents,
      description: receipt.description,
    });
    if (!result.ok) {
      setReceiptError(result.error);
      return;
    }
    const saved = await onEdit(result, receipt.draftKey);
    if (!saved.ok) {
      // Keep the exact submitted schedule, dates, amount, and ledger revision so
      // a retry does not silently consume a different payday.
      setReceiptError(saved.error);
      return;
    }
    // Clear only after the write is verified. Until then the form retains the
    // selected schedule and any typed values for a straightforward retry.
    onDiscardDraft(receipt.draftKey);
    restoreReceiptFocusRef.current = true;
    setReceipt(null);
    setReceiptError(null);
    setReceiptNotice(
      `Recorded ${formatMoney(cents)} received on ${formatDateLabel(submittedDate)} for ${submittedName}. The selected payday is no longer pending.`
    );
  }

  async function submitReconcile(event: React.FormEvent) {
    event.preventDefault();
    if (reconcilePreviewUnavailable) {
      // A difference computed from an unavailable basis could silently restore
      // a stale balance. Refuse before parsing or building any write.
      setReconcileError(RECONCILE_UNAVAILABLE_MESSAGE);
      return;
    }
    if (reconcileCents === null) {
      setReconcileError("Enter the balance you see, using no more than two decimal places.");
      return;
    }
    const submittedDate = reconcileDate;
    const result = reconcileBalance(state, reconcileCents, submittedDate);
    if (!result.ok) {
      setReconcileError(result.error);
      return;
    }
    setReconcileError(null);
    setPinnedReconcileDate(submittedDate);
    const saved = await onEdit(result, "money:reconcile");
    if (!saved.ok) {
      setReconcileError(saved.error);
      return;
    }
    setReconcileError(null);
    setPinnedReconcileDate((current) => (current === submittedDate ? null : current));
  }

  return (
    <fieldset disabled={saving} className="m-0 min-w-0 w-full space-y-6 border-0 p-0">
      <Panel
        title="What you have"
        lede={startingBalanceCents === null
          ? "The current cash summary is unavailable. Your recorded activity and open drafts are still available below."
          : "This balance uses transactions dated today or earlier. Expected paychecks appear on their scheduled dates."}
      >
        {startingBalanceCents !== null && (
          <div className="rounded-xl border border-line bg-inset p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted">Cash on hand today</p>
                <p className="mt-1 break-words text-3xl font-semibold tabular-nums text-ink sm:text-4xl">
                  {formatMoney(startingBalanceCents)}
                </p>
              </div>
              <span className="inline-flex items-center rounded-full border border-line bg-surface px-2.5 py-1 text-xs font-medium text-muted">
                One cash pool
              </span>
            </div>
          </div>
        )}
        {matches && startingBalanceCents !== null && (
          <p className="mt-2 text-sm text-muted">
            The ledger total of {formatMoney(state.current_balance_cents)} matches {state.transactions.length} recorded {state.transactions.length === 1 ? "transaction" : "transactions"}.
          </p>
        )}
        {!matches && (
          <div className="mt-3">
            <Notice tone="danger" title="The balance and the transactions disagree">
              Recorded balance {formatMoney(state.current_balance_cents)}. Transaction sum{" "}
              {sum === null ? "could not be totaled" : formatMoney(sum)}. Fix this before relying on the plan.
            </Notice>
          </div>
        )}
        {futureCount > 0 && startingBalanceCents !== null && (
          <p className="mt-3 text-sm text-muted">
            {futureCount} transaction{futureCount === 1 ? "" : "s"} dated after today {futureCount === 1 ? "is" : "are"} not
            treated as money already in hand. The plan starts from {formatMoney(startingBalanceCents)} and applies{" "}
            {futureCount === 1 ? "it" : "them"} on {futureCount === 1 ? "that date" : "those dates"}.
          </p>
        )}
        {debt !== null && debt > 0 && net !== null && (
          <p className="mt-3 text-sm text-muted">
            Active debt balances you entered total {formatMoney(debt)}. Cash today minus those balances is {formatMoney(net)}.
            That is not full net worth. It ignores anything you did not enter.
          </p>
        )}
        <div className="mt-4">
          <Explain term="net worth">
            Net worth is what you own minus what you owe. This screen only subtracts the debt balances stored here from
            today’s cash balance. A full net worth would include your other assets and debts.
          </Explain>
        </div>
      </Panel>

      <Panel title="Record money in or out" lede="This updates the ledger. A future date is kept as scheduled, not as money already spent.">
        {purchaseToRecord && !recordNotice && (
          <p className="mb-3 text-sm text-muted">Review the amount and date from your purchase comparison before saving.</p>
        )}
        {kind === "Income" && (
          <p className="mb-3 text-sm text-muted">
            This adds cash only. It does not mark a scheduled paycheck as received. Use Record receipt for a paycheck
            under “Paychecks you expect” when the money that arrived belongs to that schedule.
          </p>
        )}
        <form onSubmit={submitRecord} className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium text-ink">
            Kind
            <select className={`${fieldClass} mt-1`} value={kind} onChange={(e) => setKind(e.target.value as "Expense" | "Income")}>
              <option value="Expense">Money out</option>
              <option value="Income">Money in</option>
            </select>
          </label>
          <label className="block text-sm font-medium text-ink">
            Amount ($)
            <input
              id="money-entry-amount"
              className={`${fieldClass} mt-1`}
              inputMode="decimal"
              autoComplete="off"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <label className="block text-sm font-medium text-ink">
            Date
            <input
              className={`${fieldClass} mt-1`}
              type="date"
              value={date}
              onChange={(e) => {
                setDate(e.target.value);
                setPinnedDate(null);
              }}
            />
          </label>
          <label className="block text-sm font-medium text-ink">
            Category
            <input
              className={`${fieldClass} mt-1`}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              placeholder="Groceries"
            />
          </label>
          <label className="block text-sm font-medium text-ink sm:col-span-2">
            Note
            <input
              className={`${fieldClass} mt-1`}
              value={description}
              autoComplete="off"
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What was this for?"
            />
          </label>
          {formError && (
            <p className="text-sm text-danger sm:col-span-2" role="alert">
              {formError}
            </p>
          )}
          <div className="sm:col-span-2">
            <Button type="submit" className="w-full sm:w-auto">Record this</Button>
          </div>
          <p className="text-sm text-muted sm:col-span-2 empty:hidden" role="status">{recordNotice}</p>
        </form>
      </Panel>

      <MoneyActivity
        key={activitySearch?.request}
        initialQuery={activitySearch?.text}
        state={state}
        asOf={asOf}
        onEdit={onEdit}
        onDiscardDraft={onDiscardDraft}
        saving={saving}
      />

      <Panel
        title="Paychecks you expect"
        lede="These dates tell the plan when money arrives. They are not the same as money you have already recorded. A recorded receipt posts actual Income and consumes only that paycheck's selected payday."
      >
        <form onSubmit={submitIncome} className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm font-medium text-ink">
            Name
            <input
              className={`${fieldClass} mt-1`}
              value={incomeName}
              autoComplete="off"
              onChange={(e) => setIncomeName(e.target.value)}
              placeholder="Primary job"
            />
          </label>
          <label className="block text-sm font-medium text-ink">
            Take-home amount ($)
            <input
              className={`${fieldClass} mt-1`}
              inputMode="decimal"
              autoComplete="off"
              value={incomeAmount}
              onChange={(e) => setIncomeAmount(e.target.value)}
            />
          </label>
          <label className="block text-sm font-medium text-ink">
            How often
            <select className={`${fieldClass} mt-1`} value={frequency} onChange={(e) => setFrequency(e.target.value as IncomeItem["frequency"])}>
              <option>Weekly</option>
              <option>Bi-weekly</option>
              <option>Monthly</option>
              <option>One-time</option>
            </select>
          </label>
          <label className="block text-sm font-medium text-ink">
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
          {incomeError && (
            <p className="text-sm text-danger sm:col-span-2" role="alert">
              {incomeError}
            </p>
          )}
          <div className="sm:col-span-2">
            <Button type="submit" className="w-full sm:w-auto">Add income</Button>
          </div>
        </form>
        <ul className="mt-4 divide-y divide-line">
          {state.incomes.length === 0 && (
            <li className="rounded-xl border border-dashed border-line bg-inset p-4 text-sm">
              <p className="font-medium text-ink">No paycheck is scheduled</p>
              <p className="mt-1 text-muted">
                Add expected take-home pay above so the plan knows when money arrives. It is not recorded cash.
              </p>
            </li>
          )}
          {state.incomes.map((income) => {
            const nextDate = nextIncomeDate(income, asOf);
            const oneTimePast = income.frequency === "One-time" && income.next_payday < asOf;
            const receiptOpen =
              receipt !== null && String(receipt.incomeId) === String(income.id);
            return (
            <li key={String(income.id)} className="grid gap-2 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div className="min-w-0">
                <p className="break-words font-medium text-ink">{income.name}</p>
                <p className="text-muted">
                  {income.frequency} ·{" "}
                  {oneTimePast
                    ? `scheduled ${formatDateLabel(income.next_payday)} (past; no future occurrence)`
                    : nextDate !== income.next_payday
                      ? `next ${formatDateLabel(nextDate)} (entered date ${formatDateLabel(income.next_payday)} has passed)`
                      : `next ${formatDateLabel(income.next_payday)}`}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                <span className="min-w-0 break-words tabular-nums font-semibold">{formatMoney(income.amount_cents)}</span>
                {income.id !== undefined && (
                  <Button
                    type="button"
                    variant="quiet"
                    disabled={receipt !== null}
                    aria-expanded={receiptOpen}
                    aria-controls={receiptOpen ? "payday-receipt-form" : undefined}
                    onClick={(event) => openReceipt(income, event.currentTarget)}
                  >
                    Record receipt for {income.name}
                  </Button>
                )}
                <Button type="button" variant="quiet" onClick={() => void onEdit(removeIncome(state, income.id ?? ""))}>
                  Remove {income.name}
                </Button>
              </div>
            </li>
            );
          })}
        </ul>
        <p className="mt-4 text-sm text-muted empty:hidden" role="status">{receiptNotice}</p>
        {receipt !== null && (
          <form
            id="payday-receipt-form"
            onSubmit={submitReceipt}
            className="mt-4 space-y-3 rounded-xl border border-line bg-inset p-4"
            aria-labelledby="payday-receipt-title"
            aria-describedby="payday-receipt-help"
          >
            <div className="min-w-0">
              <h3 id="payday-receipt-title" className="break-words text-base font-semibold text-ink">
                Record a receipt for {receipt.name}
              </h3>
              <p className="mt-1 text-sm text-muted">
                First unconfirmed payday: {formatDateLabel(receipt.firstScheduledDate)} · expected {formatMoney(receipt.expectedAmountCents)}
              </p>
            </div>
            <p id="payday-receipt-help" className="text-sm text-muted">
              Pick the scheduled payday this deposit belongs to. Saving posts the actual income and advances this
              schedule past the selected date. If it arrived late, keep its original payday and enter the actual receipt date below.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block text-sm font-medium text-ink">
                Scheduled payday
                <input
                  className={`${fieldClass} mt-1`}
                  type="date"
                  min={receipt.firstScheduledDate}
                  value={receipt.scheduledDate}
                  onChange={(event) => setReceipt({ ...receipt, scheduledDate: event.target.value })}
                />
              </label>
              <label className="block text-sm font-medium text-ink">
                Receipt date
                <input
                  className={`${fieldClass} mt-1`}
                  type="date"
                  max={asOf}
                  value={receipt.date}
                  onChange={(event) => setReceipt({ ...receipt, date: event.target.value })}
                />
              </label>
              <label className="block text-sm font-medium text-ink">
                Amount received ($)
                <input
                  className={`${fieldClass} mt-1`}
                  inputMode="decimal"
                  autoComplete="off"
                  autoFocus
                  value={receipt.amount}
                  onChange={(event) => setReceipt({ ...receipt, amount: event.target.value })}
                />
              </label>
              <label className="block text-sm font-medium text-ink sm:col-span-2">
                Description (optional)
                <input
                  className={`${fieldClass} mt-1`}
                  autoComplete="off"
                  value={receipt.description}
                  placeholder={`Paycheck: ${receipt.name}`}
                  onChange={(event) => setReceipt({ ...receipt, description: event.target.value })}
                />
              </label>
            </div>
            {receiptError && (
              <p className="text-sm text-danger" role="alert">
                {receiptError}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              <Button type="submit">Save receipt</Button>
              <Button type="button" variant="quiet" onClick={cancelReceipt}>
                Cancel receipt
              </Button>
            </div>
          </form>
        )}
      </Panel>

      <Panel
        title="Match your balance"
        lede="If the cash you can actually use is different from this ledger, enter that balance. An adjustment is added so the transactions still add up. This does not contact a bank."
      >
        <form onSubmit={submitReconcile} className="max-w-md space-y-3">
          {reconcilePreviewUnavailable && (
            <Notice tone="warning" title="Balance match unavailable">
              The current cash summary could not be checked, so no adjustment preview can be shown. Reconciliation is
              disabled and your typed balance and date are kept. Nothing is submitted.
            </Notice>
          )}
          <label className="block text-sm font-medium text-ink">
            Balance you want recorded ($)
            <input
              className={`${fieldClass} mt-1`}
              inputMode="decimal"
              autoComplete="off"
              value={reconcile}
              required
              readOnly={reconcilePreviewUnavailable}
              onChange={(e) => setReconcile(e.target.value)}
            />
          </label>
          {((reconcileDiff !== null && Number.isSafeInteger(reconcileDiff)) || reconcileError) && (
            <div className="rounded-xl border border-line bg-inset p-3 text-sm">
              {reconcileDiff !== null && reconcileDiff !== 0 && Number.isSafeInteger(reconcileDiff) && (
                <p className="text-muted">
                  This will add an adjustment of {formatMoney(reconcileDiff)} dated {formatDateLabel(reconcileDate)}.
                </p>
              )}
              {reconcileDiff === 0 && (
                <p className="text-muted">This already matches the recorded balance. No adjustment will be added.</p>
              )}
              {reconcileError && (
                <p className="text-danger" role="alert">
                  {reconcileError}
                </p>
              )}
            </div>
          )}
          <Button type="submit" className="w-full sm:w-auto" disabled={reconcilePreviewUnavailable}>Reconcile Ledger</Button>
        </form>
      </Panel>
    </fieldset>
  );
}
