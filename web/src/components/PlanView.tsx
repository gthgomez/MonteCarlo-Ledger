"use client";

import React, { useMemo, useRef, useState } from "react";
import { amortize } from "@/contract/debt";
import {
  cautiousAmountHeading,
  cautiousAmountShortName,
  quantilePlainName,
  type Assumptions,
} from "@/lib/assumptions";
import { addDaysIso, formatDateLabel } from "@/lib/dates";
import {
  addInstallmentDebt,
  updateLiabilityBalance,
  aprPercentToBasisPoints,
  dollarsToCents,
  parseDollarsToCents,
  removeLiability,
  type EditResult,
} from "@/lib/ledger-edits";
import { explainEngineCode, formatMoney, formatProbability } from "@/lib/money-format";
import { evenSetAside, formatCautiousSpend } from "@/lib/present";
import {
  evaluateBillAmount,
  evaluateExtraDebtPayment,
  evaluateIncomeDelay,
  evaluateMonthlySetAside,
  evaluatePurchase,
  type EvalResult,
  type ModelOutcome,
} from "@/lib/scenarios";
import { planningMinimumPaymentCents } from "@/lib/scenario-builder";
import { type PersistenceResult } from "@/lib/sync-state";
import { type LedgerState, type LiabilityItem } from "@/lib/types";
import { type PurchaseToRecord } from "./MoneyView";
import { Button, Explain, fieldClass, Notice, Panel } from "./ui";

function debtMinimumLabel(debt: LiabilityItem): string {
  const planned = planningMinimumPaymentCents(debt);
  if ((debt.kind ?? "installment") === "revolving") {
    return `modeled min ${formatMoney(planned)}`;
  }
  return `min ${formatMoney(planned)}`;
}

type Question = "purchase" | "delay" | "bill" | "aside" | "debt";

/** Stable per-debt key for the balance draft and its failed-save marker. */
function balanceDraftKey(id: string): string {
  return `plan:debt-balance:${id}`;
}

function withoutKey<V>(map: Map<string, V>, key: string): Map<string, V> {
  if (!map.has(key)) return map;
  const next = new Map(map);
  next.delete(key);
  return next;
}

function withKey<V>(map: Map<string, V>, key: string, value: V): Map<string, V> {
  const next = new Map(map);
  next.set(key, value);
  return next;
}

interface ComparisonRow {
  label: string;
  from: string;
  to: string;
  requiresGuidance?: true;
}

function comparisonRows(
  base: ModelOutcome,
  compared: ModelOutcome,
  showGuidance: boolean
): ComparisonRow[] {
  const rows: ComparisonRow[] = [];
  if (showGuidance) {
    rows.push({
      label: cautiousAmountHeading(base.quantileNum, base.quantileDen),
      from: formatCautiousSpend(base.safeSpendCents, base.reserveCents),
      to: formatCautiousSpend(compared.safeSpendCents, compared.reserveCents),
      requiresGuidance: true,
    });
    rows.push({
      label: "Chance of running short",
      from: formatProbability(base.overdraftPpm),
      to: formatProbability(compared.overdraftPpm),
      requiresGuidance: true,
    });
  }
  rows.push({
    label: "Lowest point if the schedule is exact",
    from: formatMoney(base.projectedLowCents),
    to: formatMoney(compared.projectedLowCents),
  });
  rows.push({
    label: "Ending balance if the schedule is exact",
    from: formatMoney(base.endingBalanceCents),
    to: formatMoney(compared.endingBalanceCents),
  });
  return rows;
}

function Compare({
  title,
  base,
  next,
  showGuidance,
  note,
  onKeep,
}: {
  title: string;
  base: ModelOutcome;
  next: EvalResult;
  showGuidance: boolean;
  note: string;
  onKeep?: (rows: ComparisonRow[]) => void;
}) {
  if (next.status === "error") {
    return (
      <Notice tone="danger" title="Calculation Failed">
        {explainEngineCode(next.code)} <code>{next.code}</code>
      </Notice>
    );
  }
  const compared = next.outcome;
  const rows = comparisonRows(base, compared, showGuidance);
  return (
    <div className="min-w-0 rounded-xl border border-line bg-inset p-4">
      <h3 className="text-base font-semibold">{title}</h3>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Current plan compared with this decision</caption>
          <thead>
            <tr className="text-muted">
              <th className="py-2 pr-3 font-medium"> </th>
              <th className="py-2 pr-3 font-medium">Current plan</th>
              <th className="py-2 font-medium">This decision</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-t border-line">
                <th scope="row" className="py-2 pr-3 font-medium">
                  {row.label}
                </th>
                <td className="py-2 pr-3 tabular-nums">{row.from}</td>
                <td className="py-2 tabular-nums font-semibold">{row.to}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {showGuidance && (
        <p className="mt-3 text-sm text-muted">
          The chance of running short is the share of simulated plans that went below zero, not measured odds.
        </p>
      )}
      {note && <p className="mt-3 text-sm text-muted">{note}</p>}
      {onKeep && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button type="button" variant="quiet" onClick={() => onKeep(rows)}>
            Keep this comparison
          </Button>
          <span className="text-xs text-muted">Kept on this screen only; nothing is saved.</span>
        </div>
      )}
    </div>
  );
}

