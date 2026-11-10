"use client";

import React, { useState } from "react";
import { formatDateLabel } from "@/lib/dates";
import {
  addIncomeSchedule,
  dollarsToCents,
  reconcileBalance,
  recordCashflow,
  removeIncome,
  type EditResult,
} from "@/lib/ledger-edits";
import { formatMoney } from "@/lib/money-format";
import { cashMinusEnteredDebt, enteredDebtCents, transactionSumCents } from "@/lib/present";
import { type IncomeItem, type LedgerState } from "@/lib/types";
import { Button, Explain, fieldClass, Notice, Panel } from "./ui";

export function MoneyView({
  state,
  asOf,
  startingBalanceCents,
  onEdit,
}: {
  state: LedgerState;
  asOf: string;
  startingBalanceCents: number;
  onEdit: (result: EditResult) => void;
}) {
  const [kind, setKind] = useState<"Expense" | "Income">("Expense");
  const [amount, setAmount] = useState("");
  const [category, setCategory] = useState("");
  const [description, setDescription] = useState("");
  const [date, setDate] = useState(asOf);
  const [formError, setFormError] = useState<string | null>(null);

  const [incomeName, setIncomeName] = useState("");
  const [incomeAmount, setIncomeAmount] = useState("");
  const [frequency, setFrequency] = useState<IncomeItem["frequency"]>("Bi-weekly");
  const [payday, setPayday] = useState(asOf);
  const [incomeError, setIncomeError] = useState<string | null>(null);

  const [reconcile, setReconcile] = useState((state.current_balance_cents / 100).toFixed(2));
  const [reconcileError, setReconcileError] = useState<string | null>(null);

  const sum = transactionSumCents(state.transactions);
  const matches = sum === state.current_balance_cents;
  const debt = enteredDebtCents(state.liabilities);
  const net = cashMinusEnteredDebt(state.current_balance_cents, state.liabilities);
  const futureCount = state.transactions.filter((tx) => tx.date > asOf).length;
  const reconcileCents = dollarsToCents(Number(reconcile));
  const reconcileDiff =
    reconcileCents === null ? null : reconcileCents - state.current_balance_cents;

  function submitRecord(event: React.FormEvent) {
    event.preventDefault();
    const cents = dollarsToCents(Number(amount));
    if (cents === null || cents <= 0) {
      setFormError("Enter an amount greater than zero.");
      return;
    }
    const result = recordCashflow(state, {
      date,
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
    setAmount("");
    setDescription("");
    onEdit(result);
  }

  function submitIncome(event: React.FormEvent) {
    event.preventDefault();
    const cents = dollarsToCents(Number(incomeAmount));
    if (cents === null) {
      setIncomeError("Enter the take-home amount.");
      return;
    }
    const result = addIncomeSchedule(state, {
      name: incomeName,
      amountCents: cents,
      frequency,
      nextPayday: payday,
    });
    if (!result.ok) {
      setIncomeError(result.error);
      return;
    }
    setIncomeError(null);
    setIncomeName("");
    onEdit(result);
  }

  function submitReconcile(event: React.FormEvent) {
    event.preventDefault();
    if (reconcileCents === null) {
      setReconcileError("Enter the balance you see, in dollars.");
      return;
    }
    const result = reconcileBalance(state, reconcileCents, asOf);
    if (!result.ok) {
      setReconcileError(result.error);
      return;
    }
    setReconcileError(null);
    onEdit(result);
  }

  const rows = [...state.transactions].reverse();

  return (
    <div className="space-y-6">
      <Panel
        title="What you have"
        lede="Recorded money is the sum of transactions in this ledger. Expected paychecks are a schedule, not money already received."
      >
        <p className="text-3xl font-semibold tabular-nums">{formatMoney(state.current_balance_cents)}</p>
        {matches ? (
          <p className="mt-2 text-sm text-muted">
            This matches the sum of {state.transactions.length} recorded {state.transactions.length === 1 ? "transaction" : "transactions"}.
          </p>
        ) : (
          <div className="mt-3">
            <Notice tone="danger" title="The balance and the transactions disagree">
              Recorded balance {formatMoney(state.current_balance_cents)}. Transaction sum{" "}
              {sum === null ? "could not be totaled" : formatMoney(sum)}. Fix this before relying on the plan.
            </Notice>
          </div>
        )}
        {futureCount > 0 && (
          <p className="mt-3 text-sm text-muted">
            {futureCount} transaction{futureCount === 1 ? "" : "s"} dated after today {futureCount === 1 ? "is" : "are"} not
            treated as money already in hand. The plan starts from {formatMoney(startingBalanceCents)} and applies{" "}
            {futureCount === 1 ? "it" : "them"} on {futureCount === 1 ? "that date" : "those dates"}.
          </p>
        )}
        {debt !== null && debt > 0 && net !== null && (
          <p className="mt-3 text-sm text-muted">
            Debt balances you entered total {formatMoney(debt)}. Recorded cash minus those balances is {formatMoney(net)}.
            That is not full net worth. It ignores anything you did not enter.
          </p>
        )}
        <div className="mt-4">
          <Explain term="net worth">
            Net worth is what you own minus what you owe. This screen only subtracts the debt balances stored here from
            the recorded cash balance. It is not a complete net worth.
          </Explain>
        </div>
      </Panel>

      <Panel title="Record money in or out" lede="This updates the ledger. A future date is kept as scheduled, not as money already spent.">
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
            <input className={`${fieldClass} mt-1`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </label>
          <label className="text-sm font-medium">
            Category
            <input className={`${fieldClass} mt-1`} value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Groceries" />
          </label>
          <label className="text-sm font-medium">
            Date
            <input className={`${fieldClass} mt-1`} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
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
        </form>
      </Panel>

      <Panel title="Recorded activity">
        {rows.length === 0 ? (
          <p className="text-sm text-muted">No transactions yet. Record income or spending above, or set an opening balance.</p>
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((tx) => (
              <li key={String(tx.id)} className="flex flex-wrap items-baseline justify-between gap-2 py-3 text-sm">
                <div>
                  <p className="font-medium">{tx.description || tx.category || tx.type}</p>
                  <p className="text-muted">
                    {formatDateLabel(tx.date)} · {tx.category || tx.type}
                    {tx.date > asOf ? " · Scheduled, not spent yet" : ""}
                  </p>
                </div>
                <p className="tabular-nums font-semibold">{formatMoney(tx.amount_cents)}</p>
              </li>
            ))}
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
            <input className={`${fieldClass} mt-1`} type="date" value={payday} onChange={(e) => setPayday(e.target.value)} />
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
          {state.incomes.map((income) => (
            <li key={String(income.id)} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
              <div>
                <p className="font-medium">{income.name}</p>
                <p className="text-muted">
                  {income.frequency} · next {formatDateLabel(income.next_payday)}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="tabular-nums font-semibold">{formatMoney(income.amount_cents)}</span>
                <Button type="button" variant="quiet" onClick={() => onEdit(removeIncome(state, income.id ?? ""))}>
                  Remove {income.name}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Panel>

      <Panel
        title="Match your balance"
        lede="If the cash you can actually use is different from this ledger, enter that balance. An adjustment is added so the transactions still add up. This does not contact a bank."
      >
        <form onSubmit={submitReconcile} className="max-w-md space-y-3">
          <label className="block text-sm font-medium">
            Balance you want recorded ($)
            <input className={`${fieldClass} mt-1`} inputMode="decimal" value={reconcile} onChange={(e) => setReconcile(e.target.value)} />
          </label>
          {reconcileDiff !== null && reconcileDiff !== 0 && (
            <p className="text-sm text-muted">
              This will add an adjustment of {formatMoney(reconcileDiff)} dated {formatDateLabel(asOf)}.
            </p>
          )}
          {reconcileError && (
            <p className="text-sm text-danger" role="alert">
              {reconcileError}
            </p>
          )}
          <Button type="submit">Reconcile Ledger</Button>
        </form>
      </Panel>
    </div>
  );
}
