"use client";

import React, { useMemo, useState } from "react";
import { amortize } from "@/contract/debt";
import { type Assumptions } from "@/lib/assumptions";
import { addDaysIso } from "@/lib/dates";
import {
  addInstallmentDebt,
  aprPercentToBasisPoints,
  dollarsToCents,
  removeLiability,
  type EditResult,
} from "@/lib/ledger-edits";
import { explainEngineCode, formatMoney, formatProbability } from "@/lib/money-format";
import { evenSetAside } from "@/lib/present";
import {
  evaluateBillAmount,
  evaluateIncomeDelay,
  evaluateMonthlySetAside,
  evaluatePurchase,
  type EvalResult,
  type ModelOutcome,
} from "@/lib/scenarios";
import { type LedgerState } from "@/lib/types";
import { Button, Explain, fieldClass, Notice, Panel } from "./ui";

type Question = "purchase" | "delay" | "bill" | "aside" | "debt";

function Compare({
  title,
  base,
  next,
  note,
}: {
  title: string;
  base: ModelOutcome;
  next: EvalResult;
  note: string;
}) {
  if (next.status === "error") {
    return (
      <Notice tone="danger" title="Calculation Failed">
        {explainEngineCode(next.code)} <code>{next.code}</code>
      </Notice>
    );
  }
  const rows = [
    ["Cautious amount to spend", base.safeSpendCents, next.outcome.safeSpendCents],
    ["Chance of running short", base.overdraftPpm, next.outcome.overdraftPpm],
    ["Lowest point if the schedule is exact", base.projectedLowCents, next.outcome.projectedLowCents],
    ["Ending balance if the schedule is exact", base.endingBalanceCents, next.outcome.endingBalanceCents],
  ] as const;
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
            {rows.map(([label, from, to]) => (
              <tr key={label} className="border-t border-line">
                <th scope="row" className="py-2 pr-3 font-medium">
                  {label === "Chance of running short" ? "Chance of running short" : label}
                </th>
                <td className="py-2 pr-3 tabular-nums">
                  {label === "Chance of running short" ? formatProbability(from) : formatMoney(from)}
                </td>
                <td className="py-2 tabular-nums font-semibold">
                  {label === "Chance of running short" ? formatProbability(to) : formatMoney(to)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-sm text-muted">{note}</p>
    </div>
  );
}

export function PlanView({
  state,
  asOf,
  assumptions,
  base,
  onEdit,
}: {
  state: LedgerState;
  asOf: string;
  assumptions: Assumptions;
  base: ModelOutcome;
  onEdit: (result: EditResult) => void;
}) {
  const [question, setQuestion] = useState<Question>("purchase");
  const [purchaseAmount, setPurchaseAmount] = useState(350);
  const [purchaseDate, setPurchaseDate] = useState(asOf);
  const [delayDays, setDelayDays] = useState(3);
  const [billId, setBillId] = useState(String(state.payments[0]?.id ?? ""));
  const [billAmount, setBillAmount] = useState(100);
  const [aside, setAside] = useState(100);
  const [goal, setGoal] = useState("5000");
  const [months, setMonths] = useState("12");
  const [strategy, setStrategy] = useState<"snowball" | "avalanche">("snowball");
  const [extra, setExtra] = useState(100);
  const [debtName, setDebtName] = useState("");
  const [debtBalance, setDebtBalance] = useState("");
  const [debtApr, setDebtApr] = useState("");
  const [debtMin, setDebtMin] = useState("");
  const [debtError, setDebtError] = useState<string | null>(null);

  const purchase = useMemo(
    () =>
      question === "purchase"
        ? evaluatePurchase(state, asOf, assumptions, Math.round(purchaseAmount * 100), purchaseDate)
        : null,
    [question, state, asOf, assumptions, purchaseAmount, purchaseDate]
  );
  const delay = useMemo(
    () => (question === "delay" ? evaluateIncomeDelay(state, asOf, assumptions, delayDays) : null),
    [question, state, asOf, assumptions, delayDays]
  );
  const bill = useMemo(
    () =>
      question === "bill" && billId
        ? evaluateBillAmount(state, asOf, assumptions, billId, Math.round(billAmount * 100))
        : null,
    [question, state, asOf, assumptions, billId, billAmount]
  );
  const asideResult = useMemo(
    () => (question === "aside" ? evaluateMonthlySetAside(state, asOf, assumptions, Math.round(aside * 100)) : null),
    [question, state, asOf, assumptions, aside]
  );

  const goalCents = dollarsToCents(Number(goal));
  const monthCount = Number(months);
  const pace = goalCents === null ? null : evenSetAside(goalCents, monthCount);
  const windowEnd = addDaysIso(asOf, assumptions.horizonDays);
  const sliderMax = Math.max(2500, purchaseAmount);

  let debtResult: { months_to_payoff: number; payoff_date: string; total_interest_cents: number; total_paid_cents: number; did_not_converge?: boolean } | null = null;
  let debtCalcError: string | null = null;
  if (question === "debt" && state.liabilities.length > 0) {
    try {
      debtResult = amortize(asOf, state.liabilities, strategy, Math.round(extra * 100));
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

  function submitDebt(event: React.FormEvent) {
    event.preventDefault();
    const balance = dollarsToCents(Number(debtBalance));
    const min = dollarsToCents(Number(debtMin));
    const apr = aprPercentToBasisPoints(debtApr);
    if (!debtName.trim() || balance === null || min === null || apr === null) {
      setDebtError("Enter a name, the amount you owe, a minimum payment, and a rate such as 21.99.");
      return;
    }
    const result = addInstallmentDebt(state, {
      name: debtName,
      balanceCents: balance,
      aprBasisPoints: apr,
      minPaymentCents: min,
    });
    if (!result.ok) {
      setDebtError(result.error);
      return;
    }
    setDebtError(null);
    setDebtName("");
    onEdit(result);
  }

  return (
    <div className="space-y-4">
      <Panel
        title="Try a decision"
        lede="Each comparison uses the same engine as the rest of the app. Results are estimates from your assumptions, not guarantees. Nothing is saved until you edit the ledger itself."
      >
        <div role="tablist" aria-label="Decisions" className="flex flex-wrap gap-2">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={question === tab.id}
              onClick={() => setQuestion(tab.id)}
              className={`min-h-11 shrink-0 rounded-lg px-3 text-sm font-semibold ${
                question === tab.id ? "bg-accent text-on-accent" : "border border-line bg-inset text-ink"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {question === "purchase" && purchase && (
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div>
              <label className="block text-sm font-medium">
                Purchase Amount: ${purchaseAmount.toLocaleString("en-US")}
                <input
                  className="mt-2 w-full accent-accent"
                  type="range"
                  min={10}
                  max={sliderMax}
                  step={10}
                  value={purchaseAmount}
                  onChange={(e) => setPurchaseAmount(Number(e.target.value))}
                />
              </label>
              <label className="mt-3 block text-sm font-medium">
                Or type an amount ($)
                <input
                  className={`${fieldClass} mt-1`}
                  inputMode="decimal"
                  value={purchaseAmount}
                  onChange={(e) => {
                    const next = Number(e.target.value);
                    if (Number.isFinite(next) && next >= 0) setPurchaseAmount(next);
                  }}
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
            </div>
            <Compare
              title="How this changes the plan"
              base={base}
              next={purchase}
              note={
                purchase.status === "ok"
                  ? purchase.outcome.safeSpendCents >= 0
                    ? "In this simulation the cautious amount stays at or above zero after the purchase. That is a model estimate, not a guarantee."
                    : "In this simulation the cautious amount goes below zero. That is a model estimate, not a guarantee you will overdraw."
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
              note="In this simulation the chance of running short is the share of modeled futures that go negative. It is not a promise that a paycheck will be late."
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
                note="The ending balance here is what would remain in this account, not a savings pile. In this simulation the difference is the cash-flow effect of moving the money out."
              />
            </div>
          </div>
        )}

        {question === "debt" && (
          <div className="mt-4 space-y-4">
            <p className="text-sm text-muted">
              Snowball pays the smallest balance first. Avalanche (APR) pays the highest interest rate first. Both are
              payoff schedules. They are not automatically included in the cash-flow forecast, so a shorter payoff is
              not by itself proof you can afford the extra payment.
            </p>
            {state.liabilities.length === 0 ? (
              <p className="text-sm text-muted">No debts are entered yet.</p>
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
            <ul className="divide-y divide-line">
              {state.liabilities.map((debt) => (
                <li key={debt.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                  <span>
                    {debt.name} · owe {formatMoney(debt.balance_cents)} · {(debt.apr_basis_points / 100).toFixed(2)}% · min{" "}
                    {formatMoney(debt.min_payment_cents)}
                  </span>
                  <Button type="button" variant="quiet" onClick={() => onEdit(removeLiability(state, debt.id))}>
                    Remove {debt.name}
                  </Button>
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
            <Explain term="interest">
              The rate you enter is turned into basis points and used only for this payoff schedule. It does not change
              the cash-flow plan unless you also add the payment as a bill or a recorded expense.
            </Explain>
          </div>
        )}
      </Panel>
    </div>
  );
}
