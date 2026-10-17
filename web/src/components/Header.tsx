"use client";

import React from "react";
import { Cloud, ShieldCheck, Download, RefreshCw, Sparkles, Terminal } from "lucide-react";

interface HeaderProps {
  isSynced: boolean;
  vaultId?: string;
  onOpenSync: () => void;
  onResetDemo: () => void;
  onExportJson: () => void;
}

export function Header({
  isSynced,
  vaultId,
  onOpenSync,
  onResetDemo,
  onExportJson,
}: HeaderProps) {
  return (
    <header className="border-b border-slate-800/80 bg-slate-900/60 backdrop-blur-md sticky top-0 z-30 px-4 sm:px-8 py-3.5 flex flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-cyan-500 to-indigo-600 flex items-center justify-center shadow-lg shadow-cyan-500/20 text-white font-bold text-lg tracking-wider">
          MC
        </div>
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold text-slate-100 tracking-tight">
              MonteCarlo Ledger
            </h1>
            <span className="text-xs px-2 py-0.5 rounded-full bg-cyan-500/10 text-cyan-400 border border-cyan-500/20 font-medium">
              Contract 2.0
            </span>
          </div>
          <p className="text-xs text-slate-400 hidden sm:block">
            Deterministic cash-flow timeline with stochastic Monte Carlo risk overlay
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 text-xs font-medium">
          <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
          <span>Zero-Knowledge / 100% Client-Side</span>
        </div>

        <button
          onClick={onOpenSync}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600/20 hover:bg-indigo-600/30 text-indigo-300 border border-indigo-500/30 text-xs font-semibold transition"
          title="Connect with Turso Cloud Vault or CLI"
        >
          <Cloud className="w-3.5 h-3.5" />
          <span>{isSynced ? `Vault: ${vaultId}` : "Cloud Vault (Option C)"}</span>
        </button>

        <button
          onClick={onExportJson}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium transition"
          title="Export canonical JSON backup"
        >
          <Download className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Export</span>
        </button>

        <button
          onClick={onResetDemo}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 text-xs font-medium transition"
          title="Reset to sample demo ledger"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Reset Demo</span>
        </button>
      </div>
    </header>
  );
}
