# MC-07 — Post-Merge Re-Audit and Adoption Map

**Campaign:** MonteCarlo product-wide semantic adoption and legacy retirement
**Status:** audit complete; dispositions applied in this campaign (see §5)
**Audited revisions (default branches, post-MC-06):**

| Repo | Default branch | Revision |
|---|---|---|
| `gthgomez/MonteCarlo-Ledger` | `master` | `cb95280` |
| `gthgomez/MonteCarloLedger-Android` | `main` | `bd79284` |

This map is the answer to one question: **for every number the product shows, which code path
produced it, and does that path conform to Contract 1.x?** It is derived from a read-only audit of
both default branches, not from the previous campaign report.

Legend — `canonical` (contract engine / canonical primitive), `legacy` (competing duplicate
implementation), `non-normative` (documented as outside Contract 1.x), `unknown`.

---

## 1. Ledger (Python) — `cb95280`

| CALCULATION / OUTPUT | Produced by | User-visible? | Contract 1.x? | Class | Action |
|---|---|---|---|---|---|
| `forecast` / `risk` / `safe-to-spend` / `simulate-purchase` / `simulate-paycheck-delay` / `overdraft` (text + `--json`) | `commands.py` → `decisions.py` → `contract.run_scenario` | yes (CLI) | yes | canonical | none |
| `/v1/forecast`, `/v1/risk`, `/v1/safe-to-spend`, `/v1/overdraft`, `/v1/simulate-purchase` | `api.py` → `decisions.py` → contract | yes (API) | yes | canonical | none |
| legacy `/safe-to-spend` (`safe_spend_cents`, `projected_low_point_cents`) | `api.py` → `scenario.build_scenario` → contract | yes (API) | yes | canonical | none |
| interactive "FREE TO SPEND" (timeline dashboard) | `dashboards.render_timeline_dashboard` → `forecasting.calculate_safe_spend` | yes (terminal) | yes — maps to `forecast.minimum_balance_cents` | **legacy** | **MIGRATE** |
| interactive "SAFE DAILY LIMIT" | `forecasting.calculate_daily_safe_spend` | yes (terminal) | no — product heuristic | **legacy** | **KEEP_NON_NORMATIVE** (single canonical helper) |
| interactive 90-Day Forecast (rows, projected end, lowest, first-negative) | `forecasting.build_balance_forecast` / `calculate_forecast_summary` + `timeline_service.build_financial_timeline` | yes (terminal) | yes — `forecast` block | **legacy** | **MIGRATE** |
| interactive 90-Day Risk Outlook (chance of negative, median ending, median lowest, worst-10% ending, trouble date) | `risk.run_monte_carlo` (Mersenne Twister, floor division, floor median) | yes (terminal) | yes — `risk` block | **legacy** | **MIGRATE** |
| interactive "PENDING BILLS" / "FREE TO SPEND" (main summary) | `dashboards.show_summary` (`balance − obligations`, `datetime.now()`) | yes (terminal) | partial (deterministic baseline) | **legacy** | **MIGRATE/REMOVE** |
| Upcoming-30 schedule listing | `workflow_reporting.view_upcoming_30` → `budget_engine.get_upcoming_schedule` | yes (terminal) | no — it is a schedule listing, not a financial conclusion | non-normative | KEEP_NON_NORMATIVE |
| Reporting breakdowns (spend-by-category, flow summary, history) | `db_manager` aggregates | yes (terminal) | no — bookkeeping over posted rows | non-normative | KEEP_NON_NORMATIVE |
| Income occurrence materialization | `timeline_service.generate_income_events` | indirect | yes — recurrence (MCD-0016/0017/0022) | **legacy duplicate** | **MIGRATE** to `scenario.py` / contract `expand` |
| Unpaid bill occurrence retrieval (30-day lookback) | `timeline_service.get_unpaid_bill_events` | indirect | yes — overdue is separate (MCD-0014) | **legacy duplicate** | **MIGRATE** to `scenario.py` |
| Cached-balance validation / reconciliation | `db_manager.validate_balance_consistency` | yes (warning) | ledger bookkeeping, not a projection | non-normative | KEEP |

**Clock leaks still present on the interactive path** (`as_of`-free callers): `dashboards.show_summary`
(`datetime.now()`), `dashboards.render_timeline_dashboard` (`datetime.now()`), and
`timeline_service.build_financial_timeline(as_of=None)` (defaults to `date.today()`). These are
cleared by the migration below.

**CI:** `.github/workflows/contract-conformance.yml` runs `pytest tests/test_contract_conformance.py`,
emits Python canonical results, and runs the dumb comparer against the checked-in Kotlin baseline.

