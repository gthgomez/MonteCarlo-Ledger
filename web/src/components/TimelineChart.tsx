"use client";

import React, { useId, useMemo, useState } from "react";
import { addDaysIso, daysBetween, formatDateLabel } from "@/lib/dates";
import { formatMoney } from "@/lib/money-format";

interface TimelineEvent {
  date: string;
  name: string;
  type: string;
  amount_cents: number;
  balance_after_cents: number;
}

type TimelinePoint = TimelineEvent;

interface TimelineChartProps {
  asOf: string;
  startingBalanceCents: number;
  events: TimelineEvent[];
  horizonDays: number;
}

type ChartRange = "full" | "30";

const WIDTH = 480;
const HEIGHT = 220;
const PAD_X = 20;
const PAD_Y = 22;

function shortDate(iso: string): string {
  return formatDateLabel(iso).replace(/,\s*\d{4}$/, "");
}

function kindLabel(point: TimelinePoint): string {
  if (point.type === "starting") return "Starting point";
  if (point.amount_cents > 0) return "Income";
  if (point.amount_cents < 0) return "Money out";
  return "Adjustment";
}

export function TimelineChart({ asOf, startingBalanceCents, events, horizonDays }: TimelineChartProps) {
  const [active, setActive] = useState(0);
  const [range, setRange] = useState<ChartRange>("full");
  const helpId = useId();

  const allPoints = useMemo<TimelinePoint[]>(
    () => [
      {
        date: asOf,
        name: "Today",
        type: "starting",
        amount_cents: 0,
        balance_after_cents: startingBalanceCents,
      },
      ...events,
    ],
    [asOf, startingBalanceCents, events]
  );

  if (events.length === 0) {
    return (
      <p className="text-sm text-muted">
        Nothing is scheduled in the next {horizonDays} days, so this plan does not move the recorded balance.
      </p>
    );
  }

  const shortRangeDays = Math.min(30, horizonDays);
  const showRangeToggle = horizonDays > 30;
  const viewDays = showRangeToggle && range === "30" ? shortRangeDays : horizonDays;
  const viewEndExclusive = addDaysIso(asOf, viewDays);
  const points =
    showRangeToggle && range === "30"
      ? allPoints.filter((point, index) => index === 0 || point.date < viewEndExclusive)
      : allPoints;
  const effectiveActive = Math.min(active, points.length - 1);
  const selected = points[effectiveActive];

  const minBal = Math.min(0, ...points.map((point) => point.balance_after_cents));
  const maxBal = Math.max(...points.map((point) => point.balance_after_cents));
  const balanceRange = maxBal - minBal || 1;
  const chartW = WIDTH - PAD_X * 2;
  const chartH = HEIGHT - PAD_Y * 2;

  const xAt = (iso: string) => {
    const offset = Math.max(0, Math.min(viewDays, daysBetween(asOf, iso)));
    return PAD_X + (offset / viewDays) * chartW;
  };
  const yAt = (balance: number) => PAD_Y + chartH - ((balance - minBal) / balanceRange) * chartH;

  // A step line: the balance holds until a dated event, then steps to its new value.
  const stepPath = points
    .map((point, index) => {
      const x = xAt(point.date);
      if (index === 0) return `M ${x} ${yAt(point.balance_after_cents)}`;
      const previous = points[index - 1];
      return `L ${x} ${yAt(previous.balance_after_cents)} L ${x} ${yAt(point.balance_after_cents)}`;
    })
    .join(" ")
    .concat(` L ${PAD_X + chartW} ${yAt(points[points.length - 1].balance_after_cents)}`);

  const zeroY = yAt(0);
  const zeroVisible = zeroY >= PAD_Y && zeroY <= HEIGHT - PAD_Y;
  const activeX = xAt(selected.date);
  const activeY = yAt(selected.balance_after_cents);

  const selectedDescription = `${selected.name} on ${formatDateLabel(selected.date)}${
    selected.type === "starting" ? "" : `, ${kindLabel(selected).toLowerCase()}`
  }. Planned balance ${formatMoney(selected.balance_after_cents)}.`;
  const summary = `Exact schedule: planned balance starts at ${formatMoney(
    startingBalanceCents
  )} and ends at ${formatMoney(points[points.length - 1].balance_after_cents)}.`;

  function selectFromPointer(event: React.PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const svgX = ((event.clientX - rect.left) / rect.width) * WIDTH;
    let nearest = 0;
    let nearestDistance = Number.POSITIVE_INFINITY;
    points.forEach((point, index) => {
      const distance = Math.abs(xAt(point.date) - svgX);
      if (distance < nearestDistance) {
        nearest = index;
        nearestDistance = distance;
      }
    });
    setActive(nearest);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const last = points.length - 1;
    let next = effectiveActive;
    switch (event.key) {
      case "ArrowRight":
      case "ArrowDown":
        next = Math.min(last, effectiveActive + 1);
        break;
      case "ArrowLeft":
      case "ArrowUp":
        next = Math.max(0, effectiveActive - 1);
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = last;
        break;
      case "PageDown":
        next = Math.min(last, effectiveActive + 5);
        break;
      case "PageUp":
        next = Math.max(0, effectiveActive - 5);
        break;
      default:
        return;
    }
    event.preventDefault();
    setActive(next);
  }

  function changeRange(next: ChartRange) {
    setRange(next);
    setActive(0);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p id={helpId} className="max-w-2xl text-sm text-muted">
          This line is the exact schedule, not the range of modeled futures. It steps on each dated event.
          Circles are money in, squares are money out, and the dashed line is zero. Use the arrow keys on the chart, or
          tap a point, to inspect one event.
          {showRangeToggle
            ? ` The chart view can show the first 30 days or the full ${horizonDays}-day plan; the figures above always cover the full plan.`
            : ""}
        </p>
        {showRangeToggle && (
          <div role="group" aria-label="Chart date range" className="flex flex-wrap gap-2">
            <button
              type="button"
              aria-pressed={range === "30"}
              onClick={() => changeRange("30")}
              className={`min-h-11 rounded-lg border px-3 text-xs font-semibold ${
                range === "30" ? "border-accent bg-accent-soft text-ink" : "border-line bg-surface text-muted"
              }`}
            >
              First 30 days
            </button>
            <button
              type="button"
              aria-pressed={range === "full"}
              onClick={() => changeRange("full")}
              className={`min-h-11 rounded-lg border px-3 text-xs font-semibold ${
                range === "full" ? "border-accent bg-accent-soft text-ink" : "border-line bg-surface text-muted"
              }`}
            >
              Full {horizonDays}-day plan
            </button>
          </div>
        )}
      </div>

      <div
        role="slider"
        tabIndex={0}
        aria-label="Inspect the exact schedule by scheduled event"
        aria-valuemin={0}
        aria-valuemax={points.length - 1}
        aria-valuenow={effectiveActive}
        aria-valuetext={selectedDescription}
        aria-describedby={helpId}
        onKeyDown={handleKeyDown}
        className="rounded-lg"
      >
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          aria-hidden="true"
          className="h-auto w-full"
          onPointerDown={selectFromPointer}
          onPointerMove={(event) => {
            if (event.buttons === 1) selectFromPointer(event);
          }}
          style={{ touchAction: "pan-y" }}
        >
          <title>{summary}</title>
          {zeroVisible && (
            <>
              <line
                x1={PAD_X}
                y1={zeroY}
                x2={WIDTH - PAD_X}
                y2={zeroY}
                stroke="var(--danger)"
                strokeDasharray="5 4"
              />
              <text x={PAD_X} y={zeroY - 6} fill="var(--danger)" fontSize="12">
                Zero
              </text>
            </>
          )}
          <line
            x1={activeX}
            y1={PAD_Y}
            x2={activeX}
            y2={HEIGHT - PAD_Y}
            stroke="var(--line)"
            strokeWidth="1"
          />
          <path d={stepPath} fill="none" stroke="var(--accent)" strokeWidth="2.5" />
          {points.map((point, index) => {
            const cx = xAt(point.date);
            const cy = yAt(point.balance_after_cents);
            const selectedPoint = index === effectiveActive;
            const common = {
              onPointerDown: (event: React.PointerEvent<SVGElement>) => {
                event.stopPropagation();
                setActive(index);
              },
              onPointerEnter: () => setActive(index),
              style: { cursor: "pointer" as const },
            };
            if (point.amount_cents < 0) {
              return (
                <rect
                  key={`${point.date}-${index}`}
                  x={cx - 5}
                  y={cy - 5}
                  width="10"
                  height="10"
                  fill="var(--danger)"
                  stroke={selectedPoint ? "var(--ink)" : "var(--surface)"}
                  strokeWidth={selectedPoint ? 2 : 1}
                  {...common}
                />
              );
            }
            const positive = point.amount_cents > 0;
            return (
              <circle
                key={`${point.date}-${index}`}
                cx={cx}
                cy={cy}
                r={positive ? 5 : 4}
                fill={positive ? "var(--positive)" : "var(--accent)"}
                stroke={selectedPoint ? "var(--ink)" : "var(--surface)"}
                strokeWidth={selectedPoint ? 2 : 1}
                {...common}
              />
            );
          })}
          <circle cx={activeX} cy={activeY} r={9} fill="none" stroke="var(--ink)" strokeWidth="2" />
        </svg>
      </div>

      <div className="flex flex-wrap justify-between gap-1 text-xs text-muted">
        <span>{shortDate(asOf)} · start</span>
        <span>
          {shortDate(addDaysIso(asOf, Math.max(viewDays - 1, 0)))} · {range === "30" && showRangeToggle ? "first 30 days" : `${horizonDays}-day view`}
        </span>
      </div>

      {points.length === 1 && (
        <p className="text-sm text-muted">
          No scheduled events fall in this chart view. Switch to the full plan to see later dates.
        </p>
      )}

      <p className="text-sm text-ink" aria-live="polite">
        {selected.name} on {formatDateLabel(selected.date)}
        {selected.type === "starting" ? "" : ` (${kindLabel(selected).toLowerCase()})`}
        {selected.amount_cents !== 0 && (
          <>
            {" "}
            · {selected.amount_cents > 0 ? "in" : "out"} {formatMoney(Math.abs(selected.amount_cents))}
          </>
        )}
        . Planned balance {formatMoney(selected.balance_after_cents)}.
      </p>

      <ul aria-label="Planned balance after each scheduled event in this chart view" className="space-y-2 md:hidden">
        {points.map((point, index) => (
          <li key={`${point.date}-${point.name}-card-${index}`} className="rounded-lg border border-line px-3 py-2 text-sm">
            <p className="font-medium">{point.name}</p>
            <p className="text-muted">
              {formatDateLabel(point.date)} · {kindLabel(point)}
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
            Planned balance after each scheduled event in this chart view. The same numbers are in the chart.
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
            {points.map((point, index) => (
              <tr key={`${point.date}-${point.name}-${index}`} className="border-b border-line">
                <td className="py-2 pr-3 tabular-nums">{formatDateLabel(point.date)}</td>
                <td className="py-2 pr-3">{point.name}</td>
                <td className="py-2 pr-3">{kindLabel(point)}</td>
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
