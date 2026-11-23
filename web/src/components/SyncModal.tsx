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
  /** Tells the page which vault id was durably remembered after a successful push. */
  onVaultSelected: (vaultId: string) => void;
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

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function SyncModal({
  isOpen,
  onClose,
  currentState,
  currentStoredRaw,
  onApplyState,
  currentVaultId,
  onVaultSelected,
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
    setPendingConflict(null);
    setErrorMessage(null);
    setStatusMessage(null);
  }

  const handlePushToCloud = async () => {
    if (activeOperationRef.current) return;
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
      setStatusMessage(
        problems.length === 0
          ? `Successfully pushed encrypted snapshot to Cloud Vault (rev ${revision})!`
          : `Pushed to Cloud Vault (rev ${revision}), but ${problems.join("; ")}.`
      );
    } catch (err: unknown) {
      if (operationSeq.current !== id) return;
      setErrorMessage(describeError(err) || "Failed to push to vault.");
    } finally {
      finishOperation(id);
    }
  };

  const runPull = async (target: PullTarget, allowOverwriteLocal: boolean) => {
    if (activeOperationRef.current) return;
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
      // Do not claim success unless the browser durably stored the restored ledger.
      // The exact authorized raw snapshot is re-checked under the shared write lock.
      const applied = await onApplyState(state, {
        expectedRaw: target.expectedRaw,
        vaultId: target.vaultId,
        syncRevision: revision,
        signal: controller.signal,
        requireLock: true,
      });
      if (!isCurrent(id, controller)) return;
      if (!applied.ok) {
        setErrorMessage(
          `Vault decrypted but the restore was not persisted: ${applied.error}`
        );
        return;
      }
      setStatusMessage(`Successfully pulled, decrypted and saved vault (rev ${revision})!`);
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
    if (activeOperationRef.current) return;
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
    if (!pendingConflict || activeOperationRef.current) return;
    // Reuse the captured target/authorization. Confirmation must not silently apply
    // to a different vault or to a ledger snapshot the user did not see.
    void runPull(pendingConflict, true);
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const input = e.currentTarget;
    // Reset immediately so choosing the same file again still fires a change event.
    input.value = "";
    if (!file || activeOperationRef.current) return;

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
          throw new Error(applied.error);
        }
        setErrorMessage(null);
        setStatusMessage("Successfully imported ledger backup file!");
      } catch (err: unknown) {
        if (!isCurrent(id, controller)) return;
        setStatusMessage(null);
        setErrorMessage(
          (replacing ? "Import could not be saved: " : "Import rejected (your current ledger is unchanged): ") +
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
            className={`pb-2 px-3 font-semibold border-b-2 transition ${
              tab === "cloud"
                ? "border-accent text-accent"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            Encrypted vault
          </button>
          <button
            onClick={() => setTab("cli")}
            className={`pb-2 px-3 font-semibold border-b-2 transition ${
              tab === "cli"
                ? "border-accent text-accent"
                : "border-transparent text-muted hover:text-ink"
            }`}
          >
            Python CLI Commands
          </button>
          <button
            onClick={() => setTab("file")}
            className={`pb-2 px-3 font-semibold border-b-2 transition ${
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

        {errorMessage && (
          <div role="alert" className="mb-4 flex items-center gap-2 rounded-xl border border-danger bg-danger-soft p-3 text-sm text-ink">
            <AlertCircle className="h-4 w-4 shrink-0 text-danger" />
            <span>{errorMessage}</span>
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
              A pull replaces the ledger in this browser. To keep a copy, close Sync and use Export in the header first.
              Budget targets and forecast settings, including your reserve, stay in this browser and are not
              recovered from the vault. Android-only data needs a separate native backup.
            </p>
            <p className="text-muted">
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
                className="w-full px-3 py-2 rounded-lg bg-inset border border-line text-ink focus:outline-none focus:border-accent"
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
                className="w-full px-3 py-2 rounded-lg bg-inset border border-line text-ink focus:outline-none focus:border-accent"
              />
            </div>

            <div className="grid grid-cols-2 gap-3 pt-2">
              <button
                onClick={handlePushToCloud}
                disabled={isLoading}
                className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-accent hover:opacity-90 disabled:opacity-50 text-on-accent font-semibold transition"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>{activeOperation === "push" ? "Encrypting..." : "Push (Upload)"}</span>
              </button>

              <button
                onClick={handlePullFromCloud}
                disabled={isLoading}
                className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-inset hover:bg-surface disabled:opacity-50 text-ink font-semibold border border-line transition"
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
                  disabled={isLoading}
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
              Importing a valid file here replaces this ledger. Budget targets and forecast settings are not in the file.
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
                disabled={isLoading}
                className="sr-only"
              />
            </label>
          </div>
        )}
    </dialog>
  );
}
