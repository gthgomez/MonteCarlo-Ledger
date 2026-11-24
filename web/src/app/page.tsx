"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AdvancedView } from "@/components/AdvancedView";
import { BillsView } from "@/components/BillsView";
import { BudgetView } from "@/components/BudgetView";
import { FutureView } from "@/components/FutureView";
import { Header } from "@/components/Header";
import { HomeView, type HomeForecast } from "@/components/HomeView";
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
  type AssumptionsLoadResult,
} from "@/lib/assumptions-persistence";
import {
  BUDGET_TARGETS_KEY,
  EMPTY_TARGETS,
  loadBudgetTargets,
  saveBudgetTargets,
  type BudgetTargets,
} from "@/lib/budget-targets";
import { serializeSettingsProfile, type SettingsProfile } from "@/lib/settings-profile";
import { type EditResult } from "@/lib/ledger-edits";
import { formatMoney } from "@/lib/money-format";
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
import { projectedDebtMinimums } from "@/lib/scenario-builder";
import { SECTION_LABEL, SECTION_QUESTION, sectionFromHash, type Section } from "@/lib/sections";
import { PersistenceResult, VAULT_ID_STORAGE_KEY } from "@/lib/sync-state";
import { SAMPLE_LEDGER_STATE, type LedgerState } from "@/lib/types";
import { computeOverdueObligations } from "@/lib/overdue";
import { useFinancialDate } from "@/lib/use-financial-date";
import { parseLedgerState } from "@/lib/validate";

const THEME_KEY = "mc-theme";
/**
 * Demo provenance must survive a reload. Otherwise editing a sample row saves it
 * as if it were the person's own ledger and the "not your finances" label vanishes.
 */
const DEMO_MODE_KEY = "montecarlo_demo_mode_v1";

/**
 * A second submission in the same tab must fail immediately instead of queuing
 * behind the first. Otherwise both edits are built from the same visible ledger,
 * the second compares against a raw snapshot that the first has already replaced,
 * and the conflict surfaces only after the form has erased the user's draft.
 */
const BUSY_SAVE_MESSAGE =
  "Another ledger change is still being saved. Wait for it to finish before trying again. Nothing was saved by this attempt.";

const SETTINGS_SAVE_BUSY =
  "Financial settings are still being saved. Wait for that save to finish before trying again.";

const HOME_ONBOARDING_DRAFT_KEY = "home:onboarding";
const ADVANCED_SETTINGS_DRAFT_KEY = "advanced:assumptions";

/**
 * A failed save leaves its submitted values in the form's component state.
 * Section navigation unmounts that state, so leaving must be an explicit choice.
 */
const UNSAVED_DRAFT_LEAVE_MESSAGE =
  "A change here was not saved. If you leave this section now, the unsaved draft and any values you typed will be discarded. Choose Cancel to stay and keep the draft. Reloading also discards it.";

const UNSAVED_DRAFT_RELOAD_MESSAGE =
  "Reloading discards any open drafts. Choose Cancel to stay and copy your draft first.";

/**
 * A replacement is authorized against a durable snapshot, not against the
 * forms on screen. A submitted draft that failed is still only component state,
 * so replacing the ledger must be an explicit decision to drop it.
 */
const REPLACEMENT_DISCARD_DRAFT_MESSAGE =
  "A change here was not saved. A successful replacement will discard the unsaved draft. Choose OK to continue with replacement, or Cancel to keep the draft and stop.";

const REPLACEMENT_CANCELLED_MESSAGE =
  "Replacement cancelled to keep an unsaved form draft. Nothing was saved. Close Sync to keep or copy the draft before trying again.";

const DEMO_RESET_MESSAGE =
  "Replace this ledger with the sample demo data? Your local changes and any unsaved values typed into a form will be discarded.";

const LEDGER_RECOVERY_REQUIRED =
  "The last write could not be verified. Keep a copy of the previous ledger and inspect what is saved before retrying.";

type LedgerFreshness = "current" | "changed" | "unreadable" | "indeterminate";

/**
 * After a pull, the ledger may be newer than the browser's financial settings.
 * A missing or unreadable portable profile must withhold spending guidance until
 * the person reviews the settings; default assumptions are never substituted
 * silently for a recovered plan.
 */
type SettingsRecovery =
  | { status: "none" }
  | { status: "missing"; message: string }
  | { status: "applied"; message: string }
  | { status: "kept"; message: string };

interface SettingsView {
  values: Assumptions;
  /** Exact bytes underlying this view, including an explicitly displayed invalid record. */
  expectedRaw: string | null;
  problem: { error: string; raw: string | null; indeterminate?: true } | null;
}

