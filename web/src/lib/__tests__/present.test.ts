import assert from "node:assert/strict";
import test from "node:test";

import { SAMPLE_LEDGER_STATE } from "../types";
import { formatProbability } from "../money-format";
import {
  beyondWindowBillNotice,
  buildInsights,
  cashMinusEnteredDebt,
  categoryOverages,
  describePosition,
  evenSetAside,
  formatCautiousSpend,
  recordedSpending,
  slicePlan,
  spendingDeltaNote,
  spendingGuidanceIssue,
  spendingLastMonth,
  spendingThisMonth,
  transactionSumCents,
} from "../present";
import { addDaysIso } from "../dates";

const AS_OF = "2026-11-10";

test("probability text does not round a tiny chance to 0.0%", () => {
  assert.equal(formatProbability(0), "0%");
  assert.equal(formatProbability(50), "under 0.1%");
  assert.equal(formatProbability(150_000), "15%");
  assert.equal(formatProbability(5_000), "0.5%");
  assert.equal(formatProbability(999_500), "over 99.9%");
  assert.equal(formatProbability(999_999), "over 99.9%");
  assert.equal(formatProbability(1_000_000), "100%");
});

test("plan slice uses contract rows and does not invent events", () => {
  const slice = slicePlan(
    [
      { date: "2026-11-12", name: "Pay", type: "income", amount_cents: 100_00, balance_after_cents: 200_00 },
      { date: "2026-11-20", name: "Rent", type: "expense", amount_cents: -80_00, balance_after_cents: 120_00 },
      { date: "2026-12-20", name: "Later", type: "expense", amount_cents: -10_00, balance_after_cents: 110_00 },
    ],
    AS_OF,
    30,
    100_00
  );
  assert.equal(slice.events.length, 2);
  assert.equal(slice.scheduledIncomeCents, 100_00);
  assert.equal(slice.scheduledOutflowCents, 80_00);
  assert.equal(slice.plannedEndingCents, 120_00);
  assert.equal(slice.plannedLowCents, 100_00);
});

test("an empty window keeps the starting balance", () => {
  const slice = slicePlan([], AS_OF, 30, 345_000);
  assert.equal(slice.events.length, 0);
  assert.equal(slice.plannedEndingCents, 345_000);
  assert.equal(slice.scheduledOutflowCents, 0);
});

test("missing bill dates withhold spending guidance even when another bill is scheduled", () => {
  const state = {
    payments: [
      { id: "dated", recurrence: "Monthly" as const, name: "Dated bill", due_day: 15, amount_cents: 2000 },
      { id: "undated", recurrence: "Monthly" as const, name: "Undated bill", amount_cents: 3000 },
    ],
    bill_occurrences: [],
  };
  const rows = [{
    date: "2026-11-15", name: "Dated bill", type: "expense", amount_cents: -2000, balance_after_cents: 8000,
  }];
  assert.match(spendingGuidanceIssue(state, rows, AS_OF) ?? "", /missing a date/);
  const complete = { ...state, payments: [state.payments[0]] };
  assert.match(spendingGuidanceIssue(complete, [], AS_OF) ?? "", /in this plan window/);
  assert.equal(spendingGuidanceIssue(complete, rows, AS_OF), null);
});

test("an unresolved past one-time bill withholds guidance but keeps the known schedule", () => {
  const state = {
    payments: [
      {
        id: "repair",
        name: "Car repair",
        amount_cents: 90_000,
        recurrence: "One-time" as const,
        due_date: "2026-11-09",
      },
      {
        id: "subscription",
        name: "Subscription",
        amount_cents: 1_000,
        recurrence: "Monthly" as const,
        due_day: 15,
      },
    ],
    bill_occurrences: [],
  };
  const rows = [{
    date: "2026-11-15", name: "Subscription", type: "expense", amount_cents: -1_000, balance_after_cents: 99_000,
  }];
  const issue = spendingGuidanceIssue(state, rows, AS_OF);
  assert.match(issue ?? "", /Car repair/);
  assert.match(issue ?? "", /\$900\.00/);
  assert.match(issue ?? "", /Nov 9, 2026 \(2026-11-09\)/);
  assert.match(issue ?? "", /has no linked bill record/);
  assert.match(issue ?? "", /not that no payment was made/);
  assert.match(issue ?? "", /mark it paid if your current cash already reflects the payment/);
  assert.match(issue ?? "", /record a new expense only if neither Money nor your current cash reflects it/);
  // The in-window bill is still shown; only the cautious advice is withheld.
  assert.deepEqual(rows.map((row) => row.amount_cents), [-1_000]);
});

