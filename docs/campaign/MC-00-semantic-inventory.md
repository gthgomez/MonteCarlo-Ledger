# MC-00 — Cross-Engine Semantic Inventory

**Campaign:** MonteCarlo semantic foundation (Approach A: contract-first, fixture-driven,
dual-native conformance)
**Status:** Complete — audit only, no engine behavior changed
**Date:** 2026-10-06
**Audited revisions:**

| Repo | Branch / revision | License |
|---|---|---|
| `MonteCarlo-Ledger` (Python) | `master` @ `cbe0dec` (audited; campaign branch `campaign/semantic-contract`) | MIT |
| `MonteCarloLedger-Android` (Kotlin) | `main` @ `6e41892` | Proprietary / source-available |

**Method:** read-only source audit of both financial cores by independent agents. Every claim
below carries a `file:line` citation. No implementation was modified. No implementation is
assumed correct when the two disagree.

Classification vocabulary: `AGREE`, `PYTHON_ONLY`, `KOTLIN_ONLY`, `AMBIGUOUS`, `LIKELY_BUG`,
`SEMANTIC_DECISION_REQUIRED`.

---

## 1. Executive summary

The two engines share a real philosophy — integer-cent money, ledger-authoritative balance,
deterministic forecast first and a bounded Monte Carlo overlay second, income-before-bills on the
same day, uniform uncertainty, default seed 42, default 500 runs. The product thesis is therefore
already common ground.

They nevertheless differ on **the exact semantics that decide numerical answers**. The most
consequential divergences are:

1. **Time has no explicit seam.** Neither engine has `as_of`. Python reads the wall clock directly
   (`datetime.now()`) in the simulation path, so even a seeded run is not reproducible across
   days. Kotlin injects a `today: LocalDate` with a `now()` default, but the concept is still
   "today", not "as-of".
2. **Horizon boundary convention differs.** Python's window is inclusive of the end date (a
   "30-day" horizon spans 31 dates); Kotlin's is half-open `[start, start+daysAhead)` (exactly 30
   dates) plus a 91-point daily grid.
3. **Percentile and median conventions differ, and Kotlin internally uses two different percentile
   formulas.**
4. **Risk quantities differ in kind.** Kotlin surfaces percentiles of the *trough* as "P10/P50/P90";
   Python returns a "worst 10% *ending* balance" plus median ending and median lowest. The same
   label means different things on the two surfaces.
