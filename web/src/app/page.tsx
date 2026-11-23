"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
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
import {
  ASSUMPTIONS_STORAGE_KEY,
  loadAssumptions,
  parseSavedAssumptions,
  saveAssumptions,
} from "@/lib/assumptions-persistence";
import { EMPTY_TARGETS, loadBudgetTargets, saveBudgetTargets, type BudgetTargets } from "@/lib/budget-targets";
import { createStarterLedger, type EditResult } from "@/lib/ledger-edits";
import { LEDGER_STORAGE_KEY, saveLedgerChange, type LedgerChangeOptions } from "@/lib/persistence";
import {
  beyondWindowBillNotice,
  buildInsights,
  categoryOverages,
  describePosition,
  slicePlan,
  spendingDeltaNote,
  spendingGuidanceIssue,
  spendingLastMonth,
  spendingThisMonth,
  transactionSumCents,
} from "@/lib/present";
import { evaluateLedger } from "@/lib/scenarios";
import { SECTION_QUESTION, sectionFromHash, type Section } from "@/lib/sections";
import { PersistenceResult, VAULT_ID_STORAGE_KEY } from "@/lib/sync-state";
import { SAMPLE_LEDGER_STATE, type LedgerState } from "@/lib/types";
import { computeOverdueObligations } from "@/lib/overdue";
import { useFinancialDate } from "@/lib/use-financial-date";
import { parseLedgerState } from "@/lib/validate";

const THEME_KEY = "mc-theme";

/**
 * A second submission in the same tab must fail immediately instead of queuing
 * behind the first. Otherwise both edits are built from the same visible ledger,
 * the second compares against a raw snapshot that the first has already replaced,
 * and the conflict surfaces only after the form has erased the user's draft.
 */
const BUSY_SAVE_MESSAGE =
  "Another ledger change is still being saved. Wait for it to finish before trying again. Nothing was saved by this attempt.";

