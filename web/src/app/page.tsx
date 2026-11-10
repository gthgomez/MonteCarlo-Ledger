"use client";

import React, { useEffect, useMemo, useState } from "react";
import { AdvancedView } from "@/components/AdvancedView";
import { BillsView } from "@/components/BillsView";
import { BudgetView } from "@/components/BudgetView";
import { FutureView } from "@/components/FutureView";
import { Header } from "@/components/Header";
import { HomeView } from "@/components/HomeView";
import { MoneyView } from "@/components/MoneyView";
import { PlanView } from "@/components/PlanView";
import { SyncModal } from "@/components/SyncModal";
import { Notice } from "@/components/ui";
import { DEFAULT_ASSUMPTIONS, type Assumptions } from "@/lib/assumptions";
import { EMPTY_TARGETS, loadBudgetTargets, saveBudgetTargets, type BudgetTargets } from "@/lib/budget-targets";
import { localDateIso } from "@/lib/dates";
import { createStarterLedger, type EditResult } from "@/lib/ledger-edits";
import { applyLedgerBundle, LEDGER_STORAGE_KEY } from "@/lib/persistence";
import {
  buildInsights,
  categoryOverages,
  describePosition,
  slicePlan,
  spendingDeltaNote,
  spendingLastMonth,
  spendingThisMonth,
  transactionSumCents,
} from "@/lib/present";
import { evaluateLedger } from "@/lib/scenarios";
import { SECTION_QUESTION, sectionFromHash, type Section } from "@/lib/sections";
import { PersistenceResult, VAULT_ID_STORAGE_KEY } from "@/lib/sync-state";
import { SAMPLE_LEDGER_STATE, type LedgerState } from "@/lib/types";
import { computeOverdueObligations } from "@/lib/overdue";
import { parseLedgerState } from "@/lib/validate";

const THEME_KEY = "mc-theme";

