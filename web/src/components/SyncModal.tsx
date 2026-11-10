"use client";

import React, { useEffect, useState } from "react";
import { X, Cloud, Lock, Terminal, Upload, Download, Check, AlertCircle, RefreshCw } from "lucide-react";
import {
  pushVault,
  pullVault,
  VaultLocalChangesError,
} from "@/lib/vault-client";
import { LedgerState } from "@/lib/types";
import { parseLedgerState } from "@/lib/validate";
import { PersistenceResult } from "@/lib/sync-state";

interface SyncModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentState: LedgerState;
  onApplyState: (
    nextState: LedgerState,
    vaultId?: string,
    syncRevision?: number
  ) => PersistenceResult;
  currentVaultId?: string;
}

/** An unguessable default vault id (the metadata endpoint reveals existence). */
function randomVaultId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `vault-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export function SyncModal({
  isOpen,
  onClose,
  currentState,
  onApplyState,
  currentVaultId,
}: SyncModalProps) {
  const [tab, setTab] = useState<"cloud" | "file" | "cli">("cloud");

  // Cloud Sync form. The default id is random so vaults are not enumerable.
  const [vaultId, setVaultId] = useState(() => currentVaultId || randomVaultId());
  const [passphrase, setPassphrase] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [pullConflict, setPullConflict] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handlePushToCloud = async () => {
    if (!vaultId.trim() || !passphrase.trim()) {
      setErrorMessage("Please enter both Vault ID and Passphrase.");
      return;
    }
    setIsLoading(true);
    setErrorMessage(null);
    setStatusMessage(null);

    try {
      // Salt discovery happens inside pushVault: an existing vault is always
      // authenticated with its stored KDF salt, never a freshly generated one.
      // The push is based on this device's recorded revision, never the latest one.
      const { revision, ancestryPersisted } = await pushVault(
        vaultId.trim(),
        passphrase,
        currentState
      );
      setStatusMessage(
        ancestryPersisted
          ? `Successfully pushed encrypted snapshot to Cloud Vault (rev ${revision})!`
          : `Pushed to Cloud Vault (rev ${revision}), but the local sync ancestry could not be saved. Pull before the next push.`
      );
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to push to vault.");
    } finally {
      setIsLoading(false);
    }
  };

  const handlePullFromCloud = async (allowOverwriteLocal = false) => {
    if (!vaultId.trim() || !passphrase.trim()) {
      setErrorMessage("Please enter both Vault ID and Passphrase.");
      return;
    }
    setIsLoading(true);
    setErrorMessage(null);
    setStatusMessage(null);
    setPullConflict(false);

    try {
      const { state, revision } = await pullVault(
        vaultId.trim(),
        passphrase,
        currentState,
        { allowOverwriteLocal }
      );
      // Do not claim success unless the browser durably stored the restored ledger.
      const applied = onApplyState(state, vaultId.trim(), revision);
      if (!applied.ok) {
        setErrorMessage(
          `Vault decrypted but the restore was not persisted: ${applied.error}`
        );
        return;
      }
      setStatusMessage(`Successfully pulled, decrypted and saved vault (rev ${revision})!`);
    } catch (err: any) {
      if (err instanceof VaultLocalChangesError && !allowOverwriteLocal) {
        setPullConflict(true);
        setErrorMessage(err.message);
      } else {
        setErrorMessage(err.message || "Failed to pull from vault. Check passphrase.");
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed = JSON.parse(event.target?.result as string);
        const validated = parseLedgerState(parsed);
        if (!validated.ok) {
          throw new Error(validated.error);
        }
        const applied = onApplyState(validated.state);
        if (!applied.ok) {
          throw new Error(applied.error);
        }
        setStatusMessage("Successfully imported ledger backup file!");
      } catch (err: any) {
        setErrorMessage("Import rejected (your current ledger is unchanged): " + err.message);
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/50 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sync-title"
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-line bg-surface p-5 text-ink shadow-card"
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
            onClick={onClose}
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

        {statusMessage && (
          <div className="mb-4 flex items-center gap-2 rounded-xl border border-positive bg-positive-soft p-3 text-sm text-ink">
            <Check className="h-4 w-4 shrink-0 text-positive" />
            <span>{statusMessage}</span>
          </div>
        )}

        {errorMessage && (
          <div className="mb-4 flex items-center gap-2 rounded-xl border border-danger bg-danger-soft p-3 text-sm text-ink">
            <AlertCircle className="h-4 w-4 shrink-0 text-danger" />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Tab 1: Cloud Vault Form */}
        {tab === "cloud" && (
          <div className="space-y-4 text-xs">
            <p className="text-muted">
              Synchronize your ledger with zero-knowledge end-to-end encryption. The cloud database
              (Turso) only receives ciphertext. Your encryption key is derived locally and never sent over the network.
            </p>

            <div>
              <label className="block text-ink font-medium mb-1">Vault Identifier</label>
              <input
                type="text"
                placeholder="e.g. personal-budget-vault"
                value={vaultId}
                onChange={(e) => setVaultId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-inset border border-line text-ink focus:outline-none focus:border-accent"
              />
            </div>

            <div>
              <label className="block text-ink font-medium mb-1">
                Vault Secret Passphrase
              </label>
              <input
                type="password"
                placeholder="Enter secret passphrase"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
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
                <span>{isLoading ? "Encrypting..." : "Push (Upload)"}</span>
              </button>

              <button
                onClick={() => handlePullFromCloud(false)}
                disabled={isLoading}
                className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-inset hover:bg-surface disabled:opacity-50 text-ink font-semibold border border-line transition"
              >
                <Download className="w-3.5 h-3.5" />
                <span>{isLoading ? "Decrypting..." : "Pull (Download)"}</span>
              </button>
            </div>

            {pullConflict && (
              <div className="space-y-2 rounded-xl border border-warning bg-warning-soft p-3">
                <p className="text-ink">
                  This device has ledger edits that were never synchronized. Pulling now
                  would replace them. Export a backup from the header first, then confirm.
                </p>
                <button
                  onClick={() => handlePullFromCloud(true)}
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
              Import or export an unencrypted JSON backup directly to disk without using any network connection:
            </p>

            <label className="flex flex-col items-center justify-center border-2 border-dashed border-line hover:border-accent rounded-xl p-6 cursor-pointer bg-inset hover:bg-inset transition">
              <Upload className="w-6 h-6 text-muted mb-2" />
              <span className="font-semibold text-ink">Click to select backup JSON file</span>
              <span className="text-[11px] text-muted mt-1">Accepts canonical .json snapshot</span>
              <input type="file" accept=".json" onChange={handleImportFile} className="hidden" />
            </label>
          </div>
        )}
      </div>
    </div>
  );
}
