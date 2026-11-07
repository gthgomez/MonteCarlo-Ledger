"use client";

import React, { useEffect, useState, useMemo } from "react";
import { Header } from "@/components/Header";
import { SafeSpendHero } from "@/components/SafeSpendHero";
import { TimelineChart } from "@/components/TimelineChart";
import { DecisionStudio } from "@/components/DecisionStudio";
import { LedgerManager } from "@/components/LedgerManager";
import { SyncModal } from "@/components/SyncModal";
import { LedgerState, SAMPLE_LEDGER_STATE } from "@/lib/types";
import { buildScenarioFromLedger } from "@/lib/scenario-builder";
import { runScenario, timelineRows } from "@/contract/engine";
import { parseLedgerState } from "@/lib/validate";
import { ContractError } from "@/contract/money";

const STORAGE_KEY = "montecarlo_ledger_state_v2";

// Date-only "today" in the user's local timezone. toISOString() would silently use the
// UTC date, which can differ from the user's calendar day (and shift every forecast).
function localDateIso(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

export type SimulatePurchaseResult =
  | { status: "ok"; safeSpendCents: number; overdraftPpm: number; minBalP10Cents: number }
  | { status: "error"; code: string };

export type SimulateDelayResult =
  | { status: "ok"; overdraftPpm: number; minBalP10Cents: number }
  | { status: "error"; code: string };

export default function Home() {
  // `usingDemo` is true only for a genuine first run or an explicit reset. Stored
  // personal data is never silently replaced by plausible-looking sample numbers.
  const [state, setState] = useState<LedgerState>(SAMPLE_LEDGER_STATE);
  const [usingDemo, setUsingDemo] = useState(false);
  const [storageError, setStorageError] = useState<string | null>(null);
  const [storedRaw, setStoredRaw] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);
  const [currentVaultId, setCurrentVaultId] = useState<string | undefined>();

  // Load from local storage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        setStoredRaw(saved);
        let parsed: unknown;
        try {
          parsed = JSON.parse(saved);
        } catch {
          setStorageError(
            "The saved ledger is not valid JSON. Your raw data is preserved on this device."
          );
          setStoredRaw(saved);
          setIsLoaded(true);
          return;
        }
        const validated = parseLedgerState(parsed);
        if (!validated.ok) {
          setStorageError(
            `The saved ledger could not be loaded (${validated.error}). Your raw data is preserved on this device.`
          );
          setIsLoaded(true);
          return;
        }
        setState(validated.state);
        setUsingDemo(false);
      } else {
        // First run: an explicit, clearly-labelled demonstration ledger.
        setUsingDemo(true);
      }
      const savedVault = localStorage.getItem("montecarlo_vault_id");
      if (savedVault) {
        setCurrentVaultId(savedVault);
      }
    } catch (err: any) {
      setStorageError(
        `Local storage is unavailable (${err?.message ?? "unknown error"}). Changes cannot be persisted safely.`
      );
    }
    setIsLoaded(true);
  }, []);

  // Persist to local storage
  const handleUpdateState = (nextState: LedgerState) => {
    setState(nextState);
    setUsingDemo(false);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
      setStorageError(null);
    } catch (err: any) {
      setStorageError(
        `Could not save your ledger to local storage (${err?.message ?? "quota or browser restriction"}). The change is visible but not durable.`
      );
    }
  };

  const handleApplyState = (nextState: LedgerState, vaultId?: string) => {
    setState(nextState);
    setUsingDemo(false);
    setStorageError(null);
    if (vaultId) {
      setCurrentVaultId(vaultId);
      try {
        localStorage.setItem("montecarlo_vault_id", vaultId);
      } catch {}
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
    } catch {}
  };

  const handleResetDemo = () => {
    if (confirm("Replace this ledger with the sample demo data? Your local changes will be replaced.")) {
      setState(SAMPLE_LEDGER_STATE);
      setUsingDemo(true);
      setStorageError(null);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(SAMPLE_LEDGER_STATE));
      } catch (err: any) {
        setStorageError(`Could not save the demo ledger (${err?.message ?? "storage error"}).`);
      }
    }
  };

  const handleExportJson = () => {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(state, null, 2));
    const downloadAnchor = document.createElement("a");
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `montecarlo-ledger-${new Date().toISOString().split("T")[0]}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  };

  const asOf = useMemo(() => {
    return localDateIso();
  }, []);

  // Canonical Contract 2.0 Evaluation (100% Client-Side)
  const canonicalScenario = useMemo(() => {
    return buildScenarioFromLedger(state, asOf, 90, {
      runs: 500,
      seed: 42,
      quantile_num: 1,
      quantile_den: 10,
    });
  }, [state, asOf]);

  // Fail closed: a failed evaluation is a first-class state, never null-then-loading and
  // never zero-filled numbers. The UI must show what broke and let the user recover.
  const contractEval = useMemo(() => {
    try {
      return { status: "ok" as const, result: runScenario(canonicalScenario) };
    } catch (err) {
      const code = err instanceof ContractError ? err.code : "UNKNOWN_ERROR";
      const message = err instanceof Error ? err.message : String(err);
      console.error("Contract evaluation error:", code, message);
      return { status: "error" as const, code, message };
    }
  }, [canonicalScenario]);

  // Canonical timeline rows: ordering and running balances come from the contract
  // engine, not from a UI re-implementation with a non-total date comparator.
  const timelineEvents = useMemo(() => {
    try {
      return timelineRows(canonicalScenario);
    } catch (err) {
      console.error("Timeline expansion failed:", err);
      return [];
    }
  }, [canonicalScenario]);

  // Decision Simulator Hooks — typed results; failures are surfaced, never zero-filled.
  const handleSimulatePurchase = (amountCents: number, date: string): SimulatePurchaseResult => {
    if (!Number.isInteger(amountCents) || amountCents <= 0) {
      return { status: "error", code: "INVALID_AMOUNT" };
    }
    const cloned = JSON.parse(JSON.stringify(canonicalScenario));
    cloned.events.push({
      date,
      amount_cents: -amountCents,
      type: "expense",
      name: "Simulated Purchase",
    });
    try {
      const res = runScenario(cloned);
      return {
        status: "ok",
        safeSpendCents: res.risk.safe_to_spend_cents,
        overdraftPpm: res.risk.negative_balance_probability_ppm,
        minBalP10Cents: res.risk.minimum_balance_p10_cents,
      };
    } catch (err) {
      const code = err instanceof ContractError ? err.code : "UNKNOWN_ERROR";
      console.error("Purchase simulation failed:", code, err);
      return { status: "error", code };
    }
  };

  const handleSimulateDelay = (delayDays: number): SimulateDelayResult => {
    const cloned = JSON.parse(JSON.stringify(canonicalScenario));
    const incomes = cloned.events.filter((e: any) => e.type === "income");
    if (incomes.length > 0) {
      const [y, m, d] = incomes[0].date.split("-").map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d + delayDays));
      incomes[0].date = dt.toISOString().split("T")[0];
    }
    try {
      const res = runScenario(cloned);
      return {
        status: "ok",
        overdraftPpm: res.risk.negative_balance_probability_ppm,
        minBalP10Cents: res.risk.minimum_balance_p10_cents,
      };
    } catch (err) {
      const code = err instanceof ContractError ? err.code : "UNKNOWN_ERROR";
      console.error("Paycheck-delay simulation failed:", code, err);
      return { status: "error", code };
    }
  };

  if (!isLoaded) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-400 text-sm">
        Loading Monte Carlo Contract Engine...
      </div>
    );
  }

  if (storageError) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-950 text-slate-200 p-6">
        <div className="max-w-xl w-full rounded-2xl border border-amber-800/60 bg-amber-950/20 p-6 space-y-4">
          <h1 className="text-base font-bold text-amber-300 uppercase tracking-wider">
            Saved Ledger Not Loaded
          </h1>
          <p className="text-sm text-slate-300">{storageError}</p>
          <p className="text-xs text-slate-400">
            No forecast is shown because the stored financial data could not be validated.
            The raw data has not been deleted or replaced.
          </p>
          <div className="flex flex-wrap gap-3 pt-1">
            {storedRaw && (
              <a
                href={
                  "data:text/json;charset=utf-8," +
                  encodeURIComponent(storedRaw)
                }
                download="montecarlo-ledger-recovery.json"
                className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold"
              >
                Download raw data
              </a>
            )}
            <button
              onClick={handleResetDemo}
              className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-500 text-white text-xs font-semibold"
            >
              Replace with sample data (explicit)
            </button>
            <a
              href="/"
              className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold"
            >
              Retry
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (contractEval.status === "error") {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-slate-950 text-slate-200 p-6">
        <div className="max-w-lg w-full rounded-2xl border border-rose-800/60 bg-rose-950/30 p-6 space-y-4">
          <h1 className="text-base font-bold text-rose-300 uppercase tracking-wider">
            Calculation Failed
          </h1>
          <p className="text-sm text-slate-300">
            The financial engine could not evaluate this ledger, so no forecast, risk estimate,
            or safe-to-spend number is shown. Nothing was invented to fill its place.
          </p>
          <div className="rounded-lg bg-slate-900/60 border border-slate-800 p-3 text-xs space-y-1">
            <div>
              <span className="text-slate-500">Error code: </span>
              <code className="text-rose-300">{contractEval.code}</code>
            </div>
            <div>
              <span className="text-slate-500">Detail: </span>
              <span className="text-slate-400 break-words">{contractEval.message}</span>
            </div>
          </div>
          <p className="text-xs text-slate-400">
            This is usually caused by an edited ledger entry (a zero/negative income, a positive
            expense, or an amount outside the supported range) or an out-of-range date.
          </p>
          <div className="flex gap-3 pt-1">
            <button
              onClick={() => handleResetDemo()}
              className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-500 text-white text-xs font-semibold"
            >
              Reset to sample data
            </button>
            <a
              href="/"
              className="px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold"
            >
              Retry
            </a>
          </div>
        </div>
      </div>
    );
  }

  const contractResult = contractEval.result;
  const forecast = contractResult.forecast;
  const risk = contractResult.risk;

  return (
    <div className="min-h-screen flex flex-col bg-slate-950">
      <Header
        isSynced={!!currentVaultId}
        vaultId={currentVaultId}
        onOpenSync={() => setIsSyncModalOpen(true)}
        onResetDemo={handleResetDemo}
        onExportJson={handleExportJson}
      />

      <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-8 space-y-6">
        {usingDemo && (
          <div className="rounded-xl border border-sky-700/50 bg-sky-950/30 px-4 py-3 text-xs text-sky-200">
            <strong className="font-semibold">Demo data — not your finances.</strong>{" "}
            This is a sample household to explore the engine. Add your own ledger below, or
            import a backup / pull a vault to replace it.
          </div>
        )}
        <SafeSpendHero
          currentBalanceCents={state.current_balance_cents}
          safeSpendCents={risk.safe_to_spend_cents}
          projectedLowCents={forecast.minimum_balance_cents}
          projectedLowDate={forecast.minimum_balance_date}
          endingBalanceCents={forecast.ending_balance_cents}
          overdraftPpm={risk.negative_balance_probability_ppm}
          firstNegativeDate={forecast.first_negative_date}
        />

        <TimelineChart
          asOf={asOf}
          startingBalanceCents={state.current_balance_cents}
          events={timelineEvents}
        />

        <DecisionStudio
          asOf={asOf}
          baseSafeSpendCents={risk.safe_to_spend_cents}
          baseOverdraftPpm={risk.negative_balance_probability_ppm}
          baseMinBalP10Cents={risk.minimum_balance_p10_cents}
          liabilities={state.liabilities}
          onSimulatePurchase={handleSimulatePurchase}
          onSimulateDelay={handleSimulateDelay}
        />

        <LedgerManager state={state} onUpdateState={handleUpdateState} />
      </main>

      <footer className="border-t border-slate-800/80 py-6 text-center text-xs text-slate-500">
        <p>
          MonteCarlo Ledger &bull; Free, Zero-Knowledge Personal Finance &bull; Contract 2.0 Conformance Engine
        </p>
      </footer>

      <SyncModal
        isOpen={isSyncModalOpen}
        onClose={() => setIsSyncModalOpen(false)}
        currentState={state}
        onApplyState={handleApplyState}
        currentVaultId={currentVaultId}
      />
    </div>
  );
}
