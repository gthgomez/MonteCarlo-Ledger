"use client";

import React from "react";
import { TrendingDown, ShieldAlert, Wallet, Sparkles, AlertCircle, ArrowUpRight } from "lucide-react";

interface SafeSpendHeroProps {
  currentBalanceCents: number;
  safeSpendCents: number;
  projectedLowCents: number;
  projectedLowDate: string;
  endingBalanceCents: number;
  overdraftPpm: number;
  firstNegativeDate: string | null;
}

export function formatMoney(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents) / 100;
  return `${sign}$${abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function SafeSpendHero({
  currentBalanceCents,
  safeSpendCents,
  projectedLowCents,
  projectedLowDate,
  endingBalanceCents,
  overdraftPpm,
  firstNegativeDate,
}: SafeSpendHeroProps) {
  const overdraftPct = (overdraftPpm / 10000).toFixed(1);
  const isOverdraftDanger = overdraftPpm > 10000 || projectedLowCents < 0;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {/* 1. Safe to Spend Hero */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-indigo-950/40 via-slate-900/60 to-slate-900/40 border border-indigo-500/30 p-5 shadow-xl shadow-indigo-950/20">
        <div className="flex items-center justify-between text-indigo-300 mb-2">
          <span className="text-xs font-semibold uppercase tracking-wider">
            Safe to Spend (P10)
          </span>
          <div className="p-1.5 rounded-lg bg-indigo-500/10 text-indigo-400">
            <Sparkles className="w-4 h-4" />
          </div>
        </div>
        <div className="text-3xl font-extrabold text-white tracking-tight">
          {formatMoney(safeSpendCents)}
        </div>
        <p className="text-xs text-slate-400 mt-2">
          Conservative quantile trough. 90% of Monte Carlo runs remained above this floor.
        </p>
      </div>

      {/* 2. Projected Low Point */}
      <div className="rounded-2xl bg-slate-900/50 border border-slate-800/80 p-5">
        <div className="flex items-center justify-between text-slate-400 mb-2">
          <span className="text-xs font-semibold uppercase tracking-wider">
            Projected Trough
          </span>
          <div className="p-1.5 rounded-lg bg-slate-800 text-slate-300">
            <TrendingDown className="w-4 h-4" />
          </div>
        </div>
        <div
          className={`text-2xl font-bold tracking-tight ${
            projectedLowCents < 0 ? "text-rose-400" : "text-slate-100"
          }`}
        >
          {formatMoney(projectedLowCents)}
        </div>
        <p className="text-xs text-slate-400 mt-2">
          Deterministic low point on <span className="text-slate-300 font-medium">{projectedLowDate}</span>
        </p>
      </div>

      {/* 3. Current Account Balance */}
      <div className="rounded-2xl bg-slate-900/50 border border-slate-800/80 p-5">
        <div className="flex items-center justify-between text-slate-400 mb-2">
          <span className="text-xs font-semibold uppercase tracking-wider">
            Current Balance
          </span>
          <div className="p-1.5 rounded-lg bg-slate-800 text-slate-300">
            <Wallet className="w-4 h-4" />
          </div>
        </div>
        <div className="text-2xl font-bold text-slate-100 tracking-tight">
          {formatMoney(currentBalanceCents)}
        </div>
        <p className="text-xs text-slate-400 mt-2 flex items-center gap-1">
          <span>90-day ending balance:</span>
          <span className="text-slate-300 font-medium">
            {formatMoney(endingBalanceCents)}
          </span>
        </p>
      </div>

      {/* 4. Overdraft Stress Test */}
      <div
        className={`rounded-2xl border p-5 ${
          isOverdraftDanger
            ? "bg-rose-950/20 border-rose-500/30 text-rose-300"
            : "bg-emerald-950/20 border-emerald-500/30 text-emerald-300"
        }`}
      >
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold uppercase tracking-wider">
            Overdraft Chance
          </span>
          <div
            className={`p-1.5 rounded-lg ${
              isOverdraftDanger ? "bg-rose-500/20 text-rose-400" : "bg-emerald-500/20 text-emerald-400"
            }`}
          >
            {isOverdraftDanger ? (
              <AlertCircle className="w-4 h-4" />
            ) : (
              <ShieldAlert className="w-4 h-4" />
            )}
          </div>
        </div>
        <div className="text-2xl font-bold tracking-tight">
          {overdraftPct}%
        </div>
        <p className="text-xs text-slate-400 mt-2">
          {firstNegativeDate
            ? `First negative on ${firstNegativeDate}`
            : "No negative balance detected in baseline forecast"}
        </p>
      </div>
    </div>
  );
}
