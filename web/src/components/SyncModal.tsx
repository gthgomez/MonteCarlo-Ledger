"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { X, Cloud, Lock, Terminal, Upload, Download, Check, AlertCircle, RefreshCw } from "lucide-react";
import {
  pushVault,
  pullVault,
  VaultLocalChangesError,
} from "@/lib/vault-client";
import { LedgerState } from "@/lib/types";
import { parseLedgerState } from "@/lib/validate";
import { PersistenceResult } from "@/lib/sync-state";
import type { LedgerChangeOptions } from "@/lib/persistence";
import { resolveSettingsReview } from "@/lib/persistence";
import { formatMoney } from "@/lib/money-format";
import {
  readSettingsProfileRevision,
  rememberSettingsProfileRevision,
  type SettingsProfile,
} from "@/lib/settings-profile";
import {
  newSettingsReviewToken,
  type SettingsReviewReason,
} from "@/lib/settings-review";
import { pullSettingsProfile, pushSettingsProfile } from "@/lib/settings-vault";

export type SettingsRecoveryOutcome =
  | { status: "applied"; message: string }
  | { status: "missing"; message: string; reviewToken: string | null }
  | { status: "kept"; message: string };

interface SyncModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentState: LedgerState;
  /** Exact durable snapshot corresponding to the ledger currently shown in this tab. */
  currentStoredRaw: string | null;
  onApplyState: (
    nextState: LedgerState,
    options: LedgerChangeOptions
  ) => Promise<PersistenceResult>;
  currentVaultId?: string;
  /** Sample data must never be uploaded as if it were the person's ledger. */
  usingDemo: boolean;
  /** The settings that a push should send with the ledger, or null when invalid. */
  settingsProfile: SettingsProfile | null;
  /** True only when this browser already holds explicitly saved decision settings. */
  hasSavedDecisionSettings: boolean;
  /** Apply a recovered profile; resolves to null on success or an error message. */
  onApplyRecoveredSettings: (profile: SettingsProfile) => Promise<string | null>;
  /** Tell the page whether recovered settings were applied, missing, or deliberately kept. */
  onSettingsRecovery: (outcome: SettingsRecoveryOutcome) => void;
  /** Tells the page which vault id was durably remembered after a successful push. */
  onVaultSelected: (vaultId: string) => void;
  /**
   * True only after a replacement result was indeterminate: storage may now hold
   * some or all of the attempted change. The parent owns the recovery surface and
   * a deliberate reload. This dialog stops new destructive starts but stays open
   * with the uncertain result so the person can close it and export first.
   */
  recoveryRequired: boolean;
}

type ActiveOperation = "push" | "pull" | "import";

interface PullTarget {
  vaultId: string;
  passphrase: string;
  /** Snapshot authorized before the pull request started; null means no stored ledger. */
  expectedRaw: string | null;
}

