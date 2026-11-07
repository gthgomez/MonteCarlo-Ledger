"use client";

import React, { useState } from "react";
import { formatMoney } from "./SafeSpendHero";
import { ShoppingBag, Clock, Percent, ArrowRight, CheckCircle2 } from "lucide-react";
import { amortize } from "@/contract/debt";

interface DecisionStudioProps {
  asOf: string;
  baseSafeSpendCents: number;
  baseOverdraftPpm: number;
  baseMinBalP10Cents: number;
  liabilities: any[];
  onSimulatePurchase: (
    amountCents: number,
    date: string
  ) =>
    | { status: "ok"; safeSpendCents: number; overdraftPpm: number; minBalP10Cents: number }
    | { status: "error"; code: string };
  onSimulateDelay: (
    delayDays: number
  ) =>
    | { status: "ok"; overdraftPpm: number; minBalP10Cents: number }
    | { status: "error"; code: string };
}

function SimulationError({ code }: { code: string }) {
  return (
    <div className="rounded-xl border border-rose-800/60 bg-rose-950/30 p-4 space-y-2">
      <div className="text-xs font-bold text-rose-300 uppercase tracking-wider">
        Calculation Failed
      </div>
      <p className="text-xs text-slate-300">
        The engine could not complete this simulation
        (<code className="text-rose-300">{code}</code>), so no numbers are shown for it. Nothing
        is presented rather than a wrong zero &mdash; adjust the input or fix the ledger and try
        again.
      </p>
    </div>
  );
}

