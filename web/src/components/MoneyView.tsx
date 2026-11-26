"use client";

import React, { useEffect, useState } from "react";
import { formatDateLabel } from "@/lib/dates";
import {
  addIncomeSchedule,
  deleteCashTransaction,
  dollarsToCents,
  editCashTransaction,
  parseDollarsToCents,
  reconcileBalance,
  recordCashflow,
  removeIncome,
  type EditResult,
} from "@/lib/ledger-edits";
import { formatDollarsInput, formatMoney } from "@/lib/money-format";
import { cashMinusEnteredDebt, enteredDebtCents, transactionSumCents } from "@/lib/present";
import { nextIncomeDate } from "@/lib/scenario-builder";
import { type PersistenceResult } from "@/lib/sync-state";
import { type IncomeItem, type LedgerState, type TransactionItem } from "@/lib/types";
import { Button, Explain, fieldClass, Notice, Panel } from "./ui";

const RECONCILE_UNAVAILABLE_MESSAGE =
  "Reconcile was not submitted because the current cash summary and adjustment preview are unavailable.";

export type PurchaseToRecord = { amountCents: number; date: string };

export function MoneyView({
  state,
  asOf,
  startingBalanceCents,
  onEdit,
  onDiscardDraft,
  saving,
  purchaseToRecord,
}: {
  state: LedgerState;
  asOf: string;
  startingBalanceCents: number | null;
  onEdit: (result: EditResult, draftKey?: string) => Promise<PersistenceResult>;
  onDiscardDraft: (draftKey: string) => void;
  saving: boolean;
  purchaseToRecord?: PurchaseToRecord;
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
  const [transactionEdit, setTransactionEdit] = useState<{
    id: string | number;
    amount: string;
    date: string;
    category: string;
    description: string;
  } | null>(null);
  const [transactionError, setTransactionError] = useState<string | null>(null);
  const [transactionNotice, setTransactionNotice] = useState("");

  const [incomeName, setIncomeName] = useState("");
  const [incomeAmount, setIncomeAmount] = useState("");
  const [frequency, setFrequency] = useState<IncomeItem["frequency"]>("Bi-weekly");
  const [paydayInput, setPayday] = useState<string | null>(null);
  const [pinnedPayday, setPinnedPayday] = useState<string | null>(null);
  const payday = paydayInput ?? pinnedPayday ?? asOf;
  const [incomeError, setIncomeError] = useState<string | null>(null);

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

  const rows = [...state.transactions].reverse();

  function openTransactionEdit(tx: TransactionItem) {
    if (tx.id === undefined || tx.type === "Adjustment") return;
    setTransactionNotice("");
    setTransactionError(null);
    setTransactionEdit({
      id: tx.id,
      amount: formatDollarsInput(Math.abs(tx.amount_cents)),
      date: tx.date,
      category: tx.category ?? "",
      description: tx.description ?? "",
    });
  }

  function closeTransactionEdit() {
    onDiscardDraft("money:edit");
    setTransactionEdit(null);
    setTransactionError(null);
  }

  async function submitTransactionEdit(event: React.FormEvent) {
    event.preventDefault();
    if (!transactionEdit || saving) return;
    const amountCents = parseDollarsToCents(transactionEdit.amount);
    if (amountCents === null || amountCents <= 0) {
      setTransactionError("Enter a positive amount with no more than two decimal places.");
      return;
    }
    const original = state.transactions.find((row) => row.id === transactionEdit.id);
    const result = editCashTransaction(state, transactionEdit.id, {
      amountCents,
      date: transactionEdit.date,
      category: transactionEdit.category === (original?.category ?? "") ? undefined : transactionEdit.category,
      description: transactionEdit.description === (original?.description ?? "") ? undefined : transactionEdit.description,
    });
    if (!result.ok) {
      setTransactionError(result.error);
      return;
    }
    const saved = await onEdit(result, "money:edit");
    if (!saved.ok) {
      setTransactionError(saved.error);
      return;
    }
    closeTransactionEdit();
    setTransactionNotice("Transaction updated.");
  }

  async function removeTransaction(tx: TransactionItem) {
    if (tx.id === undefined || saving) return;
    const name = tx.description || tx.category || tx.type;
    if (!window.confirm(`Delete “${name}”? If this paid a bill, that bill will be reopened.`)) return;
    setTransactionNotice("");
    const saved = await onEdit(deleteCashTransaction(state, tx.id));
    setTransactionError(saved.ok ? null : saved.error);
    if (saved.ok) setTransactionNotice("Transaction deleted.");
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
          <p className="text-3xl font-semibold tabular-nums">{formatMoney(startingBalanceCents)}</p>
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
        <form onSubmit={submitRecord} className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm font-medium">
            Kind
            <select className={`${fieldClass} mt-1`} value={kind} onChange={(e) => setKind(e.target.value as "Expense" | "Income")}>
              <option value="Expense">Money out</option>
              <option value="Income">Money in</option>
            </select>
          </label>
          <label className="text-sm font-medium">
            Amount ($)
            <input id="money-entry-amount" className={`${fieldClass} mt-1`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label className="text-sm font-medium">
            Category
            <input className={`${fieldClass} mt-1`} value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Groceries" />
          </label>
          <label className="text-sm font-medium">
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
          <label className="text-sm font-medium sm:col-span-2">
            Note
            <input className={`${fieldClass} mt-1`} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          {formError && (
            <p className="text-sm text-danger sm:col-span-2" role="alert">
              {formError}
            </p>
          )}
          <div>
            <Button type="submit">Record this</Button>
          </div>
          <p className="text-sm text-muted sm:col-span-2 empty:hidden" role="status">{recordNotice}</p>
        </form>
      </Panel>

      <Panel title="Recorded activity">
        <p className="text-sm text-muted empty:hidden" role="status">{transactionNotice}</p>
        {transactionError && transactionEdit === null && (
          <p className="text-sm text-danger" role="alert">{transactionError}</p>
        )}
        {rows.length === 0 ? (
          <p className="text-sm text-muted">No transactions yet. Record income or spending above, or set an opening balance.</p>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((tx) => {
              const name = tx.description || tx.category || tx.type;
              const editable = tx.id !== undefined && tx.type !== "Adjustment";
              return (
              <li key={String(tx.id)} className="flex flex-wrap items-baseline justify-between gap-2 py-3 text-sm">
                <div>
                  <p className="font-medium">{name}</p>
                  <p className="text-muted">
                    {formatDateLabel(tx.date)} · {tx.category || tx.type}
                    {tx.date > asOf ? " · Scheduled, not spent yet" : ""}
                  </p>
                </div>
                <p className="tabular-nums font-semibold">{formatMoney(tx.amount_cents)}</p>
                {editable && transactionEdit === null && (
                  <div className="flex flex-wrap gap-2">
                    <Button type="button" variant="quiet" aria-label={`Edit ${name}`} onClick={() => openTransactionEdit(tx)}>Edit</Button>
                    <Button type="button" variant="quiet" aria-label={`Delete ${name}`} onClick={() => void removeTransaction(tx)}>Delete</Button>
                  </div>
                )}
                {transactionEdit !== null && transactionEdit.id === tx.id && (
                  <form onSubmit={submitTransactionEdit} className="grid w-full gap-3 sm:grid-cols-2">
                    <label>
                      Corrected amount ($)
                      <input className={`${fieldClass} mt-1`} inputMode="decimal" value={transactionEdit.amount}
                        onChange={(event) => setTransactionEdit({ ...transactionEdit, amount: event.target.value })} />
                    </label>
                    <label>
                      Corrected date
                      <input className={`${fieldClass} mt-1`} type="date" value={transactionEdit.date}
                        onChange={(event) => setTransactionEdit({ ...transactionEdit, date: event.target.value })} />
                    </label>
                    <label>
                      Corrected category
                      <input className={`${fieldClass} mt-1`} value={transactionEdit.category}
                        onChange={(event) => setTransactionEdit({ ...transactionEdit, category: event.target.value })} />
                    </label>
                    <label>
                      Corrected note
                      <input className={`${fieldClass} mt-1`} value={transactionEdit.description}
                        onChange={(event) => setTransactionEdit({ ...transactionEdit, description: event.target.value })} />
                    </label>
                    {transactionError && <p className="text-danger sm:col-span-2" role="alert">{transactionError}</p>}
                    <div className="flex gap-2 sm:col-span-2">
                      <Button type="submit">Save correction</Button>
                      <Button type="button" variant="quiet" onClick={closeTransactionEdit}>Cancel</Button>
                    </div>
                  </form>
                )}
              </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel
        title="Paychecks you expect"
        lede="These dates tell the plan when money arrives. They are not the same as money you have already recorded."
      >
        <form onSubmit={submitIncome} className="grid gap-3 sm:grid-cols-2">
          <label className="text-sm font-medium">
            Name
            <input className={`${fieldClass} mt-1`} value={incomeName} onChange={(e) => setIncomeName(e.target.value)} placeholder="Primary job" />
          </label>
          <label className="text-sm font-medium">
            Take-home amount ($)
            <input className={`${fieldClass} mt-1`} inputMode="decimal" value={incomeAmount} onChange={(e) => setIncomeAmount(e.target.value)} />
          </label>
          <label className="text-sm font-medium">
            How often
            <select className={`${fieldClass} mt-1`} value={frequency} onChange={(e) => setFrequency(e.target.value as IncomeItem["frequency"])}>
              <option>Weekly</option>
              <option>Bi-weekly</option>
              <option>Monthly</option>
              <option>One-time</option>
            </select>
          </label>
          <label className="text-sm font-medium">
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
          <div>
            <Button type="submit">Add income</Button>
          </div>
        </form>
        <ul className="mt-4 divide-y divide-line">
          {state.incomes.length === 0 && <li className="py-3 text-sm text-muted">No paycheck is scheduled.</li>}
          {state.incomes.map((income) => {
            const nextDate = nextIncomeDate(income, asOf);
            const oneTimePast = income.frequency === "One-time" && income.next_payday < asOf;
            return (
            <li key={String(income.id)} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
              <div>
                <p className="font-medium">{income.name}</p>
                <p className="text-muted">
                  {income.frequency} ·{" "}
                  {oneTimePast
                    ? `scheduled ${formatDateLabel(income.next_payday)} (past; no future occurrence)`
                    : nextDate !== income.next_payday
                      ? `next ${formatDateLabel(nextDate)} (entered date ${formatDateLabel(income.next_payday)} has passed)`
                      : `next ${formatDateLabel(income.next_payday)}`}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="tabular-nums font-semibold">{formatMoney(income.amount_cents)}</span>
                <Button type="button" variant="quiet" onClick={() => void onEdit(removeIncome(state, income.id ?? ""))}>
                  Remove {income.name}
                </Button>
              </div>
            </li>
            );
          })}
        </ul>
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
          <label className="block text-sm font-medium">
            Balance you want recorded ($)
            <input
              className={`${fieldClass} mt-1`}
              inputMode="decimal"
              value={reconcile}
              required
              readOnly={reconcilePreviewUnavailable}
              onChange={(e) => setReconcile(e.target.value)}
            />
          </label>
          {reconcileDiff !== null && reconcileDiff !== 0 && Number.isSafeInteger(reconcileDiff) && (
            <p className="text-sm text-muted">
              This will add an adjustment of {formatMoney(reconcileDiff)} dated {formatDateLabel(reconcileDate)}.
            </p>
          )}
          {reconcileDiff === 0 && (
            <p className="text-sm text-muted">This already matches the recorded balance. No adjustment will be added.</p>
          )}
          {reconcileError && (
            <p className="text-sm text-danger" role="alert">
              {reconcileError}
            </p>
          )}
          <Button type="submit" disabled={reconcilePreviewUnavailable}>Reconcile Ledger</Button>
        </form>
      </Panel>
    </fieldset>
  );
}