test("paid or moved one-time slots do not withhold guidance", () => {
  const base = {
    payments: [{
      id: "repair",
      name: "Car repair",
      amount_cents: 90_000,
      recurrence: "One-time" as const,
      due_date: "2026-11-09",
    }],
    bill_occurrences: [],
  };
  const rows = [{
    date: "2026-11-15", name: "Subscription", type: "expense", amount_cents: -1_000, balance_after_cents: 99_000,
  }];
  const paid = {
    ...base,
    bill_occurrences: [{
      id: "occ-paid", payment_id: "repair", due_date: "2026-11-09", paid: true,
      transaction_id: null,
    }],
  };
  assert.equal(spendingGuidanceIssue(paid, rows, AS_OF), null);
  const moved = {
    ...base,
    bill_occurrences: [{
      id: "occ-moved", payment_id: "repair", due_date: "2026-11-20",
      original_due_date: "2026-11-09", paid: false, is_user_modified: true,
    }],
  };
  assert.equal(spendingGuidanceIssue(moved, rows, AS_OF), null);
  const movedThenPaid = {
    payments: [{ ...base.payments[0], due_date: "2026-11-09" }],
    bill_occurrences: [{
      id: "occ-moved-paid", payment_id: "repair", due_date: "2026-11-09", original_due_date: "2026-11-05",
      paid: true, is_user_modified: true,
    }],
  };
  assert.equal(spendingGuidanceIssue(movedThenPaid, rows, AS_OF), null);
});

test("a one-time bill after the window is informational and does not withhold in-window guidance", () => {
  const horizonDays = 30;
  const windowEnd = addDaysIso(AS_OF, horizonDays);
  const state = {
    payments: [
      { id: "in-window", name: "Subscription", amount_cents: 1_000, recurrence: "Monthly" as const, due_day: 15 },
      { id: "far", name: "Car repair", amount_cents: 90_000, recurrence: "One-time" as const, due_date: windowEnd },
    ],
    bill_occurrences: [],
  };
  const rows = [{
    date: "2026-11-15", name: "Subscription", type: "expense", amount_cents: -1_000, balance_after_cents: 99_000,
  }];
  assert.equal(spendingGuidanceIssue(state, rows, AS_OF), null);
  const notice = beyondWindowBillNotice(state, AS_OF, horizonDays);
  assert.match(notice ?? "", /Car repair/);
  assert.match(notice ?? "", /\$900\.00/);
  assert.match(notice ?? "", new RegExp(`${windowEnd}`));
  assert.match(notice ?? "", /Extend the plan window under Advanced/);
});

test("the beyond-window notice uses half-open dates and respects paid and moved slots", () => {
  const horizonDays = 30;
  const windowEnd = addDaysIso(AS_OF, horizonDays);
  const lastIncluded = addDaysIso(windowEnd, -1);
  const payment = {
    id: "repair", name: "Car repair", amount_cents: 90_000,
    recurrence: "One-time" as const, due_date: windowEnd,
  };
  assert.equal(beyondWindowBillNotice({ payments: [{ ...payment, due_date: lastIncluded }], bill_occurrences: [] }, AS_OF, horizonDays), null);
  assert.equal(
    beyondWindowBillNotice({ payments: [payment], bill_occurrences: [
      { id: "occ-paid", payment_id: "repair", due_date: windowEnd, paid: true },
    ] }, AS_OF, horizonDays),
    null
  );
  assert.equal(
    beyondWindowBillNotice({ payments: [payment], bill_occurrences: [
      { id: "occ-moved-in", payment_id: "repair", due_date: lastIncluded, original_due_date: windowEnd, paid: false, is_user_modified: true },
    ] }, AS_OF, horizonDays),
    null
  );
  const movedOut = beyondWindowBillNotice({ payments: [payment], bill_occurrences: [
    { id: "occ-moved-out", payment_id: "repair", due_date: addDaysIso(windowEnd, 5), original_due_date: windowEnd, paid: false, is_user_modified: true },
  ] }, AS_OF, horizonDays);
  assert.match(movedOut ?? "", new RegExp(addDaysIso(windowEnd, 5)));
  assert.doesNotMatch(movedOut ?? "", new RegExp(`\\(${windowEnd}\\)`));
  const occurrenceOnly = { id: "occ-only", payment_id: "repair", due_date: windowEnd, paid: false };
  assert.match(
    beyondWindowBillNotice({ payments: [{ ...payment, due_date: null }], bill_occurrences: [occurrenceOnly] }, AS_OF, horizonDays) ?? "",
    new RegExp(windowEnd)
  );
  assert.equal(
    beyondWindowBillNotice({ payments: [payment], bill_occurrences: [
      { ...occurrenceOnly, original_due_date: lastIncluded, is_user_modified: true, paid: true },
    ] }, AS_OF, horizonDays),
    null
  );
});