export default function Home() {
  const [state, setState] = useState<LedgerState>(SAMPLE_LEDGER_STATE);
  const [usingDemo, setUsingDemo] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
  const [storedRaw, setStoredRaw] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);
  const [currentVaultId, setCurrentVaultId] = useState<string | undefined>();
  const [section, setSection] = useState<Section>("home");
  const [assumptions, setAssumptions] = useState<Assumptions>(DEFAULT_ASSUMPTIONS);
  const [targets, setTargets] = useState<BudgetTargets>(EMPTY_TARGETS);
  const [targetWarning, setTargetWarning] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(LEDGER_STORAGE_KEY);
      if (saved) {
        setStoredRaw(saved);
        let parsed: unknown;
        try {
          parsed = JSON.parse(saved);
        } catch {
          setLoadError("The saved ledger is not valid JSON. Your raw data is preserved on this device.");
          setIsLoaded(true);
          return;
        }
        const validated = parseLedgerState(parsed);
        if (!validated.ok) {
          setLoadError(
            `The saved ledger could not be loaded (${validated.error}). Your raw data is preserved on this device.`
          );
          setIsLoaded(true);
          return;
        }
        setState(validated.state);
        setUsingDemo(false);
      } else {
        setUsingDemo(true);
      }
      const savedVault = localStorage.getItem(VAULT_ID_STORAGE_KEY);
      if (savedVault) setCurrentVaultId(savedVault);
      const budget = loadBudgetTargets(localStorage);
      setTargets(budget.targets);
      setTargetWarning(budget.warning);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "unknown error";
      setLoadError(`Local storage is unavailable (${message}). Changes cannot be persisted safely.`);
    }
    const storedTheme = document.documentElement.getAttribute("data-theme");
    setTheme(storedTheme === "dark" ? "dark" : "light");
    const fromHash = sectionFromHash(window.location.hash);
    if (fromHash) setSection(fromHash);
    setIsLoaded(true);
  }, []);

  const asOf = useMemo(() => localDateIso(), []);

  const evaluation = useMemo(() => evaluateLedger(state, asOf, assumptions), [state, asOf, assumptions]);

  function navigate(next: Section) {
    setSection(next);
    const url = `${window.location.pathname}${window.location.search}#${next}`;
    window.history.replaceState(null, "", url);
  }

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      // Theme preference is cosmetic. A storage failure does not change the ledger.
    }
    setTheme(next);
  }

  function handleUpdateState(nextState: LedgerState) {
    setState(nextState);
    setUsingDemo(false);
    try {
      localStorage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(nextState));
      setSaveWarning(null);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "quota or browser restriction";
      setSaveWarning(
        `Could not save your ledger to local storage (${message}). The change is visible but not durable.`
      );
    }
  }

  function handleApplyState(nextState: LedgerState, vaultId?: string, syncRevision?: number): PersistenceResult {
    const saved = applyLedgerBundle(nextState, vaultId, syncRevision);
    if (!saved.ok) {
      setSaveWarning(saved.error);
      return saved;
    }
    setState(nextState);
    setUsingDemo(false);
    setSaveWarning(null);
    if (vaultId) setCurrentVaultId(vaultId);
    return { ok: true };
  }

  function handleResetDemo() {
    if (!confirm("Replace this ledger with the sample demo data? Your local changes will be replaced.")) return;
    setState(SAMPLE_LEDGER_STATE);
    setUsingDemo(true);
    setLoadError(null);
    setSaveWarning(null);
    try {
      localStorage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(SAMPLE_LEDGER_STATE));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "storage error";
      setSaveWarning(`Could not save the demo ledger (${message}).`);
    }
  }

  function handleExportJson() {
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(state, null, 2));
    const downloadAnchor = document.createElement("a");
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `montecarlo-ledger-${asOf}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  }

  function onEdit(result: EditResult) {
    if (result.ok) handleUpdateState(result.state);
  }

  function saveTargets(next: BudgetTargets): string | null {
    const saved = saveBudgetTargets(localStorage, next);
    if (!saved.ok) return saved.error;
    setTargets(next);
    setTargetWarning(null);
    return null;
  }

  if (!isLoaded) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas text-sm text-muted">
        Loading your finances…
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas p-6 text-ink">
        <div className="w-full max-w-xl space-y-4 rounded-2xl border border-warning bg-warning-soft p-6">
          <h1 className="text-lg font-semibold">Saved Ledger Not Loaded</h1>
          <p className="text-sm">{loadError}</p>
          <p className="text-sm text-muted">
            No forecast is shown because the stored financial data could not be validated. The raw data has not been
            deleted or replaced.
          </p>
          <div className="flex flex-wrap gap-3">
            {storedRaw && (
              <a
                href={"data:text/json;charset=utf-8," + encodeURIComponent(storedRaw)}
                download="montecarlo-ledger-recovery.json"
                className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-3 text-sm font-semibold"
              >
                Download raw data
              </a>
            )}
            <button
              type="button"
              onClick={handleResetDemo}
              className="inline-flex min-h-11 items-center rounded-lg bg-accent px-3 text-sm font-semibold text-on-accent"
            >
              Replace with sample data (explicit)
            </button>
            <a href="/" className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-3 text-sm font-semibold">
              Retry
            </a>
          </div>
        </div>
      </div>
    );
  }

  if (evaluation.status === "error") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas p-6 text-ink">
        <div className="w-full max-w-xl space-y-4 rounded-2xl border border-danger bg-danger-soft p-6">
          <h1 className="text-lg font-semibold">Calculation Failed</h1>
          <p className="text-sm">
            The financial engine could not evaluate this ledger, so no forecast, risk estimate, or safe-to-spend
            number is shown. Nothing was invented to fill its place.
          </p>
          <div className="rounded-lg border border-line bg-surface p-3 text-sm">
            <p>
              <span className="text-muted">Error code: </span>
              <code>{evaluation.code}</code>
            </p>
            <p className="mt-1 break-words">
              <span className="text-muted">Detail: </span>
              {evaluation.message}
            </p>
          </div>
          <p className="text-sm text-muted">
            This is usually caused by an edited ledger entry or an amount outside the supported range.
          </p>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={handleResetDemo}
              className="inline-flex min-h-11 items-center rounded-lg bg-accent px-3 text-sm font-semibold text-on-accent"
            >
              Reset to sample data
            </button>
            <a href="/" className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-3 text-sm font-semibold">
              Retry
            </a>
          </div>
        </div>
      </div>
    );
  }

  const outcome = evaluation.outcome;
  const rows = evaluation.rows;
  const slice = slicePlan(rows, asOf, 30, outcome.startingBalanceCents);
  const sum = transactionSumCents(state.transactions);
  const currentSpend = spendingThisMonth(state.transactions, asOf);
  const previousSpend = spendingLastMonth(state.transactions, asOf);
  const overdue = computeOverdueObligations(state, asOf);
  const nextBill = rows.find((row) => row.amount_cents < 0) ?? null;
  const copy = describePosition({
    recordedBalanceCents: state.current_balance_cents,
    scheduledIncomeCents: slice.scheduledIncomeCents,
    scheduledBillCents: slice.scheduledOutflowCents,
    plannedEndingCents: slice.plannedEndingCents,
    windowDays: 30,
    safeSpendCents: outcome.safeSpendCents,
    difficultLowCents: outcome.minimumBalanceP10Cents,
    reserveCents: outcome.reserveCents,
    quantileNum: outcome.quantileNum,
    quantileDen: outcome.quantileDen,
    runs: outcome.runs,
    isDemo: usingDemo,
    hasSchedule: rows.length > 0,
  });
  const spendingNote =
    currentSpend.totalCents === 0 && previousSpend.totalCents === 0
      ? state.transactions.some((tx) => tx.type === "Expense")
        ? null
        : "No spending is recorded, so the budget cannot show where money went."
      : spendingDeltaNote(currentSpend.totalCents, previousSpend.totalCents);
  const insights = buildInsights({
    asOf,
    isDemo: usingDemo,
    incomeCount: state.incomes.length,
    paymentCount: state.payments.length,
    overdueCount: overdue.count,
    overdueCents: overdue.total_cents,
    overdueEarliest: overdue.earliest_date,
    firstNegativeDate: outcome.firstNegativeDate,
    nextBill,
    spendingNote,
    overage: categoryOverages(currentSpend.byCategory, targets.categories)[0] ?? null,
    safeSpendCents: outcome.safeSpendCents,
    overdraftPpm: outcome.overdraftPpm,
    runs: outcome.runs,
    ledgerMatches: sum === state.current_balance_cents,
  });
  const assumptionsChanged = JSON.stringify(assumptions) !== JSON.stringify(DEFAULT_ASSUMPTIONS);
  const needsSetup = state.incomes.length === 0 && state.payments.length === 0;

  return (
    <div className="flex min-h-screen min-w-0 flex-col bg-canvas text-ink">
      <a href="#content" className="skip-link">
        Skip to content
      </a>
      <Header
        theme={theme}
        onToggleTheme={toggleTheme}
        isSynced={!!currentVaultId}
        vaultId={currentVaultId}
        onOpenSync={() => setIsSyncModalOpen(true)}
        onResetDemo={handleResetDemo}
        onExportJson={handleExportJson}
        section={section}
        onNavigate={navigate}
      />
      <main id="content" className="mx-auto w-full min-w-0 max-w-5xl flex-1 space-y-4 px-4 py-6">
        <p className="text-sm text-muted">{SECTION_QUESTION[section]}</p>
        {saveWarning && <Notice tone="warning" title="Not saved">{saveWarning}</Notice>}
        {section === "home" && (
          <HomeView
            asOf={asOf}
            usingDemo={usingDemo}
            needsSetup={needsSetup}
            copy={copy}
            recordedBalanceCents={state.current_balance_cents}
            safeSpendCents={outcome.safeSpendCents}
            plannedLowCents={outcome.projectedLowCents}
            plannedLowDate={outcome.projectedLowDate}
            slice={slice}
            insights={insights}
            assumptionsChanged={assumptionsChanged}
            horizonDays={assumptions.horizonDays}
            runs={outcome.runs}
            onNavigate={navigate}
            createOwn={(input) => {
              const created = createStarterLedger(input);
              if (!created.ok) return created;
              handleUpdateState(created.state);
              return { ok: true };
            }}
          />
        )}
        {section === "money" && (
          <MoneyView state={state} asOf={asOf} startingBalanceCents={outcome.startingBalanceCents} onEdit={onEdit} />
        )}
        {section === "budget" && (
          <BudgetView
            current={currentSpend}
            previous={previousSpend}
            payments={state.payments}
            targets={targets}
            warning={targetWarning}
            onSave={saveTargets}
          />
        )}
        {section === "bills" && (
          <BillsView
            state={state}
            asOf={asOf}
            slice={slicePlan(rows, asOf, assumptions.horizonDays, outcome.startingBalanceCents)}
            horizonDays={assumptions.horizonDays}
            assumptions={assumptions}
            overdue={overdue}
            onEdit={onEdit}
          />
        )}
        {section === "plan" && (
          <PlanView state={state} asOf={asOf} assumptions={assumptions} base={outcome} onEdit={onEdit} />
        )}
        {section === "future" && (
          <FutureView asOf={asOf} outcome={outcome} rows={rows} assumptionsChanged={assumptionsChanged} />
        )}
        {section === "advanced" && (
          <AdvancedView assumptions={assumptions} outcome={outcome} asOf={asOf} onApply={setAssumptions} />
        )}
      </main>
      <footer className="border-t border-line px-4 py-6 text-center text-sm text-muted">
        <p>MonteCarlo keeps this plan in your browser. Sync is optional. Forecasts are estimates, not guarantees.</p>
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
