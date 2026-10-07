# MC-04/05 — Python Adoption (structured scenario, decision API, JSON surfaces)

**Milestone:** MC-04 (structured scenario API) + MC-05 (CLI 2.0 / stable JSON)
**Status:** Complete for the new surfaces; interactive terminal dashboards not yet migrated
**Branch:** `campaign/semantic-contract`
**Commit:** `a652693`

## What was built

- `monte_carlo_ledger/scenario.py` — the single DB → canonical-scenario bridge. Explicit `as_of`,
  half-open window, overdue excluded (MCD-0014), income `expected_amount` on the first in-window
  occurrence (MCD-0017). Read-only in-memory projection by default; no clock.
- `monte_carlo_ledger/decisions.py` — goal-oriented operations, all delegating to the contract
  engine: `forecast`, `risk`, `simulate_purchase`, `simulate_paycheck_delay`, `compare_scenarios`,
  `overdraft_risk`.
- `monte_carlo_ledger/commands.py` — non-interactive CLI with stable JSON (`--json`) for
  `forecast`, `risk`, `safe-to-spend`, `simulate-purchase`, `simulate-paycheck-delay`, `overdraft`.
  Wired through `cli.main` and the `python -m monte_carlo_ledger` entry point.
- `monte_carlo_ledger/api.py` — `/v1/forecast`, `/v1/risk`, `/v1/safe-to-spend`, `/v1/overdraft`,
  `/v1/simulate-purchase`; the legacy `/safe-to-spend` now returns contract semantics
  (`projected_low_point_cents` + quantile-based `safe_spend_cents`, MCD-0008).

## Evidence

```
pytest            82 passed
ruff              All checks passed
pyright           clean for the new modules (only pre-existing FastAPI resolution)
CLI smoke         python -m monte_carlo_ledger forecast/safe-to-spend --json on an isolated DB
determinism       scenario.build_scenario called twice -> identical
parity            decisions.forecast == contract.run_scenario(scenario.build_scenario(...))
```

## Disagreements discovered

- Two legacy tests asserted the old meaning of `safe_spend_cents` (the deterministic minimum). Under
  MCD-0008 that value is `projected_low_point_cents`; `safe_spend_cents` is now quantile-based. Tests
  updated to the contract meaning — a deliberate, contract-backed behavior change, not a regression.

## Semantic decisions made

None new. The surfaces encode MCD-0001…0022. `safe_to_spend` semantics come from MCD-0008; probability
is ppm (MCD-0004); the low-point date is never null (MCD-0018).

## Remaining risks

- ~~The **interactive dashboards** still call the legacy `forecasting`/`risk`/`timeline_service`
  functions.~~ **Resolved in MC-07** (`docs/campaign/MC-07-legacy-retirement.md`): the interactive
  dashboards now render from the canonical engine via `dashboard_view.py`, and the four duplicate
  modules were deleted (clearing B-01…B-04).
- `simulate_purchase` forces expense variation off to keep the two runs paired; if expense variation
  is later enabled there, the comparison must control for RNG-stream shifts.
- Recurrence materialization for the DB path uses `budget_engine`; its month-end/anchor behavior is
  not yet itself covered by a DB-origin fixture (the canonical engine is).

## Next parallel work

- Android adoption (MC-06b) — in progress.
- Migrate interactive dashboards onto `decisions`, then delete the duplicate
  `forecasting`/`risk`/`timeline_service` semantics (or reduce them to deprecated shims).