test("recurring and past one-time bills are not reported as beyond-window obligations", () => {
  const state = {
    payments: [
      { id: "far-monthly", name: "Insurance", amount_cents: 10_000, recurrence: "Monthly" as const, due_day: 1 },
      { id: "past", name: "Old repair", amount_cents: 5_000, recurrence: "One-time" as const, due_date: "2026-11-09" },
    ],
    bill_occurrences: [],
  };
  assert.equal(beyondWindowBillNotice(state, AS_OF, 30), null);
});

test("recorded spending ignores future expenses and non-expense rows", () => {
  const summary = recordedSpending(
    [
      ...SAMPLE_LEDGER_STATE.transactions,
      {
        id: "future",
        amount_cents: -9_999,
        type: "Expense",
        category: "Dining",
        date: "2026-11-20",
        description: "not spent yet",
      },
    ],
    "2026-10-11",
    "2026-11-11",
    AS_OF
  );
  assert.equal(summary.totalCents, 7_500);
  assert.deepEqual(summary.byCategory, [{ category: "Utilities", cents: 7_500 }]);
});

test("this calendar month and last month stay separate", () => {
  const current = spendingThisMonth(SAMPLE_LEDGER_STATE.transactions, AS_OF);
  const previous = spendingLastMonth(SAMPLE_LEDGER_STATE.transactions, AS_OF);
  assert.equal(current.totalCents, 0);
  assert.equal(previous.totalCents, 7_500);
  const note = spendingDeltaNote(current.totalCents, previous.totalCents);
  assert.match(note ?? "", /No spending is recorded this month/);
  assert.doesNotMatch(note ?? "", /more than last month/);
});

test("a higher month is described only when both months have spending", () => {
  assert.match(spendingDeltaNote(12_000, 7_500) ?? "", /more than last month/);
  assert.match(spendingDeltaNote(4_000, 0) ?? "", /not a comparison/);
});

test("category overage requires a target the user set", () => {
  assert.deepEqual(categoryOverages([{ category: "Dining", cents: 4_000 }], {}), []);
  const rows = categoryOverages([{ category: "Dining", cents: 4_000 }], { Dining: 2_500 });
  assert.equal(rows[0].overCents, 1_500);
});

test("sample ledger balance matches its transactions", () => {
  assert.equal(transactionSumCents(SAMPLE_LEDGER_STATE.transactions), SAMPLE_LEDGER_STATE.current_balance_cents);
});

test("cash minus entered debt is subtraction, not net worth", () => {
  assert.equal(cashMinusEnteredDebt(345_000, SAMPLE_LEDGER_STATE.liabilities), 345_000 - 240_000 - 850_000);
});

test("archived debts do not change the cash summary", () => {
  const archived = SAMPLE_LEDGER_STATE.liabilities.map((debt) => ({ ...debt, is_active: false }));
  assert.equal(cashMinusEnteredDebt(345_000, archived), 345_000);
});

test("position copy uses the figures it is given and does not call the median an expected value", () => {
  const copy = describePosition({
    recordedBalanceCents: 345_000,
    scheduledIncomeCents: 220_000,
    scheduledBillCents: 72_000,
    plannedEndingCents: 113_000,
    windowDays: 30,
    safeSpendCents: 80_000,
    reserveCents: 0,
    quantileNum: 1,
    quantileDen: 10,
    runs: 500,
    isDemo: true,
    hasSchedule: true,
  });
  assert.match(copy.lead, /\$3,450\.00/);
  assert.match(copy.lead, /\$720\.00/);
  assert.match(copy.lead, /\$800\.00/);
  assert.match(copy.lead, /sample household/);
  assert.match(copy.caution, /not a guarantee/);
  assert.match(copy.caution, /matches that modeled low point/);
  assert.equal(copy.technicalName, "Safe to Spend (P10)");
  assert.doesNotMatch(`${copy.lead} ${copy.caution}`, /expected value|90% of/i);
});