export function DecisionStudio({
  asOf,
  baseSafeSpendCents,
  baseOverdraftPpm,
  baseMinBalP10Cents,
  liabilities,
  onSimulatePurchase,
  onSimulateDelay,
}: DecisionStudioProps) {
  const [activeTab, setActiveTab] = useState<"purchase" | "delay" | "debt">("purchase");

  // Purchase Simulation State
  const [purchaseAmount, setPurchaseAmount] = useState<number>(350);
  const [purchaseDate, setPurchaseDate] = useState<string>(asOf);

  // Paycheck Delay State
  const [delayDays, setDelayDays] = useState<number>(3);

  // Debt Strategy State
  const [debtStrategy, setDebtStrategy] = useState<"snowball" | "avalanche">("snowball");
  const [extraPayment, setExtraPayment] = useState<number>(100);

  // Computed Purchase Outcome
  const purchaseResult = onSimulatePurchase(purchaseAmount * 100, purchaseDate);
  const purchaseOk = purchaseResult.status === "ok" ? purchaseResult : null;
  const deltaOverdraft = purchaseOk
    ? (purchaseOk.overdraftPpm - baseOverdraftPpm) / 10000
    : 0;
  const deltaSafeSpend = purchaseOk ? purchaseOk.safeSpendCents - baseSafeSpendCents : 0;

  // Computed Delay Outcome
  const delayResult = onSimulateDelay(delayDays);
  const delayOk = delayResult.status === "ok" ? delayResult : null;
  const delayDeltaOverdraft = delayOk
    ? (delayOk.overdraftPpm - baseOverdraftPpm) / 10000
    : 0;

  // Computed Debt Amortization Outcome — failures are explicit, not an empty tab.
  let debtResult: any = null;
  let debtError: string | null = null;
  if (liabilities && liabilities.length > 0) {
    try {
      debtResult = amortize(asOf, liabilities, debtStrategy, extraPayment * 100);
    } catch (err: any) {
      debtError = err?.code ?? "UNKNOWN_ERROR";
    }
  }

  return (
    <div className="rounded-2xl bg-slate-900/50 border border-slate-800/80 p-5">
      <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-4 flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-bold text-slate-100 uppercase tracking-wider">
            Interactive What-If Decision Studio
          </h2>
          <p className="text-xs text-slate-400">
            Stress-test financial decisions with 100% client-side instant recalculations
          </p>
        </div>

        <div className="flex items-center gap-1 p-1 rounded-xl bg-slate-800/80 border border-slate-700/60 text-xs">
          <button
            onClick={() => setActiveTab("purchase")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition ${
              activeTab === "purchase"
                ? "bg-indigo-600 text-white shadow"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <ShoppingBag className="w-3.5 h-3.5" />
            <span>Simulate Purchase</span>
          </button>
          <button
            onClick={() => setActiveTab("delay")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition ${
              activeTab === "delay"
                ? "bg-indigo-600 text-white shadow"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Clock className="w-3.5 h-3.5" />
            <span>Late Paycheck</span>
          </button>
          <button
            onClick={() => setActiveTab("debt")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-medium transition ${
              activeTab === "debt"
                ? "bg-indigo-600 text-white shadow"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            <Percent className="w-3.5 h-3.5" />
            <span>Debt Snowball vs Avalanche</span>
          </button>
        </div>
      </div>

      {/* Tab 1: Planned Purchase */}
      {activeTab === "purchase" && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-center">
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                Purchase Amount: ${purchaseAmount.toLocaleString()}
              </label>
              <input
                type="range"
                min="10"
                max="2500"
                step="10"
                value={purchaseAmount}
                onChange={(e) => setPurchaseAmount(Number(e.target.value))}
                className="w-full accent-indigo-500 cursor-pointer"
              />
              <div className="flex justify-between text-[11px] text-slate-500 mt-1">
                <span>$10</span>
                <span>$1,000</span>
                <span>$2,500</span>
              </div>

              <div className="mt-4">
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  Planned Purchase Date
                </label>
                <input
                  type="date"
                  value={purchaseDate}
                  onChange={(e) => setPurchaseDate(e.target.value)}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 border border-slate-700 text-slate-100 text-xs focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>

            <div className="rounded-xl bg-slate-800/40 border border-slate-700/60 p-4 space-y-3">
              <div className="text-xs font-bold text-slate-300 uppercase tracking-wider">
                Impact On Your Fragility Floor
              </div>

              {!purchaseOk ? (
                <SimulationError code={purchaseResult.status === "error" ? purchaseResult.code : "UNKNOWN_ERROR"} />
              ) : (
                <>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-400">Safe to Spend:</span>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400 line-through">
                        {formatMoney(baseSafeSpendCents)}
                      </span>
                      <ArrowRight className="w-3 h-3 text-slate-500" />
                      <span className="font-bold text-indigo-300">
                        {formatMoney(purchaseOk.safeSpendCents)}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-400">Overdraft Risk:</span>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400">
                        {(baseOverdraftPpm / 10000).toFixed(1)}%
                      </span>
                      <ArrowRight className="w-3 h-3 text-slate-500" />
                      <span
                        className={`font-bold ${
                          deltaOverdraft > 0 ? "text-rose-400" : "text-emerald-400"
                        }`}
                      >
                        {(purchaseOk.overdraftPpm / 10000).toFixed(1)}% (
                        {deltaOverdraft > 0 ? "+" : ""}
                        {deltaOverdraft.toFixed(1)} pp)
                      </span>
                    </div>
                  </div>

                  <p className="text-[11px] text-slate-400 pt-1 border-t border-slate-700/60">
                    {purchaseOk.safeSpendCents >= 0
                      ? "This purchase remains safely above your P10 floor without risking negative balance."
                      : "Caution: This purchase drives your conservative trough negative before the next income event."}
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Tab 2: Paycheck Delay */}
      {activeTab === "delay" && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 items-center">
            <div>
              <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                Paycheck Arrives Late by: {delayDays} {delayDays === 1 ? "day" : "days"}
              </label>
              <input
                type="range"
                min="1"
                max="14"
                step="1"
                value={delayDays}
                onChange={(e) => setDelayDays(Number(e.target.value))}
                className="w-full accent-indigo-500 cursor-pointer"
              />
              <div className="flex justify-between text-[11px] text-slate-500 mt-1">
                <span>1 day</span>
                <span>7 days</span>
                <span>14 days</span>
              </div>
            </div>

            <div className="rounded-xl bg-slate-800/40 border border-slate-700/60 p-4 space-y-3">
              <div className="text-xs font-bold text-slate-300 uppercase tracking-wider">
                Fragility Under Payroll Variance
              </div>

              {!delayOk ? (
                <SimulationError code={delayResult.status === "error" ? delayResult.code : "UNKNOWN_ERROR"} />
              ) : (
                <>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-slate-400">Overdraft Risk:</span>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400">
                        {(baseOverdraftPpm / 10000).toFixed(1)}%
                      </span>
                      <ArrowRight className="w-3 h-3 text-slate-500" />
                      <span
                        className={`font-bold ${
                          delayDeltaOverdraft > 0 ? "text-rose-400" : "text-emerald-400"
                        }`}
                      >
                        {(delayOk.overdraftPpm / 10000).toFixed(1)}% (
                        {delayDeltaOverdraft > 0 ? "+" : ""}
                        {delayDeltaOverdraft.toFixed(1)} pp)
                      </span>
                    </div>
                  </div>

                  <p className="text-[11px] text-slate-400 pt-1 border-t border-slate-700/60">
                    Tests whether scheduled auto-withdraw bills will bounce if your employer or bank
                    clears payroll late.
                  </p>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Tab 3: Debt Payoff Engine */}
      {activeTab === "debt" && (
        <div className="space-y-4">
          {!debtResult ? (
            liabilities && liabilities.length > 0 ? (
              <SimulationError code={debtError ?? "UNKNOWN_ERROR"} />
            ) : (
              <p className="text-xs text-slate-400 py-4 text-center">
                No liabilities in this ledger yet &mdash; add one under Ledger to compare payoff
                strategies.
              </p>
            )
          ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-center">
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-2">
                  Payoff Strategy
                </label>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <button
                    onClick={() => setDebtStrategy("snowball")}
                    className={`p-2 rounded-lg border font-medium text-center transition ${
                      debtStrategy === "snowball"
                        ? "bg-indigo-600/30 border-indigo-500 text-indigo-200"
                        : "bg-slate-800 border-slate-700 text-slate-400"
                    }`}
                  >
                    Snowball (Balance)
                  </button>
                  <button
                    onClick={() => setDebtStrategy("avalanche")}
                    className={`p-2 rounded-lg border font-medium text-center transition ${
                      debtStrategy === "avalanche"
                        ? "bg-indigo-600/30 border-indigo-500 text-indigo-200"
                        : "bg-slate-800 border-slate-700 text-slate-400"
                    }`}
                  >
                    Avalanche (APR)
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1">
                  Extra Monthly Payment: ${extraPayment}
                </label>
                <input
                  type="range"
                  min="0"
                  max="1000"
                  step="25"
                  value={extraPayment}
                  onChange={(e) => setExtraPayment(Number(e.target.value))}
                  className="w-full accent-indigo-500 cursor-pointer"
                />
              </div>
            </div>

            <div className="md:col-span-2 rounded-xl bg-slate-800/40 border border-slate-700/60 p-4 grid grid-cols-2 sm:grid-cols-3 gap-4 text-xs">
              <div>
                <div className="text-slate-400 mb-1">Months to Payoff</div>
                <div className="text-xl font-bold text-slate-100">
                  {debtResult.months_to_payoff} months
                </div>
                <div className="text-[11px] text-slate-500">{debtResult.payoff_date}</div>
              </div>

              <div>
                <div className="text-slate-400 mb-1">Total Interest Paid</div>
                <div className="text-xl font-bold text-indigo-300">
                  {formatMoney(debtResult.total_interest_cents)}
                </div>
                <div className="text-[11px] text-slate-500">Fixed rate amortization</div>
              </div>

              <div className="col-span-2 sm:col-span-1">
                <div className="text-slate-400 mb-1">Total Out-of-Pocket</div>
                <div className="text-xl font-bold text-slate-100">
                  {formatMoney(debtResult.total_paid_cents)}
                </div>
                <div className="text-[11px] text-emerald-400 font-medium">Principal + Interest</div>
              </div>
            </div>
          </div>
          )}
          <p className="text-[11px] text-slate-400 border-t border-slate-800 pt-3">
            Deterministic payoff schedule only. These payments are <span className="text-slate-300">not</span>{" "}
            automatically included in the cash-flow forecast or overdraft estimate &mdash; an extra
            payment that shortens the schedule is not by itself affordable. Check the Simulate
            Purchase tab (or your monthly budget) for the cash-flow impact of the higher payment.
            {debtResult.did_not_converge
              ? " Note: this schedule did not converge within the 360-month cap — the balance likely grows faster than payments."
              : ""}
          </p>
        </div>
      )}
    </div>
  );
}