function warnBeforeLeavingWithLedgerSave(event: BeforeUnloadEvent) {
  event.preventDefault();
  event.returnValue = "";
}

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export default function Home() {
  const [state, setState] = useState<LedgerState>(SAMPLE_LEDGER_STATE);
  const [usingDemo, setUsingDemo] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
  const [assumptionsError, setAssumptionsError] = useState<string | null>(null);
  const [assumptionsWarning, setAssumptionsWarning] = useState<string | null>(null);
  const [assumptionsRaw, setAssumptionsRaw] = useState<string | null>(null);
  const [storedRaw, setStoredRaw] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);
  const [currentVaultId, setCurrentVaultId] = useState<string | undefined>();
  const [section, setSection] = useState<Section>("home");
  const [assumptions, setAssumptions] = useState<Assumptions>(DEFAULT_ASSUMPTIONS);
  const [targets, setTargets] = useState<BudgetTargets>(EMPTY_TARGETS);
  const [targetWarning, setTargetWarning] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const writeInFlightRef = useRef(false);

  // The listener lives only while a ledger write is actually outstanding. It is
  // removed on success, conflict, cancellation, or storage failure.
  useEffect(() => {
    return () => window.removeEventListener("beforeunload", warnBeforeLeavingWithLedgerSave);
  }, []);

  useEffect(() => {
    const savedAssumptions = loadAssumptions(browserStorage());
    if (savedAssumptions.ok) {
      setAssumptions(savedAssumptions.assumptions);
      setAssumptionsWarning(savedAssumptions.warning);
      if (savedAssumptions.migrated) {
        // Legacy records are hydrated read-only. Writing a migrated copy during startup
        // can race an explicit save in another tab and overwrite newer assumptions.
        setAssumptionsWarning("Older financial settings were loaded. Save under Advanced to update their format.");
      }
    } else {
      setAssumptionsError(savedAssumptions.error);
      setAssumptionsRaw(savedAssumptions.raw);
    }

    try {
      const saved = localStorage.getItem(LEDGER_STORAGE_KEY);
      if (saved !== null) {
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

  useEffect(() => {
    function receiveAssumptions(event: StorageEvent) {
      if (event.key !== ASSUMPTIONS_STORAGE_KEY && event.key !== null) return;
      let currentRaw: string | null = null;
      try {
        const storage = browserStorage();
        if (!storage) throw new Error("Browser storage unavailable");
        currentRaw = storage.getItem(ASSUMPTIONS_STORAGE_KEY);
      } catch {
        setAssumptionsError("Financial settings could not be read from this browser.");
        return;
      }
      // Storage events may be delivered out of order; the durable key is the source of truth,
      // not the event's historical newValue payload.
      const loaded = parseSavedAssumptions(currentRaw);
      if (!loaded.ok) {
        setAssumptionsRaw(loaded.raw);
        setAssumptionsError(loaded.error);
        setAssumptionsWarning(null);
        return;
      }
      setAssumptions(loaded.assumptions);
      setAssumptionsError(null);
      setAssumptionsRaw(null);
      if (loaded.migrated) {
        setAssumptionsWarning("Older financial settings from another tab were loaded. Save under Advanced to update their format.");
      } else if (currentRaw === null) {
        setAssumptionsWarning("Financial settings were removed in another tab. Default assumptions are now active.");
      } else {
        setAssumptionsWarning("Financial settings were updated in another tab.");
      }
    }

    window.addEventListener("storage", receiveAssumptions);
    return () => window.removeEventListener("storage", receiveAssumptions);
  }, []);

  const asOf = useFinancialDate();

  const evaluation = useMemo(() => evaluateLedger(state, asOf, assumptions), [state, asOf, assumptions]);

  function navigate(next: Section) {
    // Navigation is held until the durable result is known so a pending save
    // cannot be mistaken for an abandoned draft or hidden behind another section.
    if (writeInFlightRef.current) return;
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

  function showSavedLedger(nextState: LedgerState, demo = false) {
    setStoredRaw(JSON.stringify(nextState));
    setState(nextState);
    setUsingDemo(demo);
    setSaveWarning(null);
  }

  /**
   * The single owner for every ledger write in this tab.
   *
   * The guard is a ref rather than state so two handlers firing in the same
   * event loop turn cannot both pass it before React re-renders. The second
   * caller gets an immediate failure and keeps its draft instead of replacing
   * the first save with a snapshot built from the same stale ledger.
   */
  async function runLedgerWrite(
    operation: () => Promise<PersistenceResult>
  ): Promise<PersistenceResult> {
    if (writeInFlightRef.current) {
      return { ok: false, error: BUSY_SAVE_MESSAGE };
    }
    writeInFlightRef.current = true;
    setIsSaving(true);
    window.addEventListener("beforeunload", warnBeforeLeavingWithLedgerSave);
    try {
      return await operation();
    } finally {
      window.removeEventListener("beforeunload", warnBeforeLeavingWithLedgerSave);
      writeInFlightRef.current = false;
      setIsSaving(false);
    }
  }

  async function handleUpdateState(nextState: LedgerState): Promise<PersistenceResult> {
    const saved = await runLedgerWrite(async () => {
      setSaveWarning(null);
      const result = await saveLedgerChange(nextState, { expectedRaw: storedRaw });
      if (result.ok) showSavedLedger(nextState);
      return result;
    });
    if (!saved.ok) setSaveWarning(`${saved.error} If you entered values, keep a copy before reloading.`);
    return saved;
  }

  async function handleApplyState(nextState: LedgerState, options: LedgerChangeOptions): Promise<PersistenceResult> {
    return runLedgerWrite(async () => {
      const saved = await saveLedgerChange(nextState, { ...options, requireLock: true });
      if (saved.ok) {
        showSavedLedger(nextState);
        if (options.vaultId) setCurrentVaultId(options.vaultId);
      }
      return saved;
    });
  }

  function handleApplyAssumptions(nextAssumptions: Assumptions): string | null {
    const saved = saveAssumptions(browserStorage(), nextAssumptions);
    if (!saved.ok) {
      setAssumptionsWarning(saved.error);
      return saved.error;
    }
    setAssumptions(nextAssumptions);
    setAssumptionsError(null);
    setAssumptionsWarning(null);
    setAssumptionsRaw(null);
    return null;
  }

  async function handleResetDemo() {
    if (writeInFlightRef.current) {
      setSaveWarning(BUSY_SAVE_MESSAGE);
      return;
    }
    if (!confirm("Replace this ledger with the sample demo data? Your local changes will be replaced.")) return;
    const saved = await runLedgerWrite(async () => {
      const result = await saveLedgerChange(SAMPLE_LEDGER_STATE, { expectedRaw: storedRaw, requireLock: true });
      if (!result.ok) setSaveWarning(result.error);
      return result;
    });
    if (!saved.ok) return;
    showSavedLedger(SAMPLE_LEDGER_STATE, true);
    setLoadError(null);
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

  async function onEdit(result: EditResult): Promise<PersistenceResult> {
    if (!result.ok) {
      setSaveWarning(result.error);
      return { ok: false, error: result.error };
    }
    return handleUpdateState(result.state);
  }

  function openSync() {
    if (writeInFlightRef.current) return;
    setIsSyncModalOpen(true);
  }

  function saveTargets(next: BudgetTargets): string | null {
    const saved = saveBudgetTargets(localStorage, next);
    if (!saved.ok) return saved.error;
    setTargets(next);
    setTargetWarning(null);
    return null;
  }

  // Keep the live region mounted so assistive technology announces the pending
  // message when it appears, rather than treating a new region as first render.
  const savingNotice = (
    <div role="status" aria-live="polite" className={isSaving ? undefined : "sr-only"}>
      {isSaving && (
        <Notice tone="info" title="Saving your ledger change">
          Keep this tab open until the browser confirms the change is stored. Your draft stays in the form until then.
        </Notice>
      )}
    </div>
  );

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
          {savingNotice}
          {saveWarning && <Notice tone="warning" title="Not saved">{saveWarning}</Notice>}
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

  if (assumptionsError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas p-6 text-ink">
        <div className="w-full max-w-xl space-y-4 rounded-2xl border border-warning bg-warning-soft p-6">
          <h1 className="text-lg font-semibold">Financial Settings Not Loaded</h1>
          <p className="text-sm">{assumptionsError}</p>
          <p className="text-sm text-muted">
            Your ledger is still saved on this device. No forecast is shown until the settings are repaired or you
            choose the defaults. Choosing defaults will not replace your ledger.
          </p>
          {savingNotice}
          {assumptionsRaw && (
            <a
              href={"data:text/json;charset=utf-8," + encodeURIComponent(assumptionsRaw)}
              download="montecarlo-financial-settings-recovery.json"
              className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-3 text-sm font-semibold"
            >
              Download saved settings
            </a>
          )}
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => {
                const problem = handleApplyAssumptions(DEFAULT_ASSUMPTIONS);
                if (problem) setAssumptionsError(problem);
              }}
              className="inline-flex min-h-11 items-center rounded-lg bg-accent px-3 text-sm font-semibold text-on-accent"
            >
              Use default financial assumptions
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
          {savingNotice}
          {saveWarning && <Notice tone="warning" title="Not saved">{saveWarning}</Notice>}
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
  const previewDays = Math.min(30, assumptions.horizonDays);
  const slice = slicePlan(rows, asOf, previewDays, outcome.startingBalanceCents);
  const guidanceIssue = spendingGuidanceIssue(state, rows, asOf);
  const windowNotice = beyondWindowBillNotice(state, asOf, assumptions.horizonDays);
  const isForecastSection = section === "plan" || section === "future" || section === "advanced";
  const showGuidance = guidanceIssue === null;
  const safeSpendCents = showGuidance ? outcome.safeSpendCents : null;
  const sum = transactionSumCents(state.transactions);
  const currentSpend = spendingThisMonth(state.transactions, asOf);
  const previousSpend = spendingLastMonth(state.transactions, asOf);
  const overdue = computeOverdueObligations(state, asOf);
  const nextBill = rows.find((row) => row.amount_cents < 0) ?? null;
  const copy = describePosition({
    recordedBalanceCents: outcome.startingBalanceCents,
    scheduledIncomeCents: slice.scheduledIncomeCents,
    scheduledBillCents: slice.scheduledOutflowCents,
    plannedEndingCents: slice.plannedEndingCents,
    windowDays: previewDays,
    safeSpendCents,
    reserveCents: outcome.reserveCents,
    quantileNum: outcome.quantileNum,
    quantileDen: outcome.quantileDen,
    runs: outcome.runs,
    isDemo: usingDemo,
    hasSchedule: slice.events.length > 0,
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
    safeSpendCents,
    reserveCents: outcome.reserveCents,
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
        onOpenSync={openSync}
        onResetDemo={handleResetDemo}
        onExportJson={handleExportJson}
        section={section}
        onNavigate={navigate}
        isSaving={isSaving}
      />
      <main id="content" className="mx-auto w-full min-w-0 max-w-5xl flex-1 space-y-4 px-4 py-6">
        <p className="text-sm text-muted">{SECTION_QUESTION[section]}</p>
        {savingNotice}
        {saveWarning && <Notice tone="warning" title="Not saved">{saveWarning}</Notice>}
        {assumptionsWarning && <Notice tone="warning" title="Financial settings">{assumptionsWarning}</Notice>}
        {isForecastSection && guidanceIssue && (
          <Notice tone="warning" title="Not enough information to suggest spending">{guidanceIssue}</Notice>
        )}
        {(section === "home" || section === "bills" || isForecastSection) && windowNotice && (
          <Notice tone="info" title="A bill is outside the plan window">{windowNotice}</Notice>
        )}
        {section === "home" && (
          <HomeView
            asOf={asOf}
            usingDemo={usingDemo}
            needsSetup={needsSetup}
            copy={copy}
            startingBalanceCents={outcome.startingBalanceCents}
            safeSpendCents={safeSpendCents}
            guidanceIssue={guidanceIssue}
            plannedLowCents={outcome.projectedLowCents}
            plannedLowDate={outcome.projectedLowDate}
            slice={slice}
            insights={insights}
            assumptionsChanged={assumptionsChanged}
            horizonDays={assumptions.horizonDays}
            reserveCents={assumptions.reserveCents}
            runs={outcome.runs}
            onNavigate={navigate}
            saving={isSaving}
            createOwn={async (input) => {
              const created = createStarterLedger(input);
              if (!created.ok) return created;
              return handleUpdateState(created.state);
            }}
          />
        )}
        {section === "money" && (
          <MoneyView
            state={state}
            asOf={asOf}
            startingBalanceCents={outcome.startingBalanceCents}
            onEdit={onEdit}
            saving={isSaving}
          />
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
          <fieldset disabled={isSaving} className="m-0 min-w-0 w-full border-0 p-0">
            <BillsView
              state={state}
              asOf={asOf}
              slice={slicePlan(rows, asOf, assumptions.horizonDays, outcome.startingBalanceCents)}
              horizonDays={assumptions.horizonDays}
              assumptions={assumptions}
              overdue={overdue}
              onEdit={onEdit}
            />
          </fieldset>
        )}
        {section === "plan" && (
          <PlanView
            state={state}
            asOf={asOf}
            assumptions={assumptions}
            base={outcome}
            showGuidance={showGuidance}
            onEdit={onEdit}
            saving={isSaving}
          />
        )}
        {section === "future" && (
          <FutureView asOf={asOf} outcome={outcome} rows={rows} showGuidance={showGuidance} assumptionsChanged={assumptionsChanged} />
        )}
        {section === "advanced" && (
          <AdvancedView assumptions={assumptions} outcome={outcome} asOf={asOf} showGuidance={showGuidance} onApply={handleApplyAssumptions} />
        )}
      </main>
      <footer className="border-t border-line px-4 py-6 text-center text-sm text-muted">
        <p>MonteCarlo keeps this plan in your browser. Sync is optional. Forecasts are estimates, not guarantees.</p>
      </footer>
      <SyncModal
        isOpen={isSyncModalOpen}
        onClose={() => setIsSyncModalOpen(false)}
        currentState={state}
        currentStoredRaw={storedRaw}
        onApplyState={handleApplyState}
        currentVaultId={currentVaultId}
        onVaultSelected={setCurrentVaultId}
      />
    </div>
  );
}