function warnBeforeLeavingWhileSaving(event: BeforeUnloadEvent) {
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

function readDemoMarker(): boolean {
  try {
    return window.localStorage.getItem(DEMO_MODE_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDemoMarker(active: boolean): void {
  try {
    if (active) window.localStorage.setItem(DEMO_MODE_KEY, "1");
    else window.localStorage.removeItem(DEMO_MODE_KEY);
  } catch {
    // The visible in-memory label still applies; storage failure must not hide it.
  }
}

export default function Home() {
  const [state, setState] = useState<LedgerState>(SAMPLE_LEDGER_STATE);
  const [usingDemo, setUsingDemo] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveWarning, setSaveWarning] = useState<string | null>(null);
  const [settings, setSettings] = useState<SettingsView>({
    values: DEFAULT_ASSUMPTIONS,
    expectedRaw: null,
    problem: null,
  });
  const { values: assumptions, problem: assumptionsProblem } = settings;
  const [assumptionsWarning, setAssumptionsWarning] = useState<string | null>(null);
  /** True only when this browser has explicitly saved decision-critical settings. */
  const [hasSavedDecisionSettings, setHasSavedDecisionSettings] = useState(false);
  const [settingsRecovery, setSettingsRecovery] = useState<SettingsRecovery>({ status: "none" });
  const [storedRaw, setStoredRaw] = useState<string | null>(null);
  // Storage events and the write completion handler need the latest adopted
  // snapshot even before React renders the corresponding state.
  const displayedRawRef = useRef<string | null>(null);
  const [ledgerFreshness, setLedgerFreshness] = useState<LedgerFreshness>("current");
  const rollbackUnverifiedRef = useRef(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);
  const [currentVaultId, setCurrentVaultId] = useState<string | undefined>();
  const [section, setSection] = useState<Section>("home");
  const [targets, setTargets] = useState<BudgetTargets>(EMPTY_TARGETS);
  const [targetWarning, setTargetWarning] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark" | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isSavingSettings, setIsSavingSettings] = useState(false);
  const savesPending = isSaving || isSavingSettings;
  // Remounts the section panes after a verified replacement. Form state can act
  // on a replacement's payment IDs and recurrence slots, so a stale draft must
  // never survive into a ledger it was not typed against.
  const [ledgerViewGeneration, setLedgerViewGeneration] = useState(0);
  const writeInFlightRef = useRef(false);
  const settingsWriteInFlightRef = useRef(false);
  // Keys of forms whose last submitted save failed. A key is added only after a
  // real persistence failure and removed by that same form's next success.
  const failedDraftKeysRef = useRef<Set<string>>(new Set());

  // Guard native close/reload while any save is pending, or afterward if this
  // tab may hold the only copy of the pre-write ledger.
  useEffect(() => {
    return () => window.removeEventListener("beforeunload", warnBeforeLeavingWhileSaving);
  }, []);

  const showReadSettings = useCallback((loaded: AssumptionsLoadResult, fromOtherTab = false) => {
    if (!loaded.ok) {
      setSettings((current) => {
        // A new unreadable check does not resolve a prior uncertain write.
        if (loaded.raw === null && current.problem?.indeterminate) return current;
        return {
          ...current,
          expectedRaw: loaded.raw ?? current.expectedRaw,
          problem: { error: loaded.error, raw: loaded.raw },
        };
      });
      setAssumptionsWarning(null);
      return;
    }
    setSettings({ values: loaded.assumptions, expectedRaw: loaded.raw, problem: null });
    if (loaded.migrated) {
      // Legacy records are loaded read-only until the user saves explicitly.
      setAssumptionsWarning("Older financial settings were loaded. Save under Advanced to update their format.");
    } else if (fromOtherTab) {
      setAssumptionsWarning(loaded.raw === null
        ? "Financial settings were removed in another tab. Default assumptions are now active."
        : "Financial settings were updated in another tab.");
    } else {
      setAssumptionsWarning(loaded.warning);
    }
  }, []);

  useEffect(() => {
    const loadedSettings = loadAssumptions(browserStorage());
    showReadSettings(loadedSettings);
    setHasSavedDecisionSettings(loadedSettings.ok && loadedSettings.raw !== null);

    try {
      const saved = localStorage.getItem(LEDGER_STORAGE_KEY);
      if (saved !== null) {
        displayedRawRef.current = saved;
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
        setUsingDemo(readDemoMarker());
      } else {
        setUsingDemo(true);
        writeDemoMarker(true);
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
  }, [showReadSettings]);

  const refreshLedgerFreshness = useCallback(() => {
    // Rereading matching ledger bytes alone cannot verify vault metadata or a
    // failed rollback. Keep the prior snapshot available until explicit reload.
    if (rollbackUnverifiedRef.current) return;
    try {
      const storage = browserStorage();
      if (!storage) throw new Error("Browser storage unavailable");
      const durable = storage.getItem(LEDGER_STORAGE_KEY);
      setLedgerFreshness(durable === displayedRawRef.current ? "current" : "changed");
    } catch {
      setLedgerFreshness("unreadable");
    }
  }, []);

  useEffect(() => {
    if (!isLoaded || loadError) return;
    function receiveLedger(event: StorageEvent) {
      if (event.key === LEDGER_STORAGE_KEY || event.key === null) refreshLedgerFreshness();
    }
    function onVisible() {
      if (document.visibilityState === "visible") refreshLedgerFreshness();
    }
    // Check the actual durable bytes, not a possibly delayed event payload.
    window.addEventListener("storage", receiveLedger);
    window.addEventListener("focus", refreshLedgerFreshness);
    window.addEventListener("pageshow", refreshLedgerFreshness);
    document.addEventListener("visibilitychange", onVisible);
    refreshLedgerFreshness();
    return () => {
      window.removeEventListener("storage", receiveLedger);
      window.removeEventListener("focus", refreshLedgerFreshness);
      window.removeEventListener("pageshow", refreshLedgerFreshness);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [isLoaded, loadError, refreshLedgerFreshness]);

  useEffect(() => {
    function receiveAssumptions(event: StorageEvent) {
      if (event.key !== ASSUMPTIONS_STORAGE_KEY && event.key !== null) return;
      // Storage events may be delivered out of order; the durable key is the source of truth,
      // not the event's historical newValue payload.
      const loaded = loadAssumptions(browserStorage());
      showReadSettings(loaded, true);
      setHasSavedDecisionSettings(loaded.ok && loaded.raw !== null);
    }

    window.addEventListener("storage", receiveAssumptions);
    return () => window.removeEventListener("storage", receiveAssumptions);
  }, [showReadSettings]);

  const asOf = useFinancialDate();
  const debtMinimums = useMemo(
    () => projectedDebtMinimums(state, asOf, assumptions.horizonDays),
    [state, asOf, assumptions.horizonDays]
  );

  const settingsRecoveryMissing = settingsRecovery.status === "missing";
  const evaluation = useMemo(
    () => assumptionsProblem || ledgerFreshness !== "current" || settingsRecoveryMissing
      ? null
      : evaluateLedger(state, asOf, assumptions),
    [state, asOf, assumptions, assumptionsProblem, ledgerFreshness, settingsRecoveryMissing]
  );

  function recordDraftOutcome(draftKey: string | undefined, failed: boolean) {
    if (!draftKey) return;
    if (failed) failedDraftKeysRef.current.add(draftKey);
    else failedDraftKeysRef.current.delete(draftKey);
  }

  /**
   * A row-level Cancel is an explicit decision to discard that one draft.
   * Remove only its marker so leaving the section no longer prompts, without
   * dropping markers for other forms or other rows that still hold a draft.
   */
  function discardFailedDraft(draftKey: string) {
    failedDraftKeysRef.current.delete(draftKey);
  }

  /**
   * Only a replacement that storage has verified may drop form drafts. The old
   * pane is unmounted rather than reconciled, because a replacement can reuse a
   * payment ID or slot that an old draft would otherwise still target.
   */
  function showReplacedLedger(nextState: LedgerState, demo = false) {
    showSavedLedger(nextState, demo);
    failedDraftKeysRef.current.clear();
    setLedgerViewGeneration((current) => current + 1);
  }

  function navigate(next: Section) {
    // Navigation is held until the durable result is known so a pending save
    // cannot be mistaken for an abandoned draft or hidden behind another section.
    if (writeInFlightRef.current || settingsWriteInFlightRef.current) return;
    if (next === section) return;
    // Every section change goes through here, including header and insight
    // links. Only an explicit confirmation may discard a failed form draft.
    if (failedDraftKeysRef.current.size > 0) {
      if (!window.confirm(UNSAVED_DRAFT_LEAVE_MESSAGE)) return;
      failedDraftKeysRef.current.clear();
      setSaveWarning(null);
    }
    setSection(next);
    const url = `${window.location.pathname}${window.location.search}#${next}`;
    window.history.replaceState(null, "", url);
    requestAnimationFrame(() => document.getElementById("content")?.focus({ preventScroll: true }));
  }

  function reloadLedger() {
    if (writeInFlightRef.current || settingsWriteInFlightRef.current) return;
    const warning = rollbackUnverifiedRef.current
      ? "Reloading discards the previous ledger and open drafts held by this tab. Export the previous ledger and copy any drafts first. Reload and inspect the saved ledger anyway?"
      : ledgerFreshness !== "current" || failedDraftKeysRef.current.size > 0
        ? UNSAVED_DRAFT_RELOAD_MESSAGE
        : null;
    if (warning && !window.confirm(warning)) return;
    // The explicit recovery confirmation already covers the loss of this copy.
    window.removeEventListener("beforeunload", warnBeforeLeavingWhileSaving);
    window.location.reload();
  }

  function retryPage(event: React.MouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    reloadLedger();
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
    const raw = JSON.stringify(nextState);
    displayedRawRef.current = raw;
    setStoredRaw(raw);
    setState(nextState);
    setUsingDemo(demo);
    writeDemoMarker(demo);
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
    if (rollbackUnverifiedRef.current) return { ok: false, error: LEDGER_RECOVERY_REQUIRED };
    if (settingsWriteInFlightRef.current) return { ok: false, error: SETTINGS_SAVE_BUSY };
    if (writeInFlightRef.current) {
      return { ok: false, error: BUSY_SAVE_MESSAGE };
    }
    writeInFlightRef.current = true;
    setIsSaving(true);
    window.addEventListener("beforeunload", warnBeforeLeavingWhileSaving);
    try {
      const result = await operation();
      if (!result.ok && result.indeterminate) {
        rollbackUnverifiedRef.current = true;
        setLedgerFreshness("indeterminate");
      } else {
        refreshLedgerFreshness();
      }
      return result;
    } finally {
      if (!rollbackUnverifiedRef.current) {
        window.removeEventListener("beforeunload", warnBeforeLeavingWhileSaving);
      }
      writeInFlightRef.current = false;
      setIsSaving(false);
    }
  }

  async function handleUpdateState(nextState: LedgerState): Promise<PersistenceResult> {
    const saved = await runLedgerWrite(async () => {
      setSaveWarning(null);
      const result = await saveLedgerChange(nextState, { expectedRaw: storedRaw });
      // Editing sample rows does not turn them into the person's finances. The
      // demo marker and label stay until an explicit replacement/onboarding.
      if (result.ok) showSavedLedger(nextState, usingDemo);
      return result;
    });
    if (!saved.ok && !saved.indeterminate) {
      setSaveWarning(`${saved.error} Keep a copy of any unsaved details before reloading.`);
    }
    return saved;
  }

  async function handleApplyState(nextState: LedgerState, options: LedgerChangeOptions): Promise<PersistenceResult> {
    // Refuse before taking the lock: a declined discard must not queue a write
    // that could replace the ledger the person chose to keep their draft for.
    if (rollbackUnverifiedRef.current) return { ok: false, error: LEDGER_RECOVERY_REQUIRED };
    if (settingsWriteInFlightRef.current) return { ok: false, error: SETTINGS_SAVE_BUSY };
    if (writeInFlightRef.current) return { ok: false, error: BUSY_SAVE_MESSAGE };
    if (failedDraftKeysRef.current.size > 0 && !window.confirm(REPLACEMENT_DISCARD_DRAFT_MESSAGE)) {
      return { ok: false, error: REPLACEMENT_CANCELLED_MESSAGE };
    }
    return runLedgerWrite(async () => {
      const saved = await saveLedgerChange(nextState, { ...options, requireLock: true });
      if (saved.ok) {
        showReplacedLedger(nextState);
        if (options.vaultId) setCurrentVaultId(options.vaultId);
      }
      return saved;
    });
  }

  async function handleApplyAssumptions(
    nextAssumptions: Assumptions,
    fromRecovery = false
  ): Promise<string | null> {
    if (writeInFlightRef.current) return BUSY_SAVE_MESSAGE;
    if (settingsWriteInFlightRef.current) return SETTINGS_SAVE_BUSY;
    settingsWriteInFlightRef.current = true;
    setIsSavingSettings(true);
    setAssumptionsWarning(null);
    window.addEventListener("beforeunload", warnBeforeLeavingWhileSaving);
    try {
      // This expected value belongs to the settings rendered when the user
      // submitted, not to an asynchronous storage event that arrives later.
      const saved = await saveAssumptions(browserStorage(), nextAssumptions, settings.expectedRaw);
      if (saved.ok) {
        showReadSettings(parseSavedAssumptions(saved.raw));
        setHasSavedDecisionSettings(true);
        // An explicit save is a deliberate choice; it resolves the post-restore
        // "settings were not recovered" block without pretending they came from
        // the vault.
        if (settingsRecovery.status === "missing") {
          setSettingsRecovery({
            status: "applied",
            message: "Financial settings were saved in this browser after recovery.",
          });
        }
        return null;
      }
      if (saved.reason === "conflict") {
        // Adopt the checked saved values, not the submitted values. Advanced
        // continues overlaying its dirty fields for review before a retry.
        showReadSettings(parseSavedAssumptions(saved.raw), true);
      } else if (saved.reason === "indeterminate" || saved.reason === "unreadable") {
        const resultProblem: SettingsView["problem"] = saved.reason === "indeterminate"
          ? { error: saved.error, raw: null, indeterminate: true }
          : { error: saved.error, raw: null };
        setSettings((current) => ({
          ...current,
          problem: current.problem?.indeterminate && saved.reason === "unreadable"
            ? current.problem
            : resultProblem,
        }));
        // Show the uncertainty/unreadability once, in the page's recovery
        // notice. Keep an editor-level failure so this draft still has a guard.
        return "Your settings draft was kept. Check the saved settings before trying again.";
      }
      if (fromRecovery) setAssumptionsWarning(saved.error);
      return saved.error;
    } finally {
      if (!rollbackUnverifiedRef.current) {
        window.removeEventListener("beforeunload", warnBeforeLeavingWhileSaving);
      }
      settingsWriteInFlightRef.current = false;
      setIsSavingSettings(false);
    }
  }

  /**
   * Apply settings recovered from the portable vault profile. The ledger was
   * already replaced, so this is the step that makes the recovered decision
   * inputs match the recovered records. A failed save leaves the guidance gate
   * closed; it never falls back to defaults silently.
   */
  async function handleApplyRecoveredSettings(profile: SettingsProfile): Promise<string | null> {
    const settingsError = await handleApplyAssumptions(profile.assumptions, true);
    if (settingsError) return settingsError;
    const savedTargets = saveBudgetTargets(browserStorage(), profile.budgetTargets);
    if (!savedTargets.ok) {
      setTargetWarning(savedTargets.error);
      // Budget targets do not change the spending calculation. Keep the recovered
      // decision settings usable and surface the target failure separately.
    } else {
      setTargets(profile.budgetTargets);
      setTargetWarning(null);
    }
    return null;
  }

  function readSavedSettings() {
    if (writeInFlightRef.current || settingsWriteInFlightRef.current) return;
    showReadSettings(loadAssumptions(browserStorage()));
  }

  async function handleResetDemo() {
    if (rollbackUnverifiedRef.current) {
      setSaveWarning(LEDGER_RECOVERY_REQUIRED);
      return;
    }
    if (settingsWriteInFlightRef.current) {
      setSaveWarning(SETTINGS_SAVE_BUSY);
      return;
    }
    if (writeInFlightRef.current) {
      setSaveWarning(BUSY_SAVE_MESSAGE);
      return;
    }
    if (!confirm(DEMO_RESET_MESSAGE)) return;
    await runLedgerWrite(async () => {
      const result = await saveLedgerChange(SAMPLE_LEDGER_STATE, { expectedRaw: storedRaw, requireLock: true });
      if (result.ok) {
        showReplacedLedger(SAMPLE_LEDGER_STATE, true);
        setLoadError(null);
      } else if (!result.indeterminate) {
        setSaveWarning(result.error);
      }
      return result;
    });
  }

  function handleExportJson() {
    const previous = ledgerFreshness !== "current";
    const serialized = previous ? displayedRawRef.current : JSON.stringify(state, null, 2);
    if (serialized === null) return;
    const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(serialized);
    const downloadAnchor = document.createElement("a");
    downloadAnchor.setAttribute("href", dataStr);
    downloadAnchor.setAttribute("download", `montecarlo-ledger${previous ? "-previous" : ""}-${asOf}.json`);
    document.body.appendChild(downloadAnchor);
    downloadAnchor.click();
    downloadAnchor.remove();
  }

  async function onEdit(result: EditResult, draftKey?: string): Promise<PersistenceResult> {
    if (!result.ok) {
      // A rejected edit was never submitted to storage, so it is not a saved draft.
      setSaveWarning(result.error);
      return { ok: false, error: result.error };
    }
    const saved = await handleUpdateState(result.state);
    recordDraftOutcome(draftKey, !saved.ok);
    return saved;
  }

  function openSync() {
    if (writeInFlightRef.current || settingsWriteInFlightRef.current) return;
    setIsSyncModalOpen(true);
  }

  function saveTargets(next: BudgetTargets): string | null {
    const saved = saveBudgetTargets(localStorage, next);
    if (!saved.ok) return saved.error;
    setTargets(next);
    setTargetWarning(null);
    return null;
  }

  let portableSettings: SettingsProfile | null = null;
  if (!assumptionsProblem) {
    try {
      portableSettings = serializeSettingsProfile(assumptions, targets);
    } catch {
      portableSettings = null;
    }
  }

  // Keep the live region mounted so pending saves are announced when they start.
  const savingNotice = (
    <div role="status" aria-live="polite" className={savesPending ? undefined : "sr-only"}>
      {isSaving && (
        <Notice tone="info" title="Saving your ledger change">
          Keep this tab open until the browser confirms the change is stored. Your draft stays in this section until then.
        </Notice>
      )}
      {isSavingSettings && (
        <Notice tone="info" title="Saving financial settings">
          Keep this tab open until the browser has checked the saved settings.
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

  // Keep form and export access without treating this tab's previous copy as
  // current. Only a verified matching ledger is evaluated for forecasts.
  const ledgerProblem = ledgerFreshness === "current" ? null : (
    <section className="space-y-3 rounded-2xl border border-warning bg-warning-soft p-4">
      <h1 className="text-lg font-semibold">
        {ledgerFreshness === "indeterminate"
          ? "Saved ledger could not be verified"
          : ledgerFreshness === "changed"
            ? "Saved ledger changed"
            : "Saved ledger could not be read"}
      </h1>
      <p role="alert" className="text-sm">
        {ledgerFreshness === "indeterminate"
          ? "Some or all of the last change may have persisted. Forecasts, ledger writes, and Sync are paused in this tab."
          : "This tab can no longer verify that its ledger is current. Forecasts are paused; edits based on the previous copy cannot overwrite newer saved data."}
      </p>
      <p className="text-sm text-muted">
        {!loadError && "Entries shown below are from the previous view. "}
        Copy any open drafts before reloading to inspect what is saved.
        {storedRaw !== null ? " Export the previous ledger first and keep the unencrypted copy private." : " This tab has no previous saved ledger to export."}
      </p>
      <div className="flex flex-wrap gap-2">
        {storedRaw !== null && (
          <button type="button" onClick={handleExportJson} className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-3 text-sm font-semibold">
            Export previous ledger
          </button>
        )}
        <button type="button" disabled={savesPending} onClick={reloadLedger} className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-3 text-sm font-semibold">
          Reload saved ledger
        </button>
      </div>
    </section>
  );

  if (loadError) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-canvas p-6 text-ink">
        <div className="w-full max-w-xl space-y-4 rounded-2xl border border-warning bg-warning-soft p-6">
          <h1 className="text-lg font-semibold">Saved Ledger Not Loaded</h1>
          <p className="text-sm">{loadError}</p>
          {savingNotice}
          {ledgerFreshness === "indeterminate" ? ledgerProblem : (
            <>
              <p className="text-sm text-muted">
                No forecast is shown because the stored financial data could not be validated. The app did not replace the data while loading.
              </p>
              {saveWarning && <Notice tone="warning" title="Not saved">{saveWarning}</Notice>}
              <div className="flex flex-wrap gap-3">
                {storedRaw !== null && (
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
                  disabled={savesPending}
                  onClick={handleResetDemo}
                  className="inline-flex min-h-11 items-center rounded-lg bg-accent px-3 text-sm font-semibold text-on-accent"
                >
                  Replace with sample data (explicit)
                </button>
                <a href="/" onClick={retryPage} className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-3 text-sm font-semibold">
                  Retry
                </a>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  const forecastProblem = assumptionsProblem ? (
    <section className="space-y-4 rounded-2xl border border-warning bg-warning-soft p-6">
      <h1 className="text-lg font-semibold">Financial Settings Not Loaded</h1>
      <p className="text-sm" role="alert">{assumptionsProblem.error}</p>
      {assumptionsWarning && <p className="text-sm" role="status">{assumptionsWarning}</p>}
      <p className="text-sm text-muted">
        No forecast is shown until the saved settings can be checked or repaired. Reading the settings or choosing
        defaults does not change your ledger or discard open drafts.
      </p>
      {assumptionsProblem.raw !== null && (
        <a
          href={"data:text/json;charset=utf-8," + encodeURIComponent(assumptionsProblem.raw)}
          download="montecarlo-financial-settings-recovery.json"
          className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-3 text-sm font-semibold"
        >
          Download saved settings
        </a>
      )}
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={savesPending}
          onClick={readSavedSettings}
          className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-3 text-sm font-semibold"
        >
          Read saved settings
        </button>
        <button
          type="button"
          disabled={savesPending}
          onClick={() => void handleApplyAssumptions(DEFAULT_ASSUMPTIONS, true)}
          className="inline-flex min-h-11 items-center rounded-lg bg-accent px-3 text-sm font-semibold text-on-accent"
        >
          Use default financial assumptions
        </button>
        <a href="/" onClick={retryPage} className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-3 text-sm font-semibold">
          Retry
        </a>
      </div>
    </section>
  ) : evaluation?.status === "error" ? (
    <section className="space-y-4 rounded-2xl border border-danger bg-danger-soft p-6">
      <h1 className="text-lg font-semibold">Calculation Failed</h1>
      <p className="text-sm" role="alert">
        The financial engine could not evaluate this ledger, so no forecast, risk estimate, or safe-to-spend
        number is shown. You can still review saved entries and keep or correct open drafts.
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
          disabled={savesPending}
          onClick={handleResetDemo}
          className="inline-flex min-h-11 items-center rounded-lg bg-accent px-3 text-sm font-semibold text-on-accent"
        >
          Reset to sample data
        </button>
        <a href="/" onClick={retryPage} className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-3 text-sm font-semibold">
          Retry
        </a>
      </div>
    </section>
  ) : null;

  const forecast = evaluation?.status === "ok" ? evaluation : null;
  const guidanceIssue = forecast && spendingGuidanceIssue(state, forecast.rows, asOf);
  const windowNotice = forecast && beyondWindowBillNotice(state, asOf, assumptions.horizonDays);
  const isForecastSection = section === "plan" || section === "future" || section === "advanced";
  const showGuidance = forecast !== null && guidanceIssue === null;
  const currentSpend = spendingThisMonth(state.transactions, asOf);
  const previousSpend = spendingLastMonth(state.transactions, asOf);
  const overdue = computeOverdueObligations(state, asOf);
  const assumptionsChanged = JSON.stringify(assumptions) !== JSON.stringify(DEFAULT_ASSUMPTIONS);
  const needsSchedule = state.incomes.length === 0 && state.payments.length === 0;
  let homeForecast: HomeForecast | null = null;
  if (section === "home" && forecast) {
    const { outcome, rows } = forecast;
    const previewDays = Math.min(30, assumptions.horizonDays);
    const slice = slicePlan(rows, asOf, previewDays, outcome.startingBalanceCents);
    // The lead describes the same horizon that produced the cautious amount. A
    // 30-day preview must never make a 90-day conclusion say "nothing scheduled".
    const fullSlice = slicePlan(rows, asOf, assumptions.horizonDays, outcome.startingBalanceCents);
    const safeSpendCents = showGuidance ? outcome.safeSpendCents : null;
    const copy = describePosition({
      recordedBalanceCents: outcome.startingBalanceCents,
      scheduledIncomeCents: fullSlice.scheduledIncomeCents,
      scheduledBillCents: fullSlice.scheduledOutflowCents,
      plannedEndingCents: fullSlice.plannedEndingCents,
      windowDays: assumptions.horizonDays,
      safeSpendCents,
      reserveCents: outcome.reserveCents,
      quantileNum: outcome.quantileNum,
      quantileDen: outcome.quantileDen,
      runs: outcome.runs,
      isDemo: usingDemo,
      hasSchedule: fullSlice.events.length > 0,
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
      nextBill: (() => {
        const keys = new Set(
          debtMinimums.map((minimum) => `${minimum.date}|${minimum.name}|${minimum.amount_cents}`)
        );
        return rows.find(
          (row) =>
            row.amount_cents < 0 &&
            !keys.has(`${row.date}|${row.name}|${row.amount_cents}`)
        ) ?? null;
      })(),
      nextDebtMinimum: (() => {
        const keys = new Set(
          debtMinimums.map((minimum) => `${minimum.date}|${minimum.name}|${minimum.amount_cents}`)
        );
        return rows.find(
          (row) =>
            row.amount_cents < 0 &&
            keys.has(`${row.date}|${row.name}|${row.amount_cents}`)
        ) ?? null;
      })(),
      spendingNote,
      overage: categoryOverages(currentSpend.byCategory, targets.categories)[0] ?? null,
      safeSpendCents,
      reserveCents: outcome.reserveCents,
      overdraftPpm: outcome.overdraftPpm,
      runs: outcome.runs,
      ledgerMatches: transactionSumCents(state.transactions) === state.current_balance_cents,
    });
    homeForecast = {
      copy,
      startingBalanceCents: outcome.startingBalanceCents,
      safeSpendCents,
      guidanceIssue,
      plannedLowCents: outcome.projectedLowCents,
      plannedLowDate: outcome.projectedLowDate,
      slice,
      // The schedule notice already offers both non-destructive add actions.
      insights: !usingDemo && needsSchedule
        ? insights.filter(({ id }) => id !== "no-income" && id !== "no-bills")
        : insights,
      assumptionsChanged,
      horizonDays: assumptions.horizonDays,
      reserveCents: assumptions.reserveCents,
      quantileNum: assumptions.quantileNum,
      quantileDen: assumptions.quantileDen,
      runs: outcome.runs,
    };
  }

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
        onExportJson={ledgerFreshness === "current" ? handleExportJson : undefined}
        section={section}
        onNavigate={navigate}
        isSaving={savesPending}
      />
      <main id="content" tabIndex={-1} className="mx-auto w-full min-w-0 max-w-5xl flex-1 space-y-4 px-4 py-6 outline-none">
        <p className="sr-only" role="status" aria-live="polite">Showing the {SECTION_LABEL[section]} section.</p>
        <p className="text-sm text-muted">{SECTION_QUESTION[section]}</p>
        {savingNotice}
        {saveWarning && <Notice tone="warning" title="Not saved">{saveWarning}</Notice>}
        {usingDemo && section !== "home" && (
          <Notice tone="warning" title="Sample data — not your finances">
            This section is still showing the sample household. Edits here stay labelled as sample data until you
            enter your own numbers.
            <div className="mt-3">
              <button
                type="button"
                disabled={savesPending}
                onClick={() => navigate("home")}
                className="inline-flex min-h-11 items-center rounded-lg bg-accent px-3 text-sm font-semibold text-on-accent disabled:opacity-50"
              >
                Enter my own numbers
              </button>
            </div>
          </Notice>
        )}
        {!assumptionsProblem && assumptionsWarning && <Notice tone="warning" title="Financial settings">{assumptionsWarning}</Notice>}
        {ledgerProblem}
        {settingsRecovery.status === "missing" && (
          <section className="space-y-3 rounded-2xl border border-warning bg-warning-soft p-4">
            <h1 className="text-lg font-semibold">Financial settings were not recovered</h1>
            <p className="text-sm" role="alert">{settingsRecovery.message}</p>
            <p className="text-sm text-muted">
              No spending recommendation or risk estimate is shown while the plan window and reserve are unknown.
              The current browser values are a {assumptions.horizonDays}-day window with a{" "}
              {formatMoney(assumptions.reserveCents)} reserve. They may not be the settings used with this ledger.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                disabled={savesPending}
                onClick={() => void handleApplyAssumptions(assumptions, true)}
                className="inline-flex min-h-11 items-center rounded-lg bg-accent px-3 text-sm font-semibold text-on-accent"
              >
                Use the settings shown now
              </button>
              <button
                type="button"
                disabled={savesPending}
                onClick={() => navigate("advanced")}
                className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-3 text-sm font-semibold"
              >
                Review plan window and reserve
              </button>
              <button
                type="button"
                disabled={savesPending}
                onClick={openSync}
                className="inline-flex min-h-11 items-center rounded-lg border border-line bg-surface px-3 text-sm font-semibold"
              >
                Try another vault
              </button>
            </div>
          </section>
        )}
        {settingsRecovery.status === "applied" && (
          <Notice tone="info" title="Financial settings recovered">{settingsRecovery.message}</Notice>
        )}
        {settingsRecovery.status === "kept" && (
          <Notice tone="warning" title="Vault financial settings not used">{settingsRecovery.message}</Notice>
        )}
        {forecastProblem}
        {isForecastSection && guidanceIssue && (
          <Notice tone="warning" title="Not enough information to suggest spending">{guidanceIssue}</Notice>
        )}
        {(section === "home" || section === "bills" || isForecastSection) && windowNotice && (
          <Notice tone="info" title="A bill is outside the plan window">{windowNotice}</Notice>
        )}
        <React.Fragment key={ledgerViewGeneration}>
          {section === "home" && (
            <HomeView
              asOf={asOf}
              usingDemo={usingDemo}
              needsSchedule={needsSchedule}
              forecast={homeForecast}
              onNavigate={navigate}
              saving={savesPending}
              createOwn={async (nextState) => {
                if (!usingDemo) {
                  return { ok: false, error: "A ledger already exists here. Add new entries in Money or Bills without replacing it." };
                }
                const saved = await handleUpdateState(nextState);
                if (saved.ok) {
                  // The starter ledger replaces the sample; only now is this the
                  // person's own plan and no longer demo data.
                  setUsingDemo(false);
                  writeDemoMarker(false);
                }
                recordDraftOutcome(HOME_ONBOARDING_DRAFT_KEY, !saved.ok);
                return saved;
              }}
            />
          )}
          {section === "money" && (
            <MoneyView
              state={state}
              asOf={asOf}
              startingBalanceCents={forecast?.outcome.startingBalanceCents ?? null}
              onEdit={onEdit}
              saving={savesPending}
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
            <fieldset disabled={savesPending} className="m-0 min-w-0 w-full border-0 p-0">
              <BillsView
                state={state}
                asOf={asOf}
                slice={forecast && slicePlan(forecast.rows, asOf, assumptions.horizonDays, forecast.outcome.startingBalanceCents)}
                horizonDays={assumptions.horizonDays}
                assumptions={assumptions}
                overdue={overdue}
                debtMinimums={debtMinimums}
                onEdit={onEdit}
                onDiscardDraft={discardFailedDraft}
              />
            </fieldset>
          )}
          {section === "plan" && (
            <PlanView
              state={state}
              asOf={asOf}
              assumptions={assumptions}
              base={forecast?.outcome ?? null}
              showGuidance={showGuidance}
              onEdit={onEdit}
              onDiscardDraft={discardFailedDraft}
              saving={savesPending}
            />
          )}
          {section === "future" && forecast && (
            <FutureView asOf={asOf} outcome={forecast.outcome} rows={forecast.rows} showGuidance={showGuidance} assumptionsChanged={assumptionsChanged} />
          )}
          {section === "advanced" && (
            <AdvancedView
              assumptions={assumptions}
              outcome={forecast?.outcome ?? null}
              asOf={asOf}
              showGuidance={showGuidance}
              onApply={handleApplyAssumptions}
              onDraftOutcome={(failed) => recordDraftOutcome(ADVANCED_SETTINGS_DRAFT_KEY, failed)}
              saving={savesPending}
            />
          )}
        </React.Fragment>
      </main>
      <footer className="border-t border-line px-4 py-6 text-center text-sm text-muted">
        <p>MonteCarlo keeps this plan in your browser. Sync is optional. Forecasts are estimates, not guarantees.</p>
      </footer>
      <SyncModal
        isOpen={isSyncModalOpen}
        recoveryRequired={ledgerFreshness === "indeterminate"}
        onClose={() => setIsSyncModalOpen(false)}
        currentState={state}
        currentStoredRaw={storedRaw}
        onApplyState={handleApplyState}
        currentVaultId={currentVaultId}
        usingDemo={usingDemo}
        settingsProfile={portableSettings}
        hasSavedDecisionSettings={hasSavedDecisionSettings}
        onApplyRecoveredSettings={handleApplyRecoveredSettings}
        onSettingsRecovery={setSettingsRecovery}
        onVaultSelected={setCurrentVaultId}
      />
    </div>
  );
}