/** An unguessable default vault id (the metadata endpoint reveals existence). */
function randomVaultId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `vault-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

function browserStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function describeRecoveredSettings(profile: SettingsProfile): string {
  const categoryCount = Object.keys(profile.budgetTargets.categories).length;
  const target = profile.budgetTargets.monthlyLimitCents === null
    ? "no monthly spending target"
    : `a ${formatMoney(profile.budgetTargets.monthlyLimitCents)} monthly spending target`;
  return `${profile.assumptions.horizonDays}-day window, ${formatMoney(profile.assumptions.reserveCents)} reserve, and ${target}${categoryCount > 0 ? ` with ${categoryCount} category target${categoryCount === 1 ? "" : "s"}` : ""}`;
}

export function SyncModal({
  isOpen,
  onClose,
  currentState,
  currentStoredRaw,
  onApplyState,
  currentVaultId,
  usingDemo,
  settingsProfile,
  hasSavedDecisionSettings,
  onApplyRecoveredSettings,
  onSettingsRecovery,
  onVaultSelected,
  recoveryRequired,
}: SyncModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const operationSeq = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  const fileReaderRef = useRef<FileReader | null>(null);
  const activeOperationRef = useRef<ActiveOperation | null>(null);
  const [tab, setTab] = useState<"cloud" | "file" | "cli">("cloud");

  // Cloud Sync form. The default id is random so vaults are not enumerable.
  const [vaultId, setVaultId] = useState(() => currentVaultId || randomVaultId());
  const [passphrase, setPassphrase] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeOperation, setActiveOperation] = useState<ActiveOperation | null>(null);
  const [pendingConflict, setPendingConflict] = useState<PullTarget | null>(null);
  const isLoading = activeOperation !== null;

  // The page reads the saved vault id after its first render. Adopt it when it
  // arrives so a reload reopens Sync with the remembered id, not a new random one.
  useEffect(() => {
    if (currentVaultId) setVaultId(currentVaultId);
  }, [currentVaultId]);

  const invalidateOperation = useCallback(() => {
    operationSeq.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    fileReaderRef.current?.abort();
    fileReaderRef.current = null;
    activeOperationRef.current = null;
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = document.activeElement;
    dialog.showModal();
    return () => {
      if (activeOperationRef.current !== "push") invalidateOperation();
      dialog.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, [isOpen, invalidateOperation]);

  // Closing invalidates any in-flight pull/import and drops a stale confirmation.
  // A push is not cancelled here; handleClose refuses to close while it is running.
  useEffect(() => {
    if (isOpen) return;
    invalidateOperation();
    setActiveOperation(null);
    setPendingConflict(null);
    setStatusMessage(null);
    setErrorMessage(null);
  }, [isOpen, invalidateOperation]);

  if (!isOpen) return null;

  function startOperation(kind: ActiveOperation, cancellable: boolean) {
    operationSeq.current += 1;
    const controller = cancellable ? new AbortController() : null;
    abortRef.current = controller;
    activeOperationRef.current = kind;
    setActiveOperation(kind);
    return { id: operationSeq.current, controller };
  }

  function isCurrent(id: number, controller: AbortController | null): boolean {
    return operationSeq.current === id && !controller?.signal.aborted;
  }

  function finishOperation(id: number) {
    if (operationSeq.current !== id) return;
    abortRef.current = null;
    fileReaderRef.current = null;
    activeOperationRef.current = null;
    setActiveOperation(null);
  }

  function handleClose() {
    if (activeOperationRef.current === "push") {
      setErrorMessage(
        "A push is still being sent to the vault. Wait for it to finish before closing so its result is not hidden."
      );
      return;
    }
    // Pulls/imports have not committed yet. Cancelling the signal also prevents a
    // request already queued for the write lock from replacing the ledger later.
    invalidateOperation();
    setActiveOperation(null);
    setPendingConflict(null);
    setStatusMessage(null);
    setErrorMessage(null);
    onClose();
  }

  function changeVaultTarget(update: () => void) {
    update();
    // An uncertain result must stay visible until the user retains a copy. Editing
    // the target is not a resolution of it.
    if (recoveryRequired) return;
    setPendingConflict(null);
    setErrorMessage(null);
    setStatusMessage(null);
  }

  const handlePushToCloud = async () => {
    if (recoveryRequired || activeOperationRef.current) return;
    if (usingDemo) {
      const proceed = window.confirm(
        "This is sample data, not your finances. If you push it, another device will recover it as a real ledger.\n\nEnter your own numbers from Home first unless you are deliberately testing the vault. Push the sample anyway?"
      );
      if (!proceed) {
        setErrorMessage(null);
        setStatusMessage("Push cancelled. Sample data was not sent.");
        return;
      }
    }
    if (!vaultId.trim() || !passphrase.trim()) {
      setStatusMessage(null);
      setErrorMessage("Please enter both Vault ID and Passphrase.");
      return;
    }
    const { id } = startOperation("push", false);
    setErrorMessage(null);
    setStatusMessage(null);
    setPendingConflict(null);

    try {
      // Salt discovery happens inside pushVault: an existing vault is always
      // authenticated with its stored KDF salt, never a freshly generated one.
      // The push is based on this device's recorded revision, never the latest one.
      const chosenVaultId = vaultId.trim();
      const { revision, ancestryPersisted, vaultIdPersisted } = await pushVault(
        chosenVaultId,
        passphrase,
        currentState,
        { expectedLedgerRaw: currentStoredRaw }
      );
      if (operationSeq.current !== id) return;
      setErrorMessage(null);
      // Only a push the vault accepted may change the remembered selection. If the
      // upload succeeded but the id could not be stored (or another tab selected a
      // different vault meanwhile), keep the page honest and ask for a manual copy.
      if (vaultIdPersisted) onVaultSelected(chosenVaultId);
      const problems: string[] = [];
      if (!ancestryPersisted) {
        problems.push("the local sync ancestry could not be saved, so pull before the next push");
      }
      if (!vaultIdPersisted) {
        problems.push(
          "this browser could not save the Vault ID (another tab may have selected a different vault, or storage failed); record the Vault ID and passphrase now so you can pull this vault again"
        );
      }
      let settingsRevision: number | null = null;
      if (settingsProfile) {
        try {
          // Bind the profile to the exact ledger revision pushVault just had
          // accepted. Do not re-read metadata to choose this value.
          const settingsResult = await pushSettingsProfile(
            chosenVaultId,
            passphrase,
            settingsProfile,
            revision
          );
          if (settingsResult.ok) {
            settingsRevision = settingsResult.revision;
            if (!settingsResult.ancestryPersisted) {
              problems.push(
                "financial settings were saved but their local revision could not be recorded, so pull before pushing settings again"
              );
            }
          } else {
            problems.push(`financial settings were not synchronized: ${settingsResult.error}`);
          }
        } catch (err: unknown) {
          problems.push(`financial settings were not synchronized: ${describeError(err)}`);
        }
      } else {
        problems.push("financial settings are invalid, so only the ledger was pushed");
      }
      setStatusMessage(
        problems.length === 0
          ? `Successfully pushed encrypted snapshot to Cloud Vault (rev ${revision})!${settingsRevision !== null ? ` Financial settings saved (rev ${settingsRevision}).` : ""}`
          : `Pushed the ledger to Cloud Vault (rev ${revision}), but ${problems.join("; ")}.`
      );
    } catch (err: unknown) {
      if (operationSeq.current !== id) return;
      setErrorMessage(describeError(err) || "Failed to push to vault.");
    } finally {
      finishOperation(id);
    }
  };

  const runPull = async (target: PullTarget, allowOverwriteLocal: boolean) => {
    if (recoveryRequired || activeOperationRef.current) return;
    const { id, controller } = startOperation("pull", true);
    if (!controller) return;
    setErrorMessage(null);
    setStatusMessage(null);
    setPendingConflict(null);

    try {
      const { state, revision } = await pullVault(
        target.vaultId,
        target.passphrase,
        currentState,
        { allowOverwriteLocal }
      );
      // Closing (or another operation) invalidates this request before any write.
      if (!isCurrent(id, controller)) return;

      // Read the optional settings companion before replacing anything. If the
      // profile is missing or corrupt, the ledger can still be restored, but the
      // page withholds guidance until the person reviews decision settings.
      let profileOutcome: Awaited<ReturnType<typeof pullSettingsProfile>> | null = null;
      let profileError: string | null = null;
      try {
        profileOutcome = await pullSettingsProfile(target.vaultId, target.passphrase);
      } catch (err: unknown) {
        profileError = describeError(err);
      }
      if (!isCurrent(id, controller)) return;

      // The ledger restore and its needs-review guard are one durable bundle:
      // persistence writes and verifies the guard before the ledger. Even a found
      // profile starts guarded until its settings are applied and the guard is
      // cleared for this exact restore token.
      const reviewToken = newSettingsReviewToken();
      const reviewReason: SettingsReviewReason =
        profileOutcome?.status === "found"
          ? "settings-pending"
          : profileOutcome?.status === "unreadable" || profileError !== null
            ? "unreadable"
            : "missing";
      // Do not claim success unless the browser durably stored the restored ledger.
      // The exact authorized raw snapshot is re-checked under the shared write lock.
      const applied = await onApplyState(state, {
        expectedRaw: target.expectedRaw,
        vaultId: target.vaultId,
        syncRevision: revision,
        signal: controller.signal,
        requireLock: true,
        settingsReview: { action: "require", token: reviewToken, reason: reviewReason },
      });
      // If the dialog was closed while the write was still queued, the abort made
      // this fail. If the ledger already committed, continue: new records must not
      // stay beside old/default decision settings without a recorded status.
      if (!applied.ok) {
        // An indeterminate rollback may have left all or part of the vault state
        // stored, so do not call the restore "not persisted".
        setErrorMessage(
          applied.indeterminate
            ? `Vault decrypted, but the saved ledger could not be verified. ${applied.error}`
            : `Vault decrypted but the restore was not persisted: ${applied.error}`
        );
        return;
      }

      // Gate guidance immediately after the ledger commit, before any settings
      // read/apply await. A slow or failed profile apply can never leave the new
      // ledger briefly usable with old/default assumptions.
      onSettingsRecovery({
        status: "missing",
        message:
          "Ledger restored. Confirming its financial settings before spending guidance is shown.",
        reviewToken,
      });

      const missingMessage =
        "Ledger restored, but this vault has no saved financial settings. The reserve, plan window, risk assumptions, and budget targets were not recovered.";
      const missingWithSavedSettings =
        "Ledger restored. This vault has no saved financial settings; the settings already saved in this browser were kept but must be reviewed for this ledger before spending guidance is shown.";
      if (profileOutcome?.status === "found") {
        // Remember ancestry for any authenticated parsed profile, even when its
        // ledger binding is legacy or mismatched. The revision CAS still protects
        // pushes, but an explicit review can then re-pair this browser instead of
        // being stuck behind an unrecorded base. Never regress a newer ancestry
        // observed by a racing pull.
        const profileStorage = browserStorage();
        const knownProfileRevision = readSettingsProfileRevision(
          profileStorage,
          profileOutcome.profileVaultId
        );
        if (knownProfileRevision === null || profileOutcome.revision >= knownProfileRevision.baseRevision) {
          rememberSettingsProfileRevision(
            profileStorage,
            profileOutcome.profileVaultId,
            profileOutcome.revision,
            profileOutcome.profile.savedAt
          );
        }
        const profileRevision = profileOutcome.profile.ledgerRevision;
        if (profileRevision === undefined) {
          // A legacy profile has no binding. It is never auto-applied; the guard
          // stays until the person reviews and saves the settings explicitly.
          onSettingsRecovery({
            status: "missing",
            message:
              "Ledger restored, but its financial settings came from an older profile with no ledger binding and were not applied. Review the plan window and reserve before spending guidance is shown.",
            reviewToken,
          });
          setStatusMessage(`Ledger restored (rev ${revision}), but its financial settings are from an older profile with no ledger binding. Review them before spending guidance is shown.`);
          return;
        }
        if (profileRevision !== revision) {
          // Never apply settings authored for a different ledger generation.
          onSettingsRecovery({
            status: "missing",
            message:
              `Ledger restored, but its financial settings were saved for ledger revision ${profileRevision}, not the restored revision ${revision}, so they were not applied. Review the plan window and reserve before spending guidance is shown.`,
            reviewToken,
          });
          setStatusMessage(`Ledger restored at revision ${revision}, but its financial settings are bound to ledger revision ${profileRevision}. Review them before spending guidance is shown.`);
          return;
        }
        const resolution = await resolveSettingsReview(
          {
            token: reviewToken,
            apply: async () => {
              const error = await onApplyRecoveredSettings(profileOutcome.profile);
              return error ? { ok: false, error } : { ok: true };
            },
          },
          browserStorage()
        );
        if (resolution.applied && resolution.cleared) {
          const message = `Recovered financial settings: ${describeRecoveredSettings(profileOutcome.profile)}.`;
          onSettingsRecovery({ status: "applied", message });
          setStatusMessage(`Successfully pulled, decrypted and saved vault (rev ${revision})! ${message}`);
          return;
        }
        if (resolution.superseded) {
          // Do not adopt a newer guard/token here and do not apply this older
          // profile over it. The pending gate stays; reloading loads the ledger
          // and guard that actually won.
          onSettingsRecovery({
            status: "missing",
            message:
              "A newer vault restore replaced this one. Reload to review the current ledger and financial settings before spending guidance is shown.",
            reviewToken,
          });
          setStatusMessage(`Ledger restore (rev ${revision}) was superseded by a newer change. Reload to review the current vault.`);
          return;
        }
        const message = resolution.applied
          ? `Ledger restored and financial settings were saved, but the review marker could not be cleared: ${resolution.error ?? "storage failure"}`
          : `Ledger restored, but its recovered financial settings could not be saved: ${resolution.error ?? "storage failure"}`;
        onSettingsRecovery({
          status: "missing",
          message,
          reviewToken: resolution.current?.token ?? reviewToken,
        });
        setStatusMessage(`Ledger restored (rev ${revision}), but financial settings need review before spending guidance is shown.`);
      } else if (profileOutcome?.status === "missing") {
        // Keeping locally saved settings is never enough on its own: they were
        // saved against some other ledger view and must be reviewed explicitly.
        onSettingsRecovery({
          status: "missing",
          message: hasSavedDecisionSettings ? missingWithSavedSettings : missingMessage,
          reviewToken,
        });
        setStatusMessage(`Successfully pulled, decrypted and saved vault (rev ${revision})! Financial settings need review before spending guidance is shown.`);
      } else {
        const detail = profileError
          ?? (profileOutcome?.status === "unreadable" ? profileOutcome.error : "settings were unavailable");
        const message = hasSavedDecisionSettings
          ? `Ledger restored, but its saved financial settings could not be read (${detail}). The settings already saved in this browser were kept but must be reviewed for this ledger before spending guidance is shown.`
          : `Ledger restored, but its financial settings could not be recovered (${detail}).`;
        onSettingsRecovery({ status: "missing", message, reviewToken });
        setStatusMessage(`Successfully pulled, decrypted and saved vault (rev ${revision})! Financial settings need review before spending guidance is shown.`);
      }
    } catch (err: unknown) {
      if (!isCurrent(id, controller)) return;
      if (err instanceof VaultLocalChangesError && !allowOverwriteLocal) {
        setPendingConflict(target);
        setErrorMessage(describeError(err));
      } else {
        setErrorMessage(
          describeError(err) || "Failed to pull from vault. Check passphrase."
        );
      }
    } finally {
      finishOperation(id);
    }
  };

  const handlePullFromCloud = () => {
    if (recoveryRequired || activeOperationRef.current) return;
    if (!vaultId.trim() || !passphrase.trim()) {
      setStatusMessage(null);
      setErrorMessage("Please enter both Vault ID and Passphrase.");
      return;
    }
    // Capture the exact snapshot visible when the user authorized this pull. If
    // another tab edits while the request is in flight, the lock comparison fails.
    void runPull(
      {
        vaultId: vaultId.trim(),
        passphrase,
        expectedRaw: currentStoredRaw,
      },
      false
    );
  };

  const handleConfirmOverwrite = () => {
    if (recoveryRequired || !pendingConflict || activeOperationRef.current) return;
    // Reuse the captured target/authorization. Confirmation must not silently apply
    // to a different vault or to a ledger snapshot the user did not see.
    void runPull(pendingConflict, true);
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const input = e.currentTarget;
    // Reset immediately so choosing the same file again still fires a change event.
    input.value = "";
    if (!file || recoveryRequired || activeOperationRef.current) return;

    const { id, controller } = startOperation("import", true);
    if (!controller) return;
    setStatusMessage(null);
    setErrorMessage(null);
    setPendingConflict(null);
    const expectedRaw = currentStoredRaw;

    const reader = new FileReader();
    fileReaderRef.current = reader;
    reader.onload = async (event) => {
      if (!isCurrent(id, controller)) return;
      let replacing = false;
      let indeterminate = false;
      try {
        const parsed = JSON.parse(event.target?.result as string);
        const validated = parseLedgerState(parsed);
        if (!validated.ok) {
          throw new Error(validated.error);
        }
        // Validation happens before any replace. Both messages are cleared so an
        // older success cannot sit beside a rejection (or vice versa).
        replacing = true;
        const applied = await onApplyState(validated.state, {
          expectedRaw,
          signal: controller.signal,
          requireLock: true,
        });
        if (!isCurrent(id, controller)) return;
        if (!applied.ok) {
          indeterminate = applied.indeterminate === true;
          throw new Error(applied.error);
        }
        setErrorMessage(null);
        setStatusMessage("Successfully imported ledger backup file!");
      } catch (err: unknown) {
        if (!isCurrent(id, controller)) return;
        setStatusMessage(null);
        // Validation/cancellation failures never wrote; only an indeterminate
        // persistence result may describe the replace as partly or fully stored.
        setErrorMessage(
          indeterminate
            ? `Import result is uncertain. ${describeError(err)}`
            : (replacing ? "Import could not be saved: " : "Import rejected (your current ledger is unchanged): ") +
                describeError(err)
        );
      } finally {
        finishOperation(id);
      }
    };
    reader.onerror = () => {
      if (!isCurrent(id, controller)) return;
      setStatusMessage(null);
      setErrorMessage(
        "Import rejected (your current ledger is unchanged): the file could not be read."
      );
      finishOperation(id);
    };
    reader.readAsText(file);
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby="sync-title"
      onCancel={(event) => {
        event.preventDefault();
        handleClose();
      }}
      className="m-auto max-h-[90vh] w-[calc(100%_-_2rem)] max-w-lg overflow-y-auto rounded-2xl border border-line bg-surface p-5 text-ink shadow-card backdrop:bg-ink/50"
    >
        <div className="mb-4 flex items-center justify-between border-b border-line pb-3">
          <div className="flex items-center gap-2">
            <Cloud className="h-4 w-4 text-accent" />
            <h3 id="sync-title" className="text-base font-semibold">
              Cloud Vault & CLI Synchronization
            </h3>
          </div>
          <button
            type="button"
            onClick={handleClose}
            aria-label="Close synchronization"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-lg text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="mb-4 flex flex-wrap gap-2 border-b border-line text-sm">
          <button
            onClick={() => setTab("cloud")}
            className={`min-h-11 pb-2 px-3 font-semibold border-b-2 transition ${
              tab === "cloud"
                ? "border-accent text-accent"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            Encrypted vault
          </button>
          <button
            onClick={() => setTab("cli")}
            className={`min-h-11 pb-2 px-3 font-semibold border-b-2 transition ${
              tab === "cli"
                ? "border-accent text-accent"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            Python CLI Commands
          </button>
          <button
            onClick={() => setTab("file")}
            className={`min-h-11 pb-2 px-3 font-semibold border-b-2 transition ${
              tab === "file"
                ? "border-accent text-accent"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            Local JSON Backup
          </button>
        </div>

        <div role="status">
          {statusMessage && (
            <div className="mb-4 flex items-center gap-2 rounded-xl border border-positive bg-positive-soft p-3 text-sm text-ink">
              <Check className="h-4 w-4 shrink-0 text-positive" />
              <span>{statusMessage}</span>
            </div>
          )}
        </div>

        {(errorMessage || recoveryRequired) && (
          <div
            role="alert"
            className={`mb-4 flex items-start gap-2 rounded-xl border p-3 text-sm text-ink ${
              recoveryRequired ? "border-warning bg-warning-soft" : "border-danger bg-danger-soft"
            }`}
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <p>{errorMessage ?? "The saved ledger could not be verified. Some or all of the last change may have persisted."}</p>
              {recoveryRequired && (
                <p className="mt-2">
                  Close Sync to keep a copy of the previous ledger and any drafts before reloading. Sync is
                  paused in this tab until you reload to check the saved ledger.
                </p>
              )}
            </div>
          </div>
        )}

        {/* Tab 1: Cloud Vault Form */}
        {tab === "cloud" && (
          <div className="space-y-4 text-xs">
            <p className="text-muted">
              Sync is optional. Your browser encrypts the ledger before sending it. The vault service handles the
              encrypted snapshot, vault ID, and sync metadata. It does not receive your passphrase or encryption key.
            </p>
            <p className="text-ink">
              A pull replaces the ledger in this browser. When the vault has them, it also applies the saved financial
              settings: your plan window, reserve, risk assumptions, and budget targets. To keep a copy of the current
              ledger, close Sync and use Export in the header first. Applying a replacement also clears unsaved values
              in any open form draft in this tab. A vault created by an older client may have no settings profile; the
              app then withholds spending guidance until you review the settings instead of assuming zero reserve.
              Android-only data needs a separate native backup.
            </p>
            <p className="text-muted">
              A push sends the settings currently shown in this browser with the ledger. The settings object is
              encrypted separately with the same passphrase. It is not part of the portable ledger snapshot, so
              Python and Android ledgers remain readable without it.
            </p>
            <p className="text-muted">
              Sample data cannot be pushed as your ledger. Enter your own numbers from Home first.
              After a successful push this browser remembers the Vault ID, but never the passphrase.
              Before clearing browser data or moving to another device, record the Vault ID and
              passphrase separately in a safe place outside this browser. You need both to pull the
              encrypted snapshot into a new profile.
            </p>

            <div>
              <label htmlFor="sync-vault-id" className="block text-ink font-medium mb-1">Vault Identifier</label>
              <input
                id="sync-vault-id"
                type="text"
                placeholder="e.g. personal-budget-vault"
                value={vaultId}
                disabled={isLoading}
                onChange={(e) => changeVaultTarget(() => setVaultId(e.target.value))}
                className="min-h-11 w-full px-3 py-2 rounded-lg bg-inset border border-line text-ink focus:outline-none focus:border-accent"
              />
            </div>

            <div>
              <label htmlFor="sync-passphrase" className="block text-ink font-medium mb-1">
                Vault Secret Passphrase
              </label>
              <input
                id="sync-passphrase"
                type="password"
                placeholder="Enter secret passphrase"
                value={passphrase}
                disabled={isLoading}
                onChange={(e) => changeVaultTarget(() => setPassphrase(e.target.value))}
                className="min-h-11 w-full px-3 py-2 rounded-lg bg-inset border border-line text-ink focus:outline-none focus:border-accent"
              />
            </div>

            <div className="grid grid-cols-2 gap-3 pt-2">
              <button
                onClick={handlePushToCloud}
                disabled={isLoading || recoveryRequired}
                className="flex min-h-11 items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-accent hover:opacity-90 disabled:opacity-50 text-on-accent font-semibold transition"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>{activeOperation === "push" ? "Encrypting..." : "Push (Upload)"}</span>
              </button>

              <button
                onClick={handlePullFromCloud}
                disabled={isLoading || recoveryRequired}
                className="flex min-h-11 items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-inset hover:bg-surface disabled:opacity-50 text-ink font-semibold border border-line transition"
              >
                <Download className="w-3.5 h-3.5" />
                <span>{activeOperation === "pull" ? "Decrypting..." : "Pull (Download)"}</span>
              </button>
            </div>

            {pendingConflict && (
              <div className="space-y-2 rounded-xl border border-warning bg-warning-soft p-3">
                <p className="text-ink">
                  This device has ledger edits that were never synchronized. Pulling now
                  would replace them. Close this dialog and export a backup from the header
                  first, then reopen Sync and pull again before confirming.
                </p>
                <button
                  onClick={handleConfirmOverwrite}
                  disabled={isLoading || recoveryRequired}
                  className="min-h-11 rounded-lg bg-accent px-3 py-2 font-semibold text-on-accent disabled:opacity-50"
                >
                  Replace local ledger with the vault
                </button>
              </div>
            )}
          </div>
        )}

        {/* Tab 2: CLI Instructions */}
        {tab === "cli" && (
          <div className="space-y-3 text-xs">
            <p className="text-muted">
              Run these commands in your local Python checkout to connect your terminal ledger to this Web UI:
            </p>

            <div className="rounded-xl bg-inset p-3 font-mono text-[11px] text-accent space-y-2 border border-line overflow-x-auto">
              <div className="text-muted"># 1. Pair this vault (prompts for the passphrase; never put it in argv):</div>
              <div>python -m monte_carlo_ledger sync init {vaultId}</div>
              <div className="text-muted">#    or, in unattended scripts:</div>
              <div>MC_LEDGER_SYNC_PASSPHRASE=... python -m monte_carlo_ledger sync init {vaultId}</div>

              <div className="text-muted pt-1"># 2. Push local SQLite ledger to cloud vault:</div>
              <div>python -m monte_carlo_ledger sync push</div>

              <div className="text-muted pt-1"># 3. Pull latest changes into local SQLite:</div>
              <div>python -m monte_carlo_ledger sync pull</div>

              <div className="text-muted pt-1"># Existing vaults are joined, not overwritten; the Web UI and CLI share one KDF salt.</div>
            </div>
          </div>
        )}

        {/* Tab 3: Local JSON File */}
        {tab === "file" && (
          <div className="space-y-4 text-xs">
            <p className="text-muted">
              Close this dialog, then export from the header to save an unencrypted ledger file. Keep it private.
              Importing a valid file here replaces this ledger and clears unsaved values in any open form draft.
              Budget targets and forecast settings are not in the ledger file; use the encrypted vault to move them
              between devices, and keep a separate record of them with any file-only backup.
            </p>

            <label className="flex flex-col items-center justify-center border-2 border-dashed border-line hover:border-accent focus-within:outline focus-within:outline-accent rounded-xl p-6 cursor-pointer bg-inset hover:bg-inset transition">
              <Upload className="w-6 h-6 text-muted mb-2" />
              <span className="font-semibold text-ink">
                {activeOperation === "import" ? "Reading backup…" : "Click to select backup JSON file"}
              </span>
              <span className="text-[11px] text-muted mt-1">Accepts canonical .json snapshot</span>
              <input
                type="file"
                accept=".json"
                onChange={handleImportFile}
                disabled={isLoading || recoveryRequired}
                className="sr-only"
              />
            </label>
          </div>
        )}
    </dialog>
  );
}