5. **RNG streams are different** (Python Mersenne Twister vs Kotlin's default PRNG), so "same seed
   → same answer" is currently false across engines.
6. **`safe_to_spend` is under-defined in both**: both return the minimum running balance and both
   label it as a spendable amount.
7. **Probability units are unversioned floats** (percent 0–100) in both, with no schema to pin
   them; Kotlin additionally ignores an already-negative opening balance when counting negatives.
8. **Scope asymmetry:** Kotlin has multiple accounts, credit-card/debt routing, and per-category
   expense variation; Python has none of these. Python has a bill-occurrence/obligation model and
   a 30-day past-due lookback that Kotlin models differently.

None of these are reasons to abandon either engine. They are exactly the set of things a canonical
contract exists to pin down.

---

## 2. Dimension-by-dimension comparison

### 2.1 Money

| Aspect | Python | Kotlin | Classification |
|---|---|---|---|
| Representation | `int` cents, `INTEGER` columns (`schema.sql:7,16,25`) | `Long` cents, `INTEGER` columns (`TransactionEntity.kt:19`) | `AGREE` |
| Input rounding | `Decimal` + `ROUND_HALF_UP` (`budget_engine.py:33`) | `BigDecimal` + `HALF_UP` (`MoneyUtils.kt:23-32`) | `AGREE` |
| Percentage scaling | floor division `//` (`risk.py:26`) | `BigDecimal` `HALF_UP` (`MoneyUtils.kt:50-55`) | `SEMANTIC_DECISION_REQUIRED` (Python `LIKELY_BUG`) |
| Median (even N) | `(a+b)//2` floor (`risk.py:104`) | overflow-safe midpoint `a+(b-a)/2` (`MonteCarloEngine.kt:313-325`) | `SEMANTIC_DECISION_REQUIRED` |
| Currency | implicit USD, `$` hardcoded (`ui.py:49-53`) | implicit USD, `$` hardcoded (`MoneyDisplay.kt:22`) | `AGREE` (single-currency assumption) |
| Overflow | no guard; SQLite may promote to REAL then raise (`db_manager.py:472-476`) | debt guarded (`DebtPayoffEngine.kt:235-241`); MC unguarded | `LIKELY_BUG` (both) |
| Parsing surface | strips `$`/`,`; accepts negatives at parser level, guarded in UI (`budget_engine.py:19-36`) | rejects `$`/`,`; `BigDecimal` (accepts `1e3`) (`MoneyUtils.kt:24-31`) | `SEMANTIC_DECISION_REQUIRED` (presentation, not core) |

Dead code worth noting: Python `to_cents` uses banker's rounding but is never called
(`budget_engine.py:11-13`); Kotlin `starting_balance` setting is persisted but never read.

### 2.2 Time

| Aspect | Python | Kotlin | Classification |
|---|---|---|---|
| Explicit `as_of` | absent (zero matches) | absent; nearest is `today: LocalDate` | `SEMANTIC_DECISION_REQUIRED` |
| Clock seam | direct `datetime.now()` in ~12 sites incl. `risk.py:33`, `timeline_service.py:106` | injected `today` with `now()` default; direct `now()` in UI/repo | `KOTLIN_ONLY` (Kotlin has a seam) |
| Determinism of seeded run | broken across days (`risk.py:33`) | deterministic for fixed `today`+seed | `LIKELY_BUG` (Python) |
| Timezone | naive local `datetime` (has time-of-day) | date-only `LocalDate`; `now()` only in UI/audit | `AMBIGUOUS` |
| Horizon boundary | inclusive end → `30` spans 31 dates (`budget_engine.py:154,170,185`) | half-open `[start, start+daysAhead)` → 30 dates; 91-point daily grid (`TimelineService.kt`, `MonteCarloEngine.kt:112,245-260`) | `SEMANTIC_DECISION_REQUIRED` |
| Same-day ordering | income (0) before bills (1) (`timeline_service.py:101`) | income before all non-income (`ForecastEngine.kt:7-8`) | `AGREE` |
| Past-due handling | 30-day lookback for bills; income walks from `next_payday` (`timeline_service.py:10,63`) | every past unpaid occurrence emitted once on `startDate` (`TimelineService.kt:67-101`) | `AMBIGUOUS` |
| Recurrence month-end | anchor preserved via `due_day` (`budget_engine.py:175-188`) | anchor lost when `day_of_month` null (`RecurrenceMath.kt:33,81-84`) | `LIKELY_BUG` (Kotlin edge) |
| Leap year | Feb-29-aware (`budget_engine.py:38-53`) | Feb-29-aware (`RecurrenceMathTest.kt:56-65`) | `AGREE` |
| `expected_amount` | applied to first emitted occurrence; silently dropped if first payday < start (`timeline_service.py:63-85`) | applied to first emitted occurrence (catch-up keeps it) (`TimelineService.kt:69,86`) | `LIKELY_BUG` (Python edge) |

### 2.3 Accounts and ledger

| Aspect | Python | Kotlin | Classification |
|---|---|---|---|
| Balance authority | `SUM(transactions.amount)` (`db_manager.py:317-322`) | `SUM(amount_cents)` (`DashboardDeriver.kt:78`, `TransactionDao.kt:40`) | `AGREE` |
| Cached / stored balance | `settings.current_balance` + reconciliation (`db_manager.py:324-342`) | `bank_balance_cents` + reconciliation (`LedgerRepository.kt:547-552`) | `AGREE` (concept) |
| Sign rules | income>0, expense<0, adjustment any (`domain_rules.py:4-9`) | same (`DomainRules.kt:10-25`) | `AGREE` |
| Starting balance | seeded via an Adjustment txn; no field | `starting_balance` setting exists but is dead; opening = reconciled bank or ledger (`AppDatabase.kt:82`) | `AMBIGUOUS` |
| Multiple accounts | none | `AccountEntity`, one default drives pipeline (`LedgerRepository.kt:93-102`) | `KOTLIN_ONLY` (Python lacks) |
| Transfers | none | none | `AGREE` (both absent) |
| Credit/debt routing | none | credit charge to linked debt reduces debt, not cash (`LedgerRepository.kt:982-997`) | `KOTLIN_ONLY` |
| Pending vs posted | no pending concept | `ClearingStatus` exists but pending counts in balances (`TransactionDao.kt:40`) | `SEMANTIC_DECISION_REQUIRED` |
| Recurring income | `income` table with `next_payday` advanced on payday (`workflow_income.py:178-187`) | `IncomeEntity` with `next_date` advanced idempotently (`LedgerRepository.kt:498-538`) | `AGREE` (concept) |
| Recurring expense | `payments` → `bill_occurrences` (`schema.sql:13-46`) | `PaymentEntity` → `BillOccurrenceEntity` (`BillOccurrenceEntity.kt`) | `AGREE` (concept) |

### 2.4 Forecast (deterministic)

| Aspect | Python | Kotlin | Classification |
|---|---|---|---|
| Min balance includes starting | yes (`forecasting.py:54`) | yes (`ForecastEngine.kt:41-51`) | `AGREE` |
| Min date when no dip | `None` (strict `<`) (`forecasting.py:63-65`) | `null` (`ForecastEngine.kt:175-178`) | `AMBIGUOUS` |
| First negative date | first row with `balance_after < 0` (`forecasting.py:67`) | first event driving below 0; ignores opening-negative (`MonteCarloEngine.kt:256-258`) | `LIKELY_BUG` (Kotlin) |
| Ending balance | last `balance_after` (`forecasting.py:57,61`) | last row (`ForecastEngine.kt:170`) | `AGREE` |
| Default horizon | 30 (`api.py:25`) / 90 dashboard (`dashboards.py:174`) | 90 everywhere (`DashboardDeriver.kt:89,101`) | `AMBIGUOUS` |
| Order affects result | by design (`forecasting.py:37`) | by design (`ForecastEngine.kt:158`) | `AGREE` |

### 2.5 Simulation (Monte Carlo)

| Aspect | Python | Kotlin | Classification |
|---|---|---|---|
| Default runs | 500 (`monte_carlo_config.py`) | 500 (widget 100) (`MonteCarloEngine.kt:9-28`) | `AGREE` |
| Default seed | 42 | 42 | `AGREE` |
| PRNG algorithm | Mersenne Twister (`random.Random`) | Kotlin default `Random` | `SEMANTIC_DECISION_REQUIRED` |
| Seed determinism | not cross-day (`risk.py:33`) | deterministic for fixed `today`+seed | `LIKELY_BUG` (Python) |
| Income variation | uniform int percent −8..8, floor-divide apply (`risk.py:22-28`) | uniform int percent −8..8, HALF_UP apply (`MonteCarloEngine.kt:168-176`) | `SEMANTIC_DECISION_REQUIRED` |
| Expense variation | none | scalar + per-category ranges (`MonteCarloEngine.kt:176-189`) | `KOTLIN_ONLY` |
| Surprise model | Bernoulli p=0.15 per 14-day bucket, amount 2000..15000 (`risk.py:32-56`) | same parameters, bucket anchored to `today` (`MonteCarloEngine.kt:193-219`) | `AMBIGUOUS` |
| Correlation | none | none | `AGREE` |
| Distribution | uniform/discrete | uniform/discrete | `AGREE` |
| Tail percentile | `ceil(0.10*n)-1` nearest-rank (`risk.py:109-110`) | `ceil(N*p)-1` nearest-rank (`MonteCarloEngine.kt:303-311`) | `AGREE` |
| Median percentile | floor midpoint (`risk.py:104`) | averaged midpoint (`MonteCarloEngine.kt:313-325`) | `SEMANTIC_DECISION_REQUIRED` |
| Calibrator percentile | n/a | `(p*(N-1)).toInt()` — different formula (`MonteCarloCalibrator.kt:200`) | `LIKELY_BUG` (Kotlin internal inconsistency) |

### 2.6 Risk and terminology

| Aspect | Python | Kotlin | Classification |
|---|---|---|---|
| Headline percentile quantity | `worst_10_percent_ending_balance`, `median_ending`, `median_lowest` (`risk.py:124-135`) | P10/P50/P90 of per-run **trough** (`MonteCarloEngine.kt:99-104,144-149`) | `SEMANTIC_DECISION_REQUIRED` |
| Probability of negative | count runs with any `balance_after<0` ÷ runs, percent float (`risk.py:122`) | same but ignores opening-negative, percent float (`MonteCarloEngine.kt:150`) | `LIKELY_BUG` (Kotlin) + units decision |
| Probability units | percent 0–100, untyped dict (`api.py:47-50`) | percent 0–100 (`MonteCarloEngine.kt:150`) | `SEMANTIC_DECISION_REQUIRED` |
| `safe_to_spend` | min running balance; docstring says "max safe-spend before next income" (`forecasting.py:4-17`) | same math; UI caption switches between "Safe to spend" and "Lowest balance" (`DashboardDeriver.kt:443-447`) | `SEMANTIC_DECISION_REQUIRED` |
| Reserve | none | none | `AGREE` (both none) |
| "Worst/best case" labels | "Worst 10% Ending Balance" (`dashboards.py:142`) | "worst/best case" on trough percentiles (`DashboardForecastCards.kt:171,180`) | `SEMANTIC_DECISION_REQUIRED` |
| Competing "free to spend" | `show_summary` uses `balance − obligations` (`dashboards.py:59-87`) | `MonthlySpendingPlan` / cash-flow windows (`ForecastEngine.kt:59-125`) | `AMBIGUOUS` |

### 2.7 Output surfaces

| Aspect | Python | Kotlin | Classification |
|---|---|---|---|
| Machine-readable output | API only; `GET /safe-to-spend` untyped dict; no CLI JSON (`api.py:47-50`) | backup JSON snapshot; no query API | `AMBIGUOUS` |
| Schema for results | none (no response_model) | backup schema v6 (`BackupSnapshot.kt:3-31`) | `SEMANTIC_DECISION_REQUIRED` |
| Units pinned anywhere | no | no | `SEMANTIC_DECISION_REQUIRED` |

---

## 3. Disagreement register

Ordered by materiality. "Decision" points to the MonteCarlo Decision (MCD) record to be created in
MC-01.

| # | Topic | Python | Kotlin | Classification | MCD |
|---|---|---|---|---|---|
| D-01 | Explicit `as_of` required by every engine call | implicit `now()` | injected `today` default `now()` | `SEMANTIC_DECISION_REQUIRED` | MCD-0001 |
| D-02 | Horizon boundary | inclusive `[as_of, as_of+N]` (N+1 dates) | half-open `[as_of, as_of+N)` (N dates) | `SEMANTIC_DECISION_REQUIRED` | MCD-0002 |
| D-03 | Same-day ordering (income first) | income<bill | income<all-non-income | `AGREE` — pin explicitly | MCD-0003 |
| D-04 | Probability units | percent float | percent float | `SEMANTIC_DECISION_REQUIRED` | MCD-0004 |
| D-05 | Percentile/median convention | nearest-rank tail, floor median | nearest-rank tail, averaged median, plus a second calibrator formula | `SEMANTIC_DECISION_REQUIRED` | MCD-0005 |
| D-06 | PRNG and draw order | Mersenne Twister | Kotlin `Random` | `SEMANTIC_DECISION_REQUIRED` | MCD-0006 |
| D-07 | Percentage scaling rounding | floor (`//`) | HALF_UP | `LIKELY_BUG` (Python) → HALF_UP | MCD-0007 |
| D-08 | `safe_to_spend` definition and name | min running balance, misleading label | min running balance, ambiguous label | `SEMANTIC_DECISION_REQUIRED` | MCD-0008 |
| D-09 | Risk percentile quantity (trough vs ending) | both-ish | trough | `SEMANTIC_DECISION_REQUIRED` | MCD-0009 |
| D-10 | Opening-negative balance and first-negative-date / probability | first row `<0`; ignores start | ignores opening-negative event entirely | `LIKELY_BUG` (Kotlin) | MCD-0010 |
| D-11 | Pending vs posted in balance | no pending | pending counts | `SEMANTIC_DECISION_REQUIRED` | MCD-0011 |
| D-12 | Multi-account / transfers | absent | accounts exist, no transfers | `SEMANTIC_DECISION_REQUIRED` (scope) | MCD-0012 |
| D-13 | Starting balance representation | via Adjustment seed | dead `starting_balance` setting | `SEMANTIC_DECISION_REQUIRED` | MCD-0013 |
| D-14 | Past-due / catch-up emission | 30-day bill lookback | all past occurrences on `as_of` | `AMBIGUOUS` | MCD-0014 |
| D-15 | Expense variation / category variation | absent | present | `SEMANTIC_DECISION_REQUIRED` (scope) | MCD-0015 |
| D-16 | Recurrence anchor with null `day_of_month` | preserved | lost | `LIKELY_BUG` (Kotlin) | MCD-0016 |
| D-17 | `expected_amount` when first payday precedes `as_of` | dropped | preserved | `LIKELY_BUG` (Python) | MCD-0017 |
| D-18 | Minimum-balance date when no dip | `None` | `null` | `AMBIGUOUS` | MCD-0018 |
| D-19 | Currency model | implicit USD | implicit USD | `AGREE` — pin as single-currency v1 | MCD-0019 |
| D-20 | Overflow policy | unguarded | partial | `LIKELY_BUG` | MCD-0020 |

---

## 4. Confirmed likely bugs (independent of the other engine)

These are defects against the engines' own stated intent:

- **B-01 (Python)** — seeded Monte Carlo is not reproducible across days: `risk.py:33` anchors
  surprise generation to `datetime.now()`. Evidence: audit + `test_financial_logic.py` MC tests use
  fixed past dates and pass only because surprises are skipped.
- **B-02 (Python)** — negative income-variation over-subtracts via floor division:
  `101 * -8 // 100 = -9` (an 8.91% cut, not 8%). `risk.py:26`.
- **B-03 (Python)** — `expected_amount` silently discarded when the first payday precedes the
  window start. `timeline_service.py:63-85`.
- **B-04 (Python)** — even-count median floors. `risk.py:104`.
- **B-05 (Kotlin)** — probability of negative and first-negative-date ignore an already-negative
  opening balance. `MonteCarloEngine.kt:256-258,268-270,278-280`.
- **B-06 (Kotlin)** — two incompatible percentile formulas coexist (engine `ceil(N*p)-1` vs
  calibrator `(p*(N-1)).toInt()`), so bands and calibration inputs disagree on the same data.
- **B-07 (Kotlin)** — monthly recurrence loses its anchor when `day_of_month` is null:
  Jan 31 → Feb 28 → Mar 28 (not Mar 31). `RecurrenceMath.kt:33,81-84`.
- **B-08 (both)** — no `Long`/int overflow guard in Monte Carlo arithmetic; Kotlin `Long.MIN_VALUE`
  negation in `MoneyDisplay.kt:19,39,56` also overflows.
- **B-09 (Python, edge)** — cached-balance increment can promote to SQLite REAL, after which
  `_to_int_strict` raises (`db_manager.py:472-476`, `:34`).

---

## 5. Ambiguities that do not require a product decision yet

- `is_auto_withdraw` (Python) and `starting_balance` (Kotlin) are stored but unused.
- Python's `to_cents` banker's-rounding helper is dead code.
- Python `lowest_balance_date == None` conflates "no dip" with "unknown".
- Kotlin surfaces both `BudgetPacingEngine.runwayDays` (uncapped Double) and
  `clampedRunwayDays` (capped Int) under overlapping names.

---

## 6. What this implies for the contract

The contract must pin, at minimum:

1. A required, timezone-free `as_of` date; no implicit clock anywhere in the financial core.
2. A single horizon-boundary convention.
3. A single same-day ordering rule.
4. Integer probability units (ppm), and integer percent for variation.
5. A single percentile/median convention.
6. A specified PRNG and a fully specified draw order.
7. A single rounding rule for percentage scaling (HALF_UP).
8. A precise `safe_to_spend` definition distinct from the projected low point.
9. Unambiguous names for trough-percentiles vs ending-balance-percentiles.
10. Explicit handling of an already-negative opening balance.
11. A scope decision on pending/posted, multi-account, and expense/category variation.
12. An explicit starting-balance input.
13. Explicit past-due/catch-up semantics.
14. Defined behavior when the minimum equals the opening balance.
15. Single-currency (USD) v1.
16. An overflow policy.

These are carried into **MC-01 (Contract v1)** and recorded as **MCD-0001 … MCD-0020**.

---

## 7. Evidence and reproduction

Both audits were read-only. Commands that ground the key Python claims:

```bash
grep -rn "datetime.now\|utcnow\|date.today" monte_carlo_ledger/     # 12 sites incl. risk.py:33
grep -rn "as_of" monte_carlo_ledger/                                  # zero matches
sed -n '1,136p' monte_carlo_ledger/risk.py                            # RNG, impact, percentiles
sed -n '1,26p'   monte_carlo_ledger/forecasting.py                    # safe_to_spend
```

Kotlin citations are file:line into `app/src/main/java/com/montecarlo/ledger/` at `6e41892`.