interface KeptComparison {
  id: string;
  label: string;
  detail: string;
  rows: ComparisonRow[];
}

function PlanBaseline({ base, showGuidance }: { base: ModelOutcome; showGuidance: boolean }) {
  const cautious = showGuidance
    ? base.safeSpendCents < 0
      ? formatCautiousSpend(base.safeSpendCents, base.reserveCents)
      : formatMoney(base.safeSpendCents)
    : null;
  return (
    <section
      aria-labelledby="plan-baseline-heading"
      className="overflow-hidden rounded-2xl border border-line bg-surface shadow-card"
    >
      <div className="bg-[color:var(--forest)] px-4 py-4 text-[color:var(--forest-text)] sm:px-6">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--signature)]">Your plan right now</p>
            <h2 id="plan-baseline-heading" className="mt-1 text-xl font-semibold tracking-tight text-[color:var(--forest-text)]">
              Where the exact schedule lands
            </h2>
          </div>
          <span className="rounded-full border border-[color:var(--forest-muted)] px-2.5 py-0.5 text-xs font-medium text-[color:var(--forest-muted)]">
            {base.horizonDays}-day window
          </span>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-[color:var(--forest-muted)]">
          Every comparison below starts from these figures. They come from the same engine and assumptions as the rest of
          the app.
        </p>
      </div>
      <div className="p-4 sm:p-6">
        <dl className="grid gap-3 sm:grid-cols-3">
          <div className="min-w-0 rounded-xl border border-line bg-inset p-3">
            <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
              Lowest point if the schedule is exact
            </dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums tracking-tight text-ink">
              {formatMoney(base.projectedLowCents)}
            </dd>
            <dd className="text-xs text-muted">On {formatDateLabel(base.projectedLowDate)}</dd>
          </div>
          <div className="min-w-0 rounded-xl border border-line bg-inset p-3">
            <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
              Ending balance if the schedule is exact
            </dt>
            <dd className="mt-1 text-xl font-semibold tabular-nums tracking-tight text-ink">
              {formatMoney(base.endingBalanceCents)}
            </dd>
            <dd className="text-xs text-muted">At the end of the {base.horizonDays}-day plan</dd>
          </div>
          {cautious !== null && (
            <div className="min-w-0 rounded-xl border border-line bg-accent-soft p-3">
              <dt className="text-xs font-semibold uppercase tracking-[0.08em] text-muted">
                {cautiousAmountHeading(base.quantileNum, base.quantileDen)}
              </dt>
              <dd className="mt-1 text-xl font-semibold tabular-nums tracking-tight text-ink">{cautious}</dd>
              <dd className="text-xs text-muted">Uses the {quantilePlainName(base.quantileNum, base.quantileDen)} modeled low point</dd>
            </div>
          )}
        </dl>
        {!showGuidance && (
          <p className="mt-3 text-sm text-muted">
            Modeled risk and the cautious amount stay hidden until the schedule has usable bill dates.
          </p>
        )}
      </div>
    </section>
  );
}


