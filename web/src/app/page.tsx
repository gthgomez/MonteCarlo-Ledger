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
import { runScenario } from "@/contract/engine";

const STORAGE_KEY = "montecarlo_ledger_state_v2";

export default function Home() {
  const [state, setState] = useState<LedgerState>(SAMPLE_LEDGER_STATE);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);
  const [currentVaultId, setCurrentVaultId] = useState<string | undefined>();

  // Load from local storage
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        setState(JSON.parse(saved));
      }
      const savedVault = localStorage.getItem("montecarlo_vault_id");
      if (savedVault) {
        setCurrentVaultId(savedVault);
      }
    } catch {
      // fallback to sample state
    }
    setIsLoaded(true);
  }, []);

  // Persist to local storage
  const handleUpdateState = (nextState: LedgerState) => {
    setState(nextState);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextState));
    } catch {}
  };

  const handleApplyState = (nextState: LedgerState, vaultId?: string) => {
    setState(nextState);
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
    if (confirm("Reset ledger to sample demo data? Your local changes will be replaced.")) {
      setState(SAMPLE_LEDGER_STATE);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(SAMPLE_LEDGER_STATE));
      } catch {}
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
    return new Date().toISOString().split("T")[0];
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

  const contractResult = useMemo(() => {
    try {
      return runScenario(canonicalScenario);
    } catch (err) {
      console.error("Contract evaluation error:", err);
      return null;
    }
  }, [canonicalScenario]);

  // Event sequence for timeline chart
  const timelineEvents = useMemo(() => {
    if (!canonicalScenario || !canonicalScenario.events) return [];
    let running = state.current_balance_cents;
    const sorted = [...canonicalScenario.events].sort((a: any, b: any) => (a.date < b.date ? -1 : 1));

    return sorted.map((ev: any) => {
      running += ev.amount_cents;
      return {
        date: ev.date,
        name: ev.name,
        type: ev.type,
        amount_cents: ev.amount_cents,
        balance_after_cents: running,
      };
    });
  }, [canonicalScenario, state.current_balance_cents]);

  // Decision Simulator Hooks
  const handleSimulatePurchase = (amountCents: number, date: string) => {
    const cloned = JSON.parse(JSON.stringify(canonicalScenario));
    cloned.events.push({
      date,
      amount_cents: -Math.abs(amountCents),
      type: "expense",
      name: "Simulated Purchase",
    });
    try {
      const res = runScenario(cloned);
      return {
        safeSpendCents: res.risk.safe_to_spend_cents,
        overdraftPpm: res.risk.negative_balance_probability_ppm,
        minBalP10Cents: res.risk.minimum_balance_p10_cents,
      };
    } catch {
      return {
        safeSpendCents: 0,
        overdraftPpm: 0,
        minBalP10Cents: 0,
      };
    }
  };

  const handleSimulateDelay = (delayDays: number) => {
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
        overdraftPpm: res.risk.negative_balance_probability_ppm,
        minBalP10Cents: res.risk.minimum_balance_p10_cents,
      };
    } catch {
      return {
        overdraftPpm: 0,
        minBalP10Cents: 0,
      };
    }
  };

  if (!isLoaded || !contractResult) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-400 text-sm">
        Loading Monte Carlo Contract Engine...
      </div>
    );
  }

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
