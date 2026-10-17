"use client";

import React, { useState } from "react";
import { formatMoney } from "./SafeSpendHero";

interface TimelineEvent {
  date: string;
  name: string;
  type: string;
  amount_cents: number;
  balance_after_cents: number;
}

interface TimelineChartProps {
  asOf: string;
  startingBalanceCents: number;
  events: TimelineEvent[];
}

export function TimelineChart({ asOf, startingBalanceCents, events }: TimelineChartProps) {
  const [hoveredIdx, setHoveredIdx] = useState<number | null>(null);

  if (!events || events.length === 0) {
    return (
      <div className="rounded-2xl bg-slate-900/50 border border-slate-800/80 p-6 text-center text-slate-400">
        No upcoming events in window.
      </div>
    );
  }

  // Prepend starting point
  const points = [
    {
      date: asOf,
      name: "Today",
      type: "starting",
      amount_cents: 0,
      balance_after_cents: startingBalanceCents,
    },
    ...events,
  ];

  const minBal = Math.min(0, ...points.map((p) => p.balance_after_cents));
  const maxBal = Math.max(100000, ...points.map((p) => p.balance_after_cents));
  const range = maxBal - minBal || 1;

  const width = 800;
  const height = 260;
  const padX = 50;
  const padY = 30;

  const chartW = width - padX * 2;
  const chartH = height - padY * 2;

  const getX = (idx: number) => padX + (idx / (points.length - 1)) * chartW;
  const getY = (bal: number) => padY + chartH - ((bal - minBal) / range) * chartH;

  const polylinePoints = points.map((p, idx) => `${getX(idx)},${getY(p.balance_after_cents)}`).join(" ");

  const zeroY = getY(0);

  return (
    <div className="rounded-2xl bg-slate-900/50 border border-slate-800/80 p-5">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-bold text-slate-100 uppercase tracking-wider">
            90-Day Cash Flow Timeline
          </h2>
          <p className="text-xs text-slate-400">
            Deterministic running balance path across scheduled paydays and bill obligations
          </p>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-1.5 text-emerald-400 font-medium">
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 inline-block" />
            <span>Income Event</span>
          </div>
          <div className="flex items-center gap-1.5 text-rose-400 font-medium">
            <span className="w-2.5 h-2.5 rounded-full bg-rose-400 inline-block" />
            <span>Bill Due</span>
          </div>
          <div className="flex items-center gap-1.5 text-cyan-400 font-medium">
            <span className="w-2.5 h-1 bg-cyan-400 inline-block rounded" />
            <span>Running Balance</span>
          </div>
        </div>
      </div>

      <div className="relative overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="w-full h-auto min-w-[600px] select-none"
        >
          {/* Grid lines */}
          <line
            x1={padX}
            y1={padY}
            x2={width - padX}
            y2={padY}
            stroke="#1e293b"
            strokeDasharray="4 4"
          />
          <line
            x1={padX}
            y1={height - padY}
            x2={width - padX}
            y2={height - padY}
            stroke="#1e293b"
            strokeDasharray="4 4"
          />

          {/* Zero balance danger line */}
          {zeroY >= padY && zeroY <= height - padY && (
            <>
              <line
                x1={padX}
                y1={zeroY}
                x2={width - padX}
                y2={zeroY}
                stroke="#ef4444"
                strokeWidth="1.5"
                strokeDasharray="6 4"
              />
              <text
                x={padX + 6}
                y={zeroY - 6}
                fill="#ef4444"
                fontSize="10"
                fontWeight="600"
              >
                $0.00 Floor (Overdraft Threshold)
              </text>
            </>
          )}

          {/* Balance Path Area Gradient */}
          <defs>
            <linearGradient id="balanceGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.25" />
              <stop offset="100%" stopColor="#06b6d4" stopOpacity="0.0" />
            </linearGradient>
          </defs>

          {/* Area fill */}
          <polygon
            points={`${padX},${height - padY} ${polylinePoints} ${width - padX},${height - padY}`}
            fill="url(#balanceGrad)"
          />

          {/* Main Curve */}
          <polyline
            points={polylinePoints}
            fill="none"
            stroke="#06b6d4"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />

          {/* Event nodes */}
          {points.map((p, idx) => {
            const cx = getX(idx);
            const cy = getY(p.balance_after_cents);
            const isIncome = p.amount_cents > 0;
            const isExpense = p.amount_cents < 0;
            const color = isIncome ? "#10b981" : isExpense ? "#f43f5e" : "#06b6d4";

            return (
              <g
                key={idx}
                className="cursor-pointer transition-transform"
                onMouseEnter={() => setHoveredIdx(idx)}
                onMouseLeave={() => setHoveredIdx(null)}
              >
                <circle
                  cx={cx}
                  cy={cy}
                  r={hoveredIdx === idx ? 6.5 : 4}
                  fill={color}
                  stroke="#0f172a"
                  strokeWidth="2"
                />
              </g>
            );
          })}
        </svg>

        {/* Hover Popover Tooltip */}
        {hoveredIdx !== null && (
          <div
            className="absolute z-20 pointer-events-none rounded-xl bg-slate-900 border border-slate-700 shadow-2xl p-3 text-xs w-48 -translate-x-1/2 -translate-y-full"
            style={{
              left: `${(getX(hoveredIdx) / width) * 100}%`,
              top: `${(getY(points[hoveredIdx].balance_after_cents) / height) * 100}%`,
            }}
          >
            <div className="font-semibold text-slate-200">
              {points[hoveredIdx].name}
            </div>
            <div className="text-slate-400 text-[11px] mb-1">
              {points[hoveredIdx].date}
            </div>
            {points[hoveredIdx].amount_cents !== 0 && (
              <div
                className={`font-semibold ${
                  points[hoveredIdx].amount_cents > 0
                    ? "text-emerald-400"
                    : "text-rose-400"
                }`}
              >
                {points[hoveredIdx].amount_cents > 0 ? "+" : ""}
                {formatMoney(points[hoveredIdx].amount_cents)}
              </div>
            )}
            <div className="border-t border-slate-800 pt-1 mt-1 text-slate-300">
              Balance:{" "}
              <span className="font-bold text-cyan-300">
                {formatMoney(points[hoveredIdx].balance_after_cents)}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