**Site/Vercel:** no site-facing financial integration exists in this repository yet (the `.vercel`
directory is local config only). MC-09 remains a future adapter.

---

## 2. Android (Kotlin) — `bd79284`

`FeatureFlags.contractForecastEnabled` defaults to `true`.

| CALCULATION / OUTPUT | Produced by | User-visible? | Contract 1.x? | Class | Action |
|---|---|---|---|---|---|
| Dashboard headline forecast (lowest, ending, first-negative) | `ContractDashboardMapper` ← `ContractRunner` (flag on) | yes | yes | canonical | none |
| Dashboard/widget Monte Carlo (trough P10/50/90, ending P10/50/90, probability) | `ContractDashboardMapper` ← `ContractRunner` (flag on) | yes | yes | canonical | none |
| Dashboard/widget safe-to-spend | `ContractDashboardMapper` (`risk.safe_to_spend_cents`) | yes | yes | canonical | none |
| `forecastRows` (future cash-flow rows shown in list/cards) | `ForecastEngine.buildBalanceForecast(seed, events)` — native, **flag-independent** | yes | yes — deterministic timeline | **legacy** | **C1 — MIGRATE to canonical timeline** |
| `cashFlowWindows` / `dailyBudgetCents` | `ForecastEngine.buildCashFlowWindows` / `calculateDailySafeSpend` (native) | yes | no | **legacy heuristic** | **C2 — classify PRODUCT_HEURISTIC** |
| `incomeContributionCents` | `ForecastEngine.calculateIncomeContribution` (native) | yes | partial | legacy | classify (product framing) |
| `scheduledBillBurdenCents` | sum of native `events` bills | yes | partial | legacy | derive from canonical events |
| Fan chart (daily 10/50/90 path) | `MonteCarloEngine(...includeDailyPercentiles=true)` — native, overlaid on contract headlines | yes | no — no per-day path in 1.x | **non-normative** | **C4 — keep, document** |
| `MonteCarloCalibrator.calibrate` | native, feeds contract `simulation` params | indirect | calibration deferred (MCD-0015) | non-normative | KEEP (documented) |
| Debt payoff (`DebtPayoffScreen`, `DebtManagementScreen`) | `DebtPayoffEngine.runSimulation` / `minimumPaymentCents` — native, flag-independent | yes | no — needs Contract 2.0 domain | **non-normative** | **C3 — classify CONTRACT_2_CANDIDATE** |
| Widget headline numbers | `MonteCarloLedgerGlanceWidget` (contract when flag on) | yes | yes | canonical | none |
| `BudgetPacingEngine` runway/pacing | native, consumes `safeToSpend` (contract-derived when on) | yes | no | non-normative | KEEP |
| Balance/reconciliation, net worth, category spend, review items | `db_manager`-equivalent repository reads | yes | no — bookkeeping | non-normative | KEEP |

**Reachability:** with the flag on, `TimelineService.generateTimeline` and `ForecastEngine` still run
on every dashboard derivation (rows, cash-flow windows, daily budget, income contribution) and
`MonteCarloEngine` still runs to supply the fan chart. So "flag on" does **not** yet mean "one
engine": the native deterministic timeline is still a second interpretation of the same events.

**Contract pin:** `app/src/test/resources/contract/contract-pin.json` → `source_commit`
`d2e621c4bd609fd5c85b6cdd5275686e8412ba17`, 34 files (8 contract docs, 2 schemas, 24 corpus files).

---

## 3. Reachability conclusions

1. Python CLI/API are fully canonical. The **interactive terminal dashboards are the only
   user-visible Python surface still on legacy semantics** (§1).
2. Android dashboards/widget headline scalars are canonical when the flag is on, but **four native
   paths remain flag-independent**: cash-flow rows, cash-flow windows/`dailyBudgetCents`, income
   contribution, and the fan chart (§2).
3. `dailyBudgetCents`, `DebtPayoffEngine`, and the fan chart are the three Android values that need
   an explicit classification rather than silent adoption (Workstream C).

## 4. Non-goals honored

This campaign does not add Plaid, live bank linking, cloud sync, auth redesign, billing, ads, AI
advice, a TypeScript finance engine, a Rust/KMP rewrite, a UI redesign, or Contract 2.0
implementation. It is adoption, retirement, and evidence.

## 5. Dispositions applied

See `MC-07-legacy-retirement.md` for the final `migrated / deleted / kept non-normative / deferred`
record and the exact test evidence for each change.