export function PlanView({
  state,
  asOf,
  assumptions,
  base,
  showGuidance,
  onEdit,
  onDiscardDraft,
  saving,
  onRecordPurchase,
}: {
  state: LedgerState;
  asOf: string;
  assumptions: Assumptions;
  /**
   * The evaluated ledger baseline. Null means the engine could not evaluate the
   * current ledger (or its assumptions), so comparisons are unavailable. The
   * recorded-debt editor must stay mounted and usable in that state.
   */
  base: ModelOutcome | null;
  showGuidance: boolean;
  onEdit: (result: EditResult, draftKey?: string) => Promise<PersistenceResult>;
  onDiscardDraft: (draftKey: string) => void;
  saving: boolean;
  onRecordPurchase?: (purchase: PurchaseToRecord) => void;
}) {
  const [question, setQuestion] = useState<Question>("purchase");
  const [purchaseAmount, setPurchaseAmount] = useState("350");
  const [purchaseDateInput, setPurchaseDate] = useState<string | null>(null);
  const purchaseDate = purchaseDateInput ?? asOf;
  const purchaseCents = parseDollarsToCents(purchaseAmount);
  const [delayDays, setDelayDays] = useState(3);
  const [billId, setBillId] = useState(String(state.payments[0]?.id ?? ""));
  const [billAmount, setBillAmount] = useState(100);
  const [aside, setAside] = useState(100);
  const [goal, setGoal] = useState("5000");
  const [months, setMonths] = useState("12");
  const [strategy, setStrategy] = useState<"snowball" | "avalanche">("snowball");
  const [extra, setExtra] = useState(100);
  const [paymentDollars, setPaymentDollars] = useState("");
  const [paymentDateInput, setPaymentDate] = useState<string | null>(null);
  const paymentDate = paymentDateInput ?? asOf;
  const [paymentPreview, setPaymentPreview] = useState<{ amountCents: number; date: string } | null>(null);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [debtName, setDebtName] = useState("");
  const [debtBalance, setDebtBalance] = useState("");
  const [debtApr, setDebtApr] = useState("");
  const [debtMin, setDebtMin] = useState("");
  const [debtDueDay, setDebtDueDay] = useState("");
  const [linkedPaymentId, setLinkedPaymentId] = useState("");
  const selectedPayment = state.payments.find((payment) => String(payment.id) === linkedPaymentId);
  const [debtError, setDebtError] = useState<string | null>(null);
  // Balance drafts are keyed by debt id and live for the whole Plan pane. Only
  // this row's successful save or an explicit row discard may remove one, so
  // switching editors never turns a failed draft into silent state loss.
  const [balanceDrafts, setBalanceDrafts] = useState<Map<string, string>>(() => new Map());
  const [balanceErrors, setBalanceErrors] = useState<Map<string, string>>(() => new Map());
  const [openBalanceId, setOpenBalanceId] = useState<string | null>(null);
  const [keptComparisons, setKeptComparisons] = useState<KeptComparison[]>([]);
  const [keptNotice, setKeptNotice] = useState("");
  const keptCounter = useRef(0);

  // No scenario is evaluated while the ledger cannot be forecast. This is not
  // only a display guard: it keeps a failed ledger from producing any estimate
  // behind the recorded-debt editor.
  const purchase = useMemo(
    () =>
      base === null || question !== "purchase"
        ? null
        : evaluatePurchase(state, asOf, assumptions, purchaseCents ?? 0, purchaseDate),
    [base, question, state, asOf, assumptions, purchaseCents, purchaseDate]
  );
  const delay = useMemo(
    () =>
      base === null || question !== "delay"
        ? null
        : evaluateIncomeDelay(state, asOf, assumptions, delayDays),
    [base, question, state, asOf, assumptions, delayDays]
  );
  const bill = useMemo(
    () =>
      base !== null && question === "bill" && billId
        ? evaluateBillAmount(state, asOf, assumptions, billId, Math.round(billAmount * 100))
        : null,
    [base, question, state, asOf, assumptions, billId, billAmount]
  );
  const asideResult = useMemo(
    () =>
      base === null || question !== "aside"
        ? null
        : evaluateMonthlySetAside(state, asOf, assumptions, Math.round(aside * 100)),
    [base, question, state, asOf, assumptions, aside]
  );
  const hasOutstandingDebt = state.liabilities.some((debt) => debt.is_active !== false && debt.balance_cents > 0);
  const extraPayment = useMemo(
    () => base !== null && question === "debt" && hasOutstandingDebt && paymentPreview
      ? evaluateExtraDebtPayment(state, asOf, assumptions, paymentPreview.amountCents, paymentPreview.date)
      : null,
    [base, question, hasOutstandingDebt, paymentPreview, state, asOf, assumptions]
  );
  const selectedBill = state.payments.find((payment) => String(payment.id) === billId);

  const goalCents = dollarsToCents(Number(goal));
  const monthCount = Number(months);
  const pace = goalCents === null ? null : evenSetAside(goalCents, monthCount);
  const windowEnd = addDaysIso(asOf, assumptions.horizonDays);
  const sliderValue = purchaseCents === null ? 10 : purchaseCents / 100;
  const sliderMax = Math.max(2500, sliderValue);

  let debtResult: { months_to_payoff: number; payoff_date: string; total_interest_cents: number; total_paid_cents: number; did_not_converge?: boolean } | null = null;
  let debtCalcError: string | null = null;
  const activeDebts = state.liabilities.filter((debt) => debt.is_active !== false);
  if (base !== null && question === "debt" && activeDebts.length > 0) {
    try {
      debtResult = amortize(asOf, activeDebts, strategy, Math.round(extra * 100));
    } catch (err: unknown) {
      debtCalcError = err && typeof err === "object" && "code" in err ? String((err as { code: string }).code) : "UNKNOWN_ERROR";
    }
  }

  const tabs: { id: Question; label: string }[] = [
    { id: "purchase", label: "Can I afford a purchase?" },
    { id: "delay", label: "What if payday is late?" },
    { id: "bill", label: "What if a bill changes?" },
    { id: "aside", label: "What if I set money aside?" },
    { id: "debt", label: "How do I pay off debt?" },
  ];

  function handleTabKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const currentIndex = tabs.findIndex((tab) => tab.id === question);
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (currentIndex + 1) % tabs.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = tabs.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const next = tabs[nextIndex];
    setQuestion(next.id);
    document.getElementById(`plan-tab-${next.id}`)?.focus();
  }

  async function submitDebt(event: React.FormEvent) {
    event.preventDefault();
    const balance = dollarsToCents(Number(debtBalance));
    const min = dollarsToCents(Number(debtMin));
    const apr = aprPercentToBasisPoints(debtApr);
    if (!debtName.trim() || balance === null || min === null || apr === null) {
      setDebtError("Enter a name, the amount you owe, a minimum payment, and a rate such as 21.99.");
      return;
    }
    const submitted = {
      name: debtName,
      balance: debtBalance,
      min: debtMin,
      apr: debtApr,
      dueDay: debtDueDay,
      linkedPaymentId,
    };
    const dueDay = selectedPayment?.due_day ?? Number(debtDueDay);
    const result = addInstallmentDebt(state, {
      name: debtName,
      balanceCents: balance,
      aprBasisPoints: apr,
      minPaymentCents: min,
      dueDay,
      ...(selectedPayment ? { linkedPaymentId: selectedPayment.id } : {}),
    });
    if (!result.ok) {
      setDebtError(result.error);
      return;
    }
    setDebtError(null);
    const saved = await onEdit(result, "plan:add-debt");
    if (!saved.ok) {
      setDebtError(saved.error);
      return;
    }
    setDebtError(null);
    // Leave any field the user changed while the write was pending. Clearing
    // the whole form on a stale callback would erase an unsubmitted next draft.
    setDebtName((current) => (current === submitted.name ? "" : current));
    setDebtBalance((current) => (current === submitted.balance ? "" : current));
    setDebtMin((current) => (current === submitted.min ? "" : current));
    setDebtApr((current) => (current === submitted.apr ? "" : current));
    setDebtDueDay((current) => (current === submitted.dueDay ? "" : current));
    setLinkedPaymentId((current) => (current === submitted.linkedPaymentId ? "" : current));
  }

  function compareExtraPayment(event: React.FormEvent) {
    event.preventDefault();
    const amountCents = parseDollarsToCents(paymentDollars);
    if (amountCents === null || amountCents <= 0) {
      setPaymentError("Enter an amount above $0 with at most two decimal places, like 150 or 150.25.");
      return;
    }
    setPaymentError(null);
    setPaymentPreview({ amountCents, date: paymentDate });
  }

  function keepComparison(label: string, detail: string, rows: ComparisonRow[]) {
    keptCounter.current += 1;
    const id = `kept-comparison-${keptCounter.current}`;
    setKeptComparisons((current) => [...current, { id, label, detail, rows }]);
    setKeptNotice(`Kept ${label}. It stays on this screen only.`);
  }

  function discardComparison(item: KeptComparison) {
    setKeptComparisons((current) => current.filter((entry) => entry.id !== item.id));
    setKeptNotice(`Discarded ${item.label}.`);
  }

  function openBalanceEditor(debt: LiabilityItem) {
    // Reopening is not a discard: the typed value and any failure stay with the
    // row until its own save succeeds or its own Cancel removes them.
    setOpenBalanceId(debt.id);
  }

  async function saveBalance(debt: LiabilityItem, event: React.FormEvent) {
    event.preventDefault();
    const submitted = balanceDrafts.get(debt.id) ?? "";
    const balance = dollarsToCents(Number(submitted));
    const result = updateLiabilityBalance(state, debt.id, balance ?? NaN);
    if (!result.ok) {
      setBalanceErrors((current) => withKey(current, debt.id, result.error));
      return;
    }
    setBalanceErrors((current) => withoutKey(current, debt.id));
    const saved = await onEdit(result, balanceDraftKey(debt.id));
    if (!saved.ok) {
      // The failure marker and this row's typed value stay together for a retry
      // or an explicit Cancel, even if another debt's editor is opened.
      setBalanceErrors((current) => withKey(current, debt.id, saved.error));
      return;
    }
    // Leave a value the user changed while the write was pending. Only the
    // exact submitted draft is settled by this success.
    setBalanceDrafts((current) =>
      current.get(debt.id) === submitted ? withoutKey(current, debt.id) : current
    );
    setBalanceErrors((current) => withoutKey(current, debt.id));
    setOpenBalanceId((current) => (current === debt.id ? null : current));
  }

  function cancelBalance(debt: LiabilityItem) {
    setBalanceDrafts((current) => withoutKey(current, debt.id));
    setBalanceErrors((current) => withoutKey(current, debt.id));
    setOpenBalanceId((current) => (current === debt.id ? null : current));
    // Explicit discard may clear this row's failed-draft marker, never a sibling's.
    onDiscardDraft(balanceDraftKey(debt.id));
  }

  async function removeDebt(debt: LiabilityItem) {
    const draft = balanceDrafts.get(debt.id);
    const hasEnteredDraft = draft !== undefined && draft.trim() !== "";
    if (hasEnteredDraft && !window.confirm(`Remove ${debt.name}? The balance draft you entered will be discarded.`)) {
      return;
    }
    if (!(await onEdit(removeLiability(state, debt.id))).ok) return;
    setBalanceDrafts((current) => withoutKey(current, debt.id));
    setBalanceErrors((current) => withoutKey(current, debt.id));
    setOpenBalanceId((current) => (current === debt.id ? null : current));
    // Only a successful removal discards this row's draft and its marker.
    onDiscardDraft(balanceDraftKey(debt.id));
  }

  // Recorded-debt editing is deliberately independent of the selected decision
  // tab. It is the only Plan surface that stays usable when the engine cannot
  // evaluate the ledger. The form values stay in this Plan instance across
  // both the normal and recovery layouts.
  const debtManagement = (base === null || question === "debt") && (
    <fieldset disabled={saving} className="m-0 min-w-0 space-y-3 border-0 p-0">
      <ul className="divide-y divide-line">
        {state.liabilities.map((debt) => (
          <li key={debt.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <span>
              {debt.name} · owe {formatMoney(debt.balance_cents)} · {(debt.apr_basis_points / 100).toFixed(2)}%
              {debt.is_active === false
                ? " · Archived"
                : base === null
                  ? null
                  : ` · ${debtMinimumLabel(debt)}${
                      debt.due_day_of_month
                        ? ` · due day ${debt.due_day_of_month}`
                        : " · due day not set (plan assumes the 1st)"
                    }`}
            </span>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="quiet" onClick={() => openBalanceEditor(debt)}>
                Update balance for {debt.name}
              </Button>
              <Button type="button" variant="quiet" onClick={() => void removeDebt(debt)}>
                Remove {debt.name}
              </Button>
            </div>
            {openBalanceId === debt.id && (
              <form
                className="flex w-full flex-wrap items-end gap-2"
                onSubmit={(event) => void saveBalance(debt, event)}
              >
                <label className="text-sm font-medium">
                  Lender balance for {debt.name} ($)
                  <input
                    type="number" min={0} step="0.01" required
                    className={`${fieldClass} mt-1`}
                    value={balanceDrafts.get(debt.id) ?? ""}
                    onChange={(event) => {
                      const dollars = event.target.value;
                      setBalanceDrafts((current) => withKey(current, debt.id, dollars));
                      setBalanceErrors((current) => withoutKey(current, debt.id));
                    }}
                  />
                </label>
                <Button type="submit" variant="quiet">Save balance</Button>
                <Button type="button" variant="quiet" onClick={() => cancelBalance(debt)}>Cancel</Button>
                {balanceErrors.get(debt.id) && (
                  <p className="w-full text-sm text-danger" role="alert">
                    {balanceErrors.get(debt.id)}
                  </p>
                )}
              </form>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={submitDebt} className="grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-medium">
          Debt name
          <input className={`${fieldClass} mt-1`} value={debtName} onChange={(e) => setDebtName(e.target.value)} />
        </label>
        <label className="text-sm font-medium">
          Amount still owed ($)
          <input className={`${fieldClass} mt-1`} inputMode="decimal" value={debtBalance} onChange={(e) => setDebtBalance(e.target.value)} />
        </label>
        <label className="text-sm font-medium">
          Interest rate (%)
          <input className={`${fieldClass} mt-1`} inputMode="decimal" value={debtApr} onChange={(e) => setDebtApr(e.target.value)} placeholder="21.99" />
        </label>
        <label className="text-sm font-medium">
          Minimum payment ($)
          <input className={`${fieldClass} mt-1`} inputMode="decimal" value={debtMin} onChange={(e) => setDebtMin(e.target.value)} />
        </label>
        <label className="text-sm font-medium">
          Bill for this debt (optional)
          <select className={`${fieldClass} mt-1`} value={linkedPaymentId} onChange={(e) => setLinkedPaymentId(e.target.value)}>
            <option value="">No matching bill</option>
            {state.payments
              .filter((payment) => payment.recurrence === "Monthly" && payment.due_day)
              .filter((payment) => !(state.liabilities ?? []).some(
                (debt) => debt.linked_payment_id != null && String(debt.linked_payment_id) === String(payment.id)
              ))
              .map((payment) => (
                <option key={String(payment.id)} value={String(payment.id)}>
                  {payment.name} · {formatMoney(payment.amount_cents)} · day {payment.due_day}
                </option>
              ))}
          </select>
        </label>
        {!selectedPayment && (
          <label className="text-sm font-medium">
            Usual payment day (1–31)
            <input
              className={`${fieldClass} mt-1`}
              type="number"
              min={1}
              max={31}
              value={debtDueDay}
              onChange={(e) => setDebtDueDay(e.target.value)}
            />
          </label>
        )}
        {debtError && (
          <p className="text-sm text-danger sm:col-span-2" role="alert">
            {debtError}
          </p>
        )}
        <div>
          <Button type="submit" variant="quiet">
            Add debt
          </Button>
        </div>
      </form>
    </fieldset>
  );

  if (base === null) {
    // The selected decision tab is intentionally not rendered here, but its
    // retained state is untouched. Debt management is shown regardless of which
    // tab was open, and no scenario, payoff, or risk value is computed.
    return (
      <div className="space-y-4">
        <Panel title="Recorded debts">
          <Notice tone="warning" title="Plan comparisons unavailable">
            Cash, payoff, and risk comparisons are unavailable. Your saved debts and open drafts are still available
            below.
          </Notice>
          <div className="mt-4">{debtManagement}</div>
        </Panel>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PlanBaseline base={base} showGuidance={showGuidance} />
      <Panel
        title="Try a decision"
        lede="Each comparison uses the same engine as the rest of the app. Results are estimates from your assumptions, not guarantees. Nothing is saved until you edit the ledger itself."
      >
        <div
          role="tablist"
          aria-label="Decisions"
          className="flex flex-wrap gap-2"
          onKeyDown={handleTabKeyDown}
        >
          {tabs.map((tab) => (
            <button
              key={tab.id}
              id={`plan-tab-${tab.id}`}
              type="button"
              role="tab"
              aria-selected={question === tab.id}
              aria-controls="plan-tabpanel"
              tabIndex={question === tab.id ? 0 : -1}
              disabled={saving}
              onClick={() => setQuestion(tab.id)}
              className={`min-h-11 shrink-0 rounded-lg px-3 text-sm font-semibold disabled:opacity-50 ${
                question === tab.id ? "bg-accent text-on-accent" : "border border-line bg-inset text-ink"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {!showGuidance && (
          <div className="mt-3">
            <Notice tone="info">Comparisons show scheduled balances only. Check for missing bill dates or payments outside the plan window before using the comparison to decide what you can afford.</Notice>
          </div>
        )}

        <div role="tabpanel" id="plan-tabpanel" aria-labelledby={`plan-tab-${question}`}>

        {question === "purchase" && purchase && (
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div>
              <label className="block text-sm font-medium">
                Purchase Amount{purchaseCents === null ? "" : `: ${formatMoney(purchaseCents)}`}
                <input
                  className="mt-2 w-full accent-accent"
                  type="range"
                  min={10}
                  max={sliderMax}
                  step={10}
                  value={sliderValue}
                  onChange={(e) => setPurchaseAmount(e.target.value)}
                />
              </label>
              <label className="mt-3 block text-sm font-medium">
                Or type an amount ($)
                <input
                  className={`${fieldClass} mt-1`}
                  inputMode="decimal"
                  value={purchaseAmount}
                  onChange={(e) => setPurchaseAmount(e.target.value)}
                />
              </label>
              <label className="mt-3 block text-sm font-medium">
                Planned purchase date
                <input
                  className={`${fieldClass} mt-1`}
                  type="date"
                  min={asOf}
                max={addDaysIso(windowEnd, -1)}
                value={purchaseDate}
                onChange={(e) => setPurchaseDate(e.target.value)}
              />
              </label>
              {onRecordPurchase && purchase.status === "ok" && purchaseDate === asOf && purchaseCents !== null && purchaseCents > 0 && (
                <div className="mt-3 space-y-2">
                  <Button
                    type="button"
                    variant="quiet"
                    disabled={saving}
                    onClick={() => onRecordPurchase({ amountCents: purchaseCents, date: purchaseDate })}
                  >
                    Review and record this purchase
                  </Button>
                  <p className="text-sm text-muted">Use this only if you made the purchase. The comparison itself saves nothing.</p>
                </div>
              )}
            </div>
            <Compare
              title="How this changes the plan"
              base={base}
              next={purchase}
              showGuidance={showGuidance}
              onKeep={(rows) =>
                keepComparison(
                  "Purchase comparison",
                  `${formatMoney(purchaseCents ?? 0)} on ${formatDateLabel(purchaseDate)}`,
                  rows
                )
              }
              note={
                showGuidance && purchase.status === "ok"
                  ? purchase.outcome.safeSpendCents >= 0
                    ? `In this simulation the ${cautiousAmountShortName(base.quantileNum, base.quantileDen)} stays at or above zero after the purchase. That is a model estimate, not a guarantee.`
                    : purchase.outcome.reserveCents > 0
                      ? "After this purchase, the selected modeled low point is below your reserve. That does not necessarily mean the balance falls below zero."
                      : "After this purchase, the selected modeled low point falls below zero. That is a model estimate, not a guarantee you will overdraw."
                  : ""
              }
            />
          </div>
        )}

        {question === "delay" && delay && (
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <label className="block text-sm font-medium">
              Paycheck arrives late by {delayDays} {delayDays === 1 ? "day" : "days"}
              <input
                className="mt-2 w-full accent-accent"
                type="range"
                min={1}
                max={14}
                step={1}
                value={delayDays}
                onChange={(e) => setDelayDays(Number(e.target.value))}
              />
              <span className="mt-2 block text-muted">
                This moves the earliest scheduled paycheck. It does not change money you have already recorded.
              </span>
            </label>
            <Compare
              title="If that paycheck arrives late"
              base={base}
              next={delay}
              showGuidance={showGuidance}
              onKeep={(rows) =>
                keepComparison(
                  "Late paycheck comparison",
                  `Paycheck delayed ${delayDays} ${delayDays === 1 ? "day" : "days"}`,
                  rows
                )
              }
              note="This compares cash if payday moves. It does not estimate how likely a delay is."
            />
          </div>
        )}

        {question === "bill" && (
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {state.payments.length === 0 || !bill ? (
              <Notice tone="info">Add a bill first. There is no bill amount to change.</Notice>
            ) : (
              <>
                <div className="space-y-3">
                  <label className="block text-sm font-medium">
                    Bill
                    <select className={`${fieldClass} mt-1`} value={billId} onChange={(e) => setBillId(e.target.value)}>
                      {state.payments.map((payment) => (
                        <option key={String(payment.id)} value={String(payment.id)}>
                          {payment.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-sm font-medium">
                    New amount: ${billAmount.toLocaleString("en-US")}
                    <input
                      className="mt-2 w-full accent-accent"
                      type="range"
                      min={10}
                      max={3000}
                      step={10}
                      value={billAmount}
                      onChange={(e) => setBillAmount(Number(e.target.value))}
                    />
                  </label>
                  <p className="text-sm text-muted">
                    This comparison does not change the saved bill. Edit the bill under Bills if you want to keep the new amount.
                  </p>
                </div>
                <Compare
                  title="If that bill used the new amount"
                  base={base}
                  next={bill}
                  showGuidance={showGuidance}
                  onKeep={(rows) =>
                    keepComparison(
                      "Changed bill comparison",
                      `${selectedBill?.name ?? "Bill"} at ${formatMoney(Math.round(billAmount * 100))}`,
                      rows
                    )
                  }
                  note="In this simulation only that bill's amount changes. Other assumptions stay as they are."
                />
              </>
            )}
          </div>
        )}

        {question === "aside" && asideResult && (
          <div className="mt-4 space-y-4">
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <label className="block text-sm font-medium">
                  Set aside ${aside.toLocaleString("en-US")} each month
                  <input
                    className="mt-2 w-full accent-accent"
                    type="range"
                    min={25}
                    max={1000}
                    step={25}
                    value={aside}
                    onChange={(e) => setAside(Number(e.target.value))}
                  />
                </label>
                <p className="mt-2 text-sm text-muted">
                  Setting money aside is modeled as a monthly payment leaving this account. It does not create a separate
                  savings balance, and it does not earn interest.
                </p>
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <label className="text-sm font-medium">
                    Target ($)
                    <input className={`${fieldClass} mt-1`} inputMode="decimal" value={goal} onChange={(e) => setGoal(e.target.value)} />
                  </label>
                  <label className="text-sm font-medium">
                    Months
                    <input className={`${fieldClass} mt-1`} inputMode="numeric" value={months} onChange={(e) => setMonths(e.target.value)} />
                  </label>
                </div>
                {pace && (
                  <p className="mt-3 text-sm text-ink">
                    Reaching {formatMoney(goalCents ?? 0)} in {monthCount} months, with no interest, takes{" "}
                    {formatMoney(pace.perMonthCents)} each month
                    {pace.remainderCents > 0 ? ` plus ${formatMoney(pace.remainderCents)} once` : ""}. That is straight
                    division, not a forecast.
                  </p>
                )}
              </div>
              <Compare
                title="If that amount leaves the account monthly"
                base={base}
                next={asideResult}
                showGuidance={showGuidance}
                onKeep={(rows) =>
                  keepComparison(
                    "Monthly set-aside comparison",
                    `${formatMoney(Math.round(aside * 100))} each month`,
                    rows
                  )
                }
                note="The ending balance here is what would remain in this account, not a savings pile. In this simulation the difference is the cash-flow effect of moving the money out."
              />
            </div>
          </div>
        )}

        {question === "debt" && (
          <div className="mt-4 space-y-4">
            <p className="text-sm text-muted">
              Snowball pays the smallest balance first. Avalanche (APR) pays the highest interest rate first. Minimum
              payments for debts you entered are already ordinary outflows on Home and Future. Extra payments and the
              interest schedule in the strategy comparison do not change the cash forecast.
            </p>
            {activeDebts.length === 0 ? (
              <p className="text-sm text-muted">No active debts are entered.</p>
            ) : debtCalcError ? (
              <Notice tone="danger" title="Calculation Failed">
                {explainEngineCode(debtCalcError)} <code>{debtCalcError}</code>
              </Notice>
            ) : debtResult ? (
              <div className="space-y-3">
                <p className="text-sm font-medium">Payoff Strategy</p>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant={strategy === "snowball" ? "primary" : "quiet"} onClick={() => setStrategy("snowball")}>
                    Snowball (smallest balance)
                  </Button>
                  <Button type="button" variant={strategy === "avalanche" ? "primary" : "quiet"} onClick={() => setStrategy("avalanche")}>
                    Avalanche (APR)
                  </Button>
                </div>
                <label className="block text-sm font-medium">
                  Extra monthly payment: ${extra}
                  <input className="mt-2 w-full accent-accent" type="range" min={0} max={1000} step={25} value={extra} onChange={(e) => setExtra(Number(e.target.value))} />
                </label>
                <dl className="grid gap-3 sm:grid-cols-3">
                  <div>
                    <dt className="text-sm text-muted">Months to Payoff</dt>
                    <dd className="text-xl font-semibold">{debtResult.months_to_payoff} months</dd>
                    <dd className="text-sm text-muted">{debtResult.payoff_date}</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-muted">Total Interest Paid</dt>
                    <dd className="text-xl font-semibold tabular-nums">{formatMoney(debtResult.total_interest_cents)}</dd>
                  </div>
                  <div>
                    <dt className="text-sm text-muted">Total paid</dt>
                    <dd className="text-xl font-semibold tabular-nums">{formatMoney(debtResult.total_paid_cents)}</dd>
                  </div>
                </dl>
                {debtResult.did_not_converge && (
                  <Notice tone="warning">
                    This schedule did not finish within 360 months. The balance may be growing faster than the payments.
                  </Notice>
                )}
              </div>
            ) : null}
            {hasOutstandingDebt && (
              <section className="min-w-0 space-y-3 rounded-xl border border-line p-4">
                <h3 className="font-semibold">Check a one-time extra payment</h3>
                <p className="text-sm text-muted">
                  See what happens to your cash if you pay more on a specific day, on top of your usual bills and debt
                minimums. This is separate from the monthly payoff comparison. It doesn’t record a payment or
                check what your lender will accept or change.
                </p>
                <form className="space-y-3" onSubmit={compareExtraPayment}>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block min-w-0 text-sm font-medium">
                      One-time extra payment ($)
                      <input className={`${fieldClass} mt-1`} inputMode="decimal" value={paymentDollars}
                        onChange={(event) => {
                          setPaymentDollars(event.target.value);
                          setPaymentPreview(null);
                          setPaymentError(null);
                        }}
                      />
                    </label>
                    <label className="block min-w-0 text-sm font-medium">
                      Date of extra payment
                      <input className={`${fieldClass} mt-1`} type="date" value={paymentDate} min={asOf}
                        max={addDaysIso(windowEnd, -1)} required onChange={(event) => {
                          setPaymentDate(event.target.value);
                          setPaymentPreview(null);
                        }}
                      />
                    </label>
                  </div>
                  {paymentError && <p className="text-sm text-danger" role="alert">{paymentError}</p>}
                  <Button type="submit">Compare with cash plan</Button>
                </form>
                <div aria-live="polite">
                  {extraPayment && (
                    <Compare
                      title="If you make this extra payment"
                      base={base}
                      next={extraPayment}
                      showGuidance={showGuidance}
                      onKeep={(rows) =>
                        keepComparison(
                          "Extra debt payment comparison",
                          paymentPreview
                            ? `${formatMoney(paymentPreview.amountCents)} on ${formatDateLabel(paymentPreview.date)}`
                            : "One-time extra payment",
                          rows
                        )
                      }
                      note="In the exact schedule this amount leaves on the date you chose. The other dated payments stay the same."
                    />
                  )}
                </div>
              </section>
            )}
            {debtManagement}
            <Explain term="interest">
              The interest rate helps estimate what you will owe in future months. If you already track the same
              payment as a bill, choose it above so that payment is counted once.
            </Explain>
          </div>
        )}

        </div>

        {keptComparisons.length > 0 && (
          <section aria-labelledby="plan-kept-heading" className="mt-6 border-t border-line pt-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 id="plan-kept-heading" className="text-base font-semibold">
                Kept comparisons
              </h3>
              <p className="text-xs text-muted">On this screen only · not saved</p>
            </div>
            <p className="mt-1 text-sm text-muted">
              These snapshots use the plan as it was when you kept them. They are not recalculated if the ledger or
              assumptions change.
            </p>
            <ul className="mt-3 grid gap-3 lg:grid-cols-2">
              {keptComparisons.map((item) => (
                <li key={item.id} className="min-w-0 rounded-xl border border-line bg-inset p-3">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-ink">{item.label}</p>
                      {item.detail && <p className="text-xs text-muted">{item.detail}</p>}
                    </div>
                    <Button
                      type="button"
                      variant="quiet"
                      onClick={() => discardComparison(item)}
                      aria-label={`Discard kept comparison: ${item.label}`}
                    >
                      Discard
                    </Button>
                  </div>
                  <dl className="mt-2 space-y-1 text-xs">
                    {item.rows.filter((row) => showGuidance || !row.requiresGuidance).map((row) => (
                      <div
                        key={row.label}
                        className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-t border-line pt-1"
                      >
                        <dt className="text-muted">{row.label}</dt>
                        <dd className="tabular-nums text-right">
                          <span className="text-muted">{row.from}</span>
                          <span aria-hidden="true"> → </span>
                          <span className="sr-only"> changed to </span>
                          <span className="font-semibold text-ink">{row.to}</span>
                        </dd>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
            </ul>
          </section>
        )}
        <p className="sr-only" role="status" aria-live="polite">
          {keptNotice}
        </p>
      </Panel>
    </div>
  );
}
