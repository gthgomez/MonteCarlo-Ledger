"use client";

import React, { useState } from "react";
import { formatDateLabel } from "@/lib/dates";
import { formatMoney } from "@/lib/money-format";

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
  horizonDays: number;
}

export function TimelineChart({ asOf, startingBalanceCents, events, horizonDays }: TimelineChartProps) {
  const [active, setActive] = useState(0);
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

  if (events.length === 0) {
    return (
      <p className="text-sm text-muted">
        Nothing is scheduled in the next {horizonDays} days, so this plan does not move the recorded balance.
      </p>
    );
  }

  const minBal = Math.min(0, ...points.map((point) => point.balance_after_cents));
  const maxBal = Math.max(...points.map((point) => point.balance_after_cents));
  const range = maxBal - minBal || 1;
  const width = 800;
  const height = 240;
  const padX = 36;
  const padY = 28;
  const chartW = width - padX * 2;
  const chartH = height - padY * 2;
  const xAt = (idx: number) => padX + (points.length === 1 ? chartW / 2 : (idx / (points.length - 1)) * chartW);
  const yAt = (bal: number) => padY + chartH - ((bal - minBal) / range) * chartH;
  const line = points.map((point, idx) => `${xAt(idx)},${yAt(point.balance_after_cents)}`).join(" ");
  const zeroY = yAt(0);
  const selected = points[Math.min(active, points.length - 1)];
  const summary = `Planned balance starts at ${formatMoney(startingBalanceCents)} and ends at ${formatMoney(
    points[points.length - 1].balance_after_cents
  )} if the schedule happens exactly as entered.`;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        This line is the exact schedule. It is not the range of modeled futures. Circles are income, squares are money
        going out, and the dashed line is zero.
      </p>
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={summary}
          className="h-auto w-full"
        >
          <title>{summary}</title>
          {zeroY >= padY && zeroY <= height - padY && (
            <>
              <line x1={padX} y1={zeroY} x2={width - padX} y2={zeroY} stroke="var(--danger)" strokeDasharray="5 4" />
              <text x={padX} y={zeroY - 6} fill="var(--danger)" fontSize="12">
                Zero
              </text>
            </>
          )}
          <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth="2.5" />
          {points.map((point, idx) => {
            const cx = xAt(idx);
            const cy = yAt(point.balance_after_cents);
            const selectedPoint = idx === active;
            if (point.amount_cents < 0) {
              return (
                <rect
                  key={`${point.date}-${idx}`}
                  x={cx - 5}
                  y={cy - 5}
                  width="10"
                  height="10"
                  fill="var(--danger)"
                  stroke={selectedPoint ? "var(--ink)" : "var(--surface)"}
                  onMouseEnter={() => setActive(idx)}
                />
              );
            }
            return (
              <circle
                key={`${point.date}-${idx}`}
                cx={cx}
                cy={cy}
                r={point.amount_cents > 0 ? 5 : 4}
                fill={point.amount_cents > 0 ? "var(--positive)" : "var(--accent)"}
                stroke={selectedPoint ? "var(--ink)" : "var(--surface)"}
                strokeWidth="2"
                onMouseEnter={() => setActive(idx)}
              />
            );
          })}
        </svg>
      </div>
      <p className="text-sm text-ink" aria-live="polite">
        {selected.name} on {formatDateLabel(selected.date)}
        {selected.amount_cents !== 0 && (
          <>
            {" "}
            ({selected.amount_cents > 0 ? "in" : "out"} {formatMoney(Math.abs(selected.amount_cents))})
          </>
        )}
        . Planned balance {formatMoney(selected.balance_after_cents)}.
      </p>
      <ul aria-label="Planned balance after each scheduled event" className="space-y-2 md:hidden">
        {points.map((point, idx) => (
          <li key={`${point.date}-${point.name}-card-${idx}`} className="rounded-lg border border-line px-3 py-2 text-sm">
            <p className="font-medium">{point.name}</p>
            <p className="text-muted">
              {formatDateLabel(point.date)} ·{" "}
              {point.type === "starting"
                ? "Starting point"
                : point.amount_cents > 0
                  ? "Income"
                  : point.amount_cents < 0
                    ? "Money out"
                    : "Adjustment"}
            </p>
            <p className="tabular-nums">
              {point.amount_cents === 0 ? "No amount" : formatMoney(point.amount_cents)} · balance after{" "}
              {formatMoney(point.balance_after_cents)}
            </p>
          </li>
        ))}
      </ul>
      <div className="hidden max-w-full overflow-x-auto md:block">
        <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
          <caption className="mb-2 text-left text-sm text-muted">
            Planned balance after each scheduled event. The same numbers are in the chart.
          </caption>
          <thead>
            <tr className="border-b border-line text-muted">
              <th scope="col" className="py-2 pr-3 font-medium">Date</th>
              <th scope="col" className="py-2 pr-3 font-medium">What</th>
              <th scope="col" className="py-2 pr-3 font-medium">Kind</th>
              <th scope="col" className="py-2 pr-3 text-right font-medium">Amount</th>
              <th scope="col" className="py-2 text-right font-medium">Balance after</th>
            </tr>
          </thead>
          <tbody>
            {points.map((point, idx) => (
              <tr key={`${point.date}-${point.name}-${idx}`} className="border-b border-line">
                <td className="py-2 pr-3 tabular-nums">{formatDateLabel(point.date)}</td>
                <td className="py-2 pr-3">{point.name}</td>
                <td className="py-2 pr-3">
                  {point.type === "starting" ? "Starting point" : point.amount_cents > 0 ? "Income" : point.amount_cents < 0 ? "Money out" : "Adjustment"}
                </td>
                <td className="py-2 pr-3 text-right tabular-nums">
                  {point.amount_cents === 0 ? "—" : formatMoney(point.amount_cents)}
                </td>
                <td className="py-2 text-right tabular-nums">{formatMoney(point.balance_after_cents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
