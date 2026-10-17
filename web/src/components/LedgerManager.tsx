"use client";

import React, { useState } from "react";
import { formatMoney } from "./SafeSpendHero";
import { Plus, Check, DollarSign, Calendar, Trash2 } from "lucide-react";
import { LedgerState, IncomeItem, PaymentItem } from "@/lib/types";

interface LedgerManagerProps {
  state: LedgerState;
  onUpdateState: (nextState: LedgerState) => void;
}

export function LedgerManager({ state, onUpdateState }: LedgerManagerProps) {
  const [activeTab, setActiveTab] = useState<"bills" | "incomes" | "reconcile">("bills");

  // New Bill Form State
  const [newBillName, setNewBillName] = useState("");
  const [newBillAmount, setNewBillAmount] = useState(100);
  const [newBillDueDay, setNewBillDueDay] = useState(15);

  // New Income Form State
  const [newIncomeName, setNewIncomeName] = useState("");
  const [newIncomeAmount, setNewIncomeAmount] = useState(2000);
  const [newIncomeFreq, setNewIncomeFreq] = useState<"Weekly" | "Bi-weekly" | "Monthly">("Bi-weekly");
  const [newIncomeNext, setNewIncomeNext] = useState(new Date().toISOString().split("T")[0]);

  // Reconcile State
  const [reconcileBalance, setReconcileBalance] = useState(state.current_balance_cents / 100);

  const handleAddBill = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBillName.trim()) return;

    const newPmt: PaymentItem = {
      id: `pmt-${Date.now()}`,
      name: newBillName.trim(),
      amount_cents: Math.round(newBillAmount * 100),
      due_day: newBillDueDay,
      recurrence: "Monthly",
      is_auto_withdraw: true,
    };

    onUpdateState({
      ...state,
      updated_at: new Date().toISOString(),
      payments: [...state.payments, newPmt],
    });

    setNewBillName("");
    setNewBillAmount(100);
  };

  const handleDeleteBill = (id?: number | string) => {
    onUpdateState({
      ...state,
      updated_at: new Date().toISOString(),
      payments: state.payments.filter((p) => p.id !== id),
    });
  };

  const handleAddIncome = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newIncomeName.trim()) return;

    const newInc: IncomeItem = {
      id: `inc-${Date.now()}`,
      name: newIncomeName.trim(),
      amount_cents: Math.round(newIncomeAmount * 100),
      frequency: newIncomeFreq,
      last_payday: newIncomeNext,
      next_payday: newIncomeNext,
    };

    onUpdateState({
      ...state,
      updated_at: new Date().toISOString(),
      incomes: [...state.incomes, newInc],
    });

    setNewIncomeName("");
    setNewIncomeAmount(2000);
  };

  const handleDeleteIncome = (id?: number | string) => {
    onUpdateState({
      ...state,
      updated_at: new Date().toISOString(),
      incomes: state.incomes.filter((i) => i.id !== id),
    });
  };

  const handleReconcile = (e: React.FormEvent) => {
    e.preventDefault();
    const newBalCents = Math.round(reconcileBalance * 100);
    const diff = newBalCents - state.current_balance_cents;

    const adjustmentTx = {
      id: `tx-adj-${Date.now()}`,
      amount_cents: diff,
      category: "Adjustment",
      type: "Adjustment" as const,
      date: new Date().toISOString().split("T")[0],
      description: "Balance Reconciliation Adjustment",
    };

    onUpdateState({
      ...state,
      current_balance_cents: newBalCents,
      updated_at: new Date().toISOString(),
      transactions: [...state.transactions, adjustmentTx],
    });
  };

  return (
    <div className="rounded-2xl bg-slate-900/50 border border-slate-800/80 p-5">
      <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-4 flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-bold text-slate-100 uppercase tracking-wider">
            Ledger Persistence & Obligations
          </h2>
          <p className="text-xs text-slate-400">
            Manage your authoritative bills, recurring payroll schedules, and cash balance
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-800/80 border border-slate-700/60 text-xs">
          <button
            onClick={() => setActiveTab("bills")}
            className={`px-3 py-1.5 rounded-lg font-medium transition ${
              activeTab === "bills"
                ? "bg-cyan-600 text-white shadow"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            Recurring Bills ({state.payments.length})
          </button>
          <button
            onClick={() => setActiveTab("incomes")}
            className={`px-3 py-1.5 rounded-lg font-medium transition ${
              activeTab === "incomes"
                ? "bg-cyan-600 text-white shadow"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            Payroll Income ({state.incomes.length})
          </button>
          <button
            onClick={() => setActiveTab("reconcile")}
            className={`px-3 py-1.5 rounded-lg font-medium transition ${
              activeTab === "reconcile"
                ? "bg-cyan-600 text-white shadow"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            Reconcile Balance
          </button>
        </div>
      </div>

      {/* Tab: Bills */}
      {activeTab === "bills" && (
        <div className="space-y-4">
          <form
            onSubmit={handleAddBill}
            className="grid grid-cols-1 sm:grid-cols-4 gap-3 bg-slate-800/40 border border-slate-700/60 p-3 rounded-xl text-xs items-end"
          >
            <div className="sm:col-span-2">
              <label className="block text-slate-400 mb-1 font-medium">Bill Name</label>
              <input
                type="text"
                placeholder="e.g. Electric Bill, Rent, Netflix"
                value={newBillName}
                onChange={(e) => setNewBillName(e.target.value)}
                className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-100 focus:outline-none focus:border-cyan-500"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1 font-medium">Amount ($)</label>
              <input
                type="number"
                min="1"
                step="any"
                value={newBillAmount}
                onChange={(e) => setNewBillAmount(Number(e.target.value))}
                className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-100 focus:outline-none focus:border-cyan-500"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1 font-medium">Due Day (1-31)</label>
              <input
                type="number"
                min="1"
                max="31"
                value={newBillDueDay}
                onChange={(e) => setNewBillDueDay(Number(e.target.value))}
                className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-100 focus:outline-none focus:border-cyan-500"
              />
            </div>
            <button
              type="submit"
              className="sm:col-span-4 flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white font-semibold transition"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Recurring Bill</span>
            </button>
          </form>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {state.payments.map((pmt) => (
              <div
                key={pmt.id}
                className="flex items-center justify-between p-3 rounded-xl bg-slate-800/30 border border-slate-800 text-xs hover:border-slate-700 transition"
              >
                <div>
                  <div className="font-semibold text-slate-200">{pmt.name}</div>
                  <div className="text-slate-400">
                    {pmt.recurrence} • Due day {pmt.due_day ?? pmt.due_date}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-bold text-rose-400">
                    {formatMoney(pmt.amount_cents)}
                  </span>
                  <button
                    onClick={() => handleDeleteBill(pmt.id)}
                    className="p-1 rounded hover:bg-rose-500/20 text-slate-500 hover:text-rose-400 transition"
                    title="Delete bill"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tab: Incomes */}
      {activeTab === "incomes" && (
        <div className="space-y-4">
          <form
            onSubmit={handleAddIncome}
            className="grid grid-cols-1 sm:grid-cols-4 gap-3 bg-slate-800/40 border border-slate-700/60 p-3 rounded-xl text-xs items-end"
          >
            <div>
              <label className="block text-slate-400 mb-1 font-medium">Income Source</label>
              <input
                type="text"
                placeholder="e.g. Primary Job, Side Gig"
                value={newIncomeName}
                onChange={(e) => setNewIncomeName(e.target.value)}
                className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-100 focus:outline-none focus:border-cyan-500"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1 font-medium">Take-Home Amount ($)</label>
              <input
                type="number"
                min="1"
                step="any"
                value={newIncomeAmount}
                onChange={(e) => setNewIncomeAmount(Number(e.target.value))}
                className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-100 focus:outline-none focus:border-cyan-500"
              />
            </div>
            <div>
              <label className="block text-slate-400 mb-1 font-medium">Frequency</label>
              <select
                value={newIncomeFreq}
                onChange={(e: any) => setNewIncomeFreq(e.target.value)}
                className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-100 focus:outline-none focus:border-cyan-500"
              >
                <option value="Weekly">Weekly</option>
                <option value="Bi-weekly">Bi-weekly</option>
                <option value="Monthly">Monthly</option>
              </select>
            </div>
            <div>
              <label className="block text-slate-400 mb-1 font-medium">Next Payday</label>
              <input
                type="date"
                value={newIncomeNext}
                onChange={(e) => setNewIncomeNext(e.target.value)}
                className="w-full px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-100 focus:outline-none focus:border-cyan-500"
              />
            </div>
            <button
              type="submit"
              className="sm:col-span-4 flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-semibold transition"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Income Source</span>
            </button>
          </form>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {state.incomes.map((inc) => (
              <div
                key={inc.id}
                className="flex items-center justify-between p-3 rounded-xl bg-slate-800/30 border border-slate-800 text-xs hover:border-slate-700 transition"
              >
                <div>
                  <div className="font-semibold text-slate-200">{inc.name}</div>
                  <div className="text-slate-400">
                    {inc.frequency} • Next: {inc.next_payday}
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-bold text-emerald-400">
                    +{formatMoney(inc.amount_cents)}
                  </span>
                  <button
                    onClick={() => handleDeleteIncome(inc.id)}
                    className="p-1 rounded hover:bg-rose-500/20 text-slate-500 hover:text-rose-400 transition"
                    title="Delete income"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tab: Reconcile */}
      {activeTab === "reconcile" && (
        <form onSubmit={handleReconcile} className="max-w-md space-y-4 text-xs">
          <div>
            <label className="block text-slate-300 font-semibold mb-1">
              Actual Current Bank Balance ($)
            </label>
            <p className="text-slate-400 mb-2">
              If your bank account balance differs from your ledger, enter your current verified
              balance. An audit adjustment transaction will be appended to maintain ledger reconciliation.
            </p>
            <input
              type="number"
              step="any"
              value={reconcileBalance}
              onChange={(e) => setReconcileBalance(Number(e.target.value))}
              className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-100 text-sm focus:outline-none focus:border-cyan-500"
            />
          </div>

          <button
            type="submit"
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold transition"
          >
            <Check className="w-4 h-4" />
            <span>Reconcile Ledger</span>
          </button>
        </form>
      )}
    </div>
  );
}
