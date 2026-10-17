"use client";

import React, { useState } from "react";
import { X, Cloud, Lock, Terminal, Upload, Download, Check, AlertCircle, RefreshCw } from "lucide-react";
import { deriveVaultKeys, encryptVault, decryptVault } from "@/lib/crypto";
import { LedgerState } from "@/lib/types";

interface SyncModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentState: LedgerState;
  onApplyState: (nextState: LedgerState, vaultId?: string) => void;
  currentVaultId?: string;
}

export function SyncModal({
  isOpen,
  onClose,
  currentState,
  onApplyState,
  currentVaultId,
}: SyncModalProps) {
  const [tab, setTab] = useState<"cloud" | "file" | "cli">("cloud");

  // Cloud Sync form
  const [vaultId, setVaultId] = useState(currentVaultId || "my-ledger-vault");
  const [passphrase, setPassphrase] = useState("");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

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
      // 1. Derive zero-knowledge keys in browser
      const { authToken, encKey, saltB64 } = await deriveVaultKeys(passphrase);

      // 2. Encrypt state in browser via AES-GCM
      const plaintext = JSON.stringify(currentState);
      const { ciphertext_b64, nonce_b64 } = await encryptVault(plaintext, encKey);

      // 3. Try PUT first (update existing), if 404 try POST (create new)
      let res = await fetch(`/api/vault/${encodeURIComponent(vaultId)}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify({
          ciphertext_b64,
          nonce_b64,
          kdf_salt_b64: saltB64,
        }),
      });

      if (res.status === 404) {
        // Vault doesn't exist yet, create with POST
        res = await fetch("/api/vault", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            vault_id: vaultId,
            auth_token: authToken,
            ciphertext_b64,
            nonce_b64,
            kdf_salt_b64: saltB64,
          }),
        });
      }

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to push to cloud vault");
      }

      setStatusMessage(`Successfully pushed encrypted snapshot to Cloud Vault (rev ${data.revision})!`);
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to push to vault.");
    } finally {
      setIsLoading(false);
    }
  };

  const handlePullFromCloud = async () => {
    if (!vaultId.trim() || !passphrase.trim()) {
      setErrorMessage("Please enter both Vault ID and Passphrase.");
      return;
    }
    setIsLoading(true);
    setErrorMessage(null);
    setStatusMessage(null);

    try {
      // 1. Fetch encrypted record from server
      const { authToken } = await deriveVaultKeys(passphrase);
      const res = await fetch(`/api/vault/${encodeURIComponent(vaultId)}`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to pull from vault");
      }

      // 2. Derive encryption key using salt stored in vault record
      const { encKey } = await deriveVaultKeys(passphrase, data.kdf_salt_b64);

      // 3. Decrypt ciphertext locally in browser
      const decryptedJson = await decryptVault(data.ciphertext_b64, data.nonce_b64, encKey);
      const parsedState: LedgerState = JSON.parse(decryptedJson);

      onApplyState(parsedState, vaultId);
      setStatusMessage(`Successfully pulled and decrypted vault (rev ${data.revision})!`);
    } catch (err: any) {
      setErrorMessage(err.message || "Failed to pull from vault. Check passphrase.");
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
        if (!parsed.current_balance_cents || !Array.isArray(parsed.incomes)) {
          throw new Error("Invalid ledger backup format");
        }
        onApplyState(parsed);
        setStatusMessage("Successfully imported ledger backup file!");
      } catch (err: any) {
        setErrorMessage("Failed to parse JSON file: " + err.message);
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl max-w-lg w-full p-6 text-slate-100">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3 mb-4">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-indigo-500/20 text-indigo-400">
              <Cloud className="w-4 h-4" />
            </div>
            <h3 className="font-bold text-sm tracking-wide">
              Cloud Vault & CLI Synchronization (Option C)
            </h3>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-slate-200 transition"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex border-b border-slate-800 text-xs mb-4">
          <button
            onClick={() => setTab("cloud")}
            className={`pb-2 px-3 font-semibold border-b-2 transition ${
              tab === "cloud"
                ? "border-indigo-500 text-indigo-400"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            Encrypted Vault (Option C)
          </button>
          <button
            onClick={() => setTab("cli")}
            className={`pb-2 px-3 font-semibold border-b-2 transition ${
              tab === "cli"
                ? "border-indigo-500 text-indigo-400"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            Python CLI Commands
          </button>
          <button
            onClick={() => setTab("file")}
            className={`pb-2 px-3 font-semibold border-b-2 transition ${
              tab === "file"
                ? "border-indigo-500 text-indigo-400"
                : "border-transparent text-slate-400 hover:text-slate-200"
            }`}
          >
            Local JSON Backup
          </button>
        </div>

        {statusMessage && (
          <div className="mb-4 p-3 rounded-xl bg-emerald-950/40 border border-emerald-500/30 text-emerald-300 text-xs flex items-center gap-2">
            <Check className="w-4 h-4 text-emerald-400 shrink-0" />
            <span>{statusMessage}</span>
          </div>
        )}

        {errorMessage && (
          <div className="mb-4 p-3 rounded-xl bg-rose-950/40 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{errorMessage}</span>
          </div>
        )}

        {/* Tab 1: Cloud Vault Form */}
        {tab === "cloud" && (
          <div className="space-y-4 text-xs">
            <p className="text-slate-400">
              Synchronize your ledger with zero-knowledge end-to-end encryption. The cloud database
              (Turso) only receives ciphertext. Your encryption key is derived locally and never sent over the network.
            </p>

            <div>
              <label className="block text-slate-300 font-medium mb-1">Vault Identifier</label>
              <input
                type="text"
                placeholder="e.g. personal-budget-vault"
                value={vaultId}
                onChange={(e) => setVaultId(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div>
              <label className="block text-slate-300 font-medium mb-1">
                Vault Secret Passphrase
              </label>
              <input
                type="password"
                placeholder="Enter secret passphrase"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                className="w-full px-3 py-2 rounded-lg bg-slate-800 border border-slate-700 text-slate-100 focus:outline-none focus:border-indigo-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-3 pt-2">
              <button
                onClick={handlePushToCloud}
                disabled={isLoading}
                className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-semibold transition"
              >
                <Upload className="w-3.5 h-3.5" />
                <span>{isLoading ? "Encrypting..." : "Push (Upload)"}</span>
              </button>

              <button
                onClick={handlePullFromCloud}
                disabled={isLoading}
                className="flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-200 font-semibold border border-slate-700 transition"
              >
                <Download className="w-3.5 h-3.5" />
                <span>{isLoading ? "Decrypting..." : "Pull (Download)"}</span>
              </button>
            </div>
          </div>
        )}

        {/* Tab 2: CLI Instructions */}
        {tab === "cli" && (
          <div className="space-y-3 text-xs">
            <p className="text-slate-400">
              Run these commands in your local Python checkout to connect your terminal ledger to this Web UI:
            </p>

            <div className="rounded-xl bg-slate-950 p-3 font-mono text-[11px] text-indigo-300 space-y-2 border border-slate-800 overflow-x-auto">
              <div className="text-slate-500"># 1. Initialize local vault pairing:</div>
              <div>python -m monte_carlo_ledger sync init &quot;{vaultId}&quot; &quot;&lt;passphrase&gt;&quot;</div>

              <div className="text-slate-500 pt-1"># 2. Push local SQLite ledger to cloud vault:</div>
              <div>python -m monte_carlo_ledger sync push</div>

              <div className="text-slate-500 pt-1"># 3. Pull latest changes into local SQLite:</div>
              <div>python -m monte_carlo_ledger sync pull</div>
            </div>
          </div>
        )}

        {/* Tab 3: Local JSON File */}
        {tab === "file" && (
          <div className="space-y-4 text-xs">
            <p className="text-slate-400">
              Import or export an unencrypted JSON backup directly to disk without using any network connection:
            </p>

            <label className="flex flex-col items-center justify-center border-2 border-dashed border-slate-700 hover:border-cyan-500/50 rounded-xl p-6 cursor-pointer bg-slate-800/20 hover:bg-slate-800/40 transition">
              <Upload className="w-6 h-6 text-slate-400 mb-2" />
              <span className="font-semibold text-slate-300">Click to select backup JSON file</span>
              <span className="text-[11px] text-slate-500 mt-1">Accepts canonical .json snapshot</span>
              <input type="file" accept=".json" onChange={handleImportFile} className="hidden" />
            </label>
          </div>
        )}
      </div>
    </div>
  );
}
