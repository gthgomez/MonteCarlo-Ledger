import test from "node:test";
import assert from "node:assert/strict";
import { runScenario, timelineRows } from "../engine";

const BASE = {
  contract_version: "2.0",
  scenario_id: "timeline",
  as_of: "2026-01-01",
  horizon_days: 40,
  starting_balance_cents: 100_000,
};

test("same-day income is ordered before bills and reconciles with the forecast", () => {
  const scenario = {
    ...BASE,
    events: [
      { date: "2026-01-10", amount_cents: -50_000, type: "expense", name: "Bill" },
      { date: "2026-01-10", amount_cents: 200_000, type: "income", name: "Pay" },
    ],
  };
  const rows = timelineRows(scenario);
  assert.deepEqual(rows.map((r) => r.name), ["Pay", "Bill"]);
  assert.equal(rows[0].balance_after_cents, 300_000);
  assert.equal(rows[1].balance_after_cents, 250_000);
  assert.equal(
    rows[rows.length - 1].balance_after_cents,
    runScenario(scenario).forecast.ending_balance_cents
  );
});

test("input order does not change results for distinct dates", () => {
  const events = [
    { date: "2026-01-05", amount_cents: -1_000, type: "expense", name: "A" },
    { date: "2026-01-07", amount_cents: 5_000, type: "income", name: "B" },
    { date: "2026-01-09", amount_cents: -2_000, type: "expense", name: "C" },
  ];
  assert.deepEqual(
    timelineRows({ ...BASE, events }),
    timelineRows({ ...BASE, events: [...events].reverse() })
  );
});

test("two same-day expenses keep their explicit input order", () => {
  const rows = timelineRows({
    ...BASE,
    events: [
      { date: "2026-01-10", amount_cents: -1_000, type: "expense", name: "First" },
      { date: "2026-01-10", amount_cents: -2_000, type: "expense", name: "Second" },
    ],
  });
  assert.deepEqual(rows.map((r) => r.name), ["First", "Second"]);
});

test("the displayed trough matches the canonical forecast minimum", () => {
  const scenario = {
    ...BASE,
    starting_balance_cents: 10_000,
    events: [
      { date: "2026-01-02", amount_cents: -15_000, type: "expense", name: "Rent" },
      { date: "2026-01-05", amount_cents: 20_000, type: "income", name: "Pay" },
    ],
  };
  const rows = timelineRows(scenario);
  const displayedMin = Math.min(...rows.map((r) => r.balance_after_cents));
  assert.equal(displayedMin, runScenario(scenario).forecast.minimum_balance_cents);
  assert.equal(displayedMin, -5_000);
});