test("a negative cautious amount is not described as money you could spend", () => {
  const copy = describePosition({
    recordedBalanceCents: 100,
    scheduledIncomeCents: 0,
    scheduledBillCents: 5_000,
    plannedEndingCents: -4_900,
    windowDays: 30,
    safeSpendCents: -4_000,
    reserveCents: 10_000,
    quantileNum: 1,
    quantileDen: 10,
    runs: 100,
    isDemo: false,
    hasSchedule: true,
  });
  assert.match(copy.lead, /no cautious amount left to spend/);
  assert.match(copy.lead, /short of your reserve by \$40\.00/);
  assert.doesNotMatch(copy.lead, /the low point is -\$40/);
  assert.doesNotMatch(copy.lead, /you could spend/);
});

test("negative modeled cash with no reserve is a shortfall, not a reserve gap", () => {
  const input = {
    recordedBalanceCents: 100,
    scheduledIncomeCents: 0,
    scheduledBillCents: 5_000,
    plannedEndingCents: -4_900,
    windowDays: 30,
    safeSpendCents: -4_900,
    reserveCents: 0,
    quantileNum: 1,
    quantileDen: 10,
    runs: 100,
    isDemo: false,
    hasSchedule: true,
  };
  assert.match(describePosition(input).lead, /the low point is -\$49\.00 \(below zero\)/);
  assert.doesNotMatch(describePosition(input).lead, /short of your reserve/);
  assert.doesNotMatch(describePosition({ ...input, safeSpendCents: null }).lead, /cautious|modeled/);
  assert.equal(formatCautiousSpend(-4_900, 0), "None ($49.00 modeled cash shortfall)");
  assert.equal(formatCautiousSpend(-4_900, 10_000), "None ($49.00 below reserve)");
});

test("custom quantile copy matches the same trough used for safe-to-spend", () => {
  const trough = 70_000;
  const reserve = 5_000;
  const copy = describePosition({
    recordedBalanceCents: 100_000,
    scheduledIncomeCents: 0,
    scheduledBillCents: 0,
    plannedEndingCents: 100_000,
    windowDays: 30,
    safeSpendCents: trough - reserve,
    reserveCents: reserve,
    quantileNum: 1,
    quantileDen: 5,
    runs: 200,
    isDemo: false,
    hasSchedule: false,
  });
  assert.equal(copy.technicalName, "Safe to spend (nearest-rank 1/5)");
  assert.doesNotMatch(copy.caution, /matches that modeled low point/);
});

test("insights do not invent a grocery comparison", () => {
  const insights = buildInsights({
    asOf: AS_OF,
    isDemo: true,
    incomeCount: 1,
    paymentCount: 1,
    overdueCount: 0,
    overdueCents: 0,
    overdueEarliest: null,
    firstNegativeDate: null,
    nextBill: {
      date: "2026-11-14",
      name: "Internet",
      type: "expense",
      amount_cents: -7_500,
      balance_after_cents: 100,
    },
    spendingNote: spendingDeltaNote(0, 7_500),
    overage: null,
    safeSpendCents: 1_000,
    reserveCents: 0,
    overdraftPpm: 0,
    runs: 500,
    ledgerMatches: true,
  });
  const text = insights.map((item) => `${item.title} ${item.detail}`).join("\n");
  assert.match(text, /Internet is due in 4 days/);
  assert.match(text, /already included in the plan/);
  assert.doesNotMatch(text, /grocery|dining/i);
  assert.doesNotMatch(text, /more than last month/);
});

test("overdue insight says the plan counts recorded unpaid occurrences and flags missing ones", () => {
  const insights = buildInsights({
    asOf: AS_OF,
    isDemo: false,
    incomeCount: 1,
    paymentCount: 1,
    overdueCount: 2,
    overdueCents: 4_200,
    overdueEarliest: "2026-11-01",
    firstNegativeDate: null,
    nextBill: null,
    spendingNote: null,
    overage: null,
    safeSpendCents: 100,
    reserveCents: 0,
    overdraftPpm: 0,
    runs: 10,
    ledgerMatches: true,
  });
  const overdue = insights.find((item) => item.id === "overdue");
  assert.ok(overdue);
  assert.match(overdue.detail, /\$42\.00/);
  assert.match(overdue.detail, /Recorded unpaid occurrences are counted today/);
  assert.match(overdue.detail, /no linked bill record stays out until you review its payment status in Bills/);
});

test("even set-aside is integer division with a remainder, not a forecast", () => {
  assert.deepEqual(evenSetAside(5_000_00, 12), { perMonthCents: 416_66, remainderCents: 8 });
  assert.equal(evenSetAside(0, 12), null);
});
