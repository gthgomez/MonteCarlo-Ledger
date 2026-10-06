# MC-06b — Android Contract Adoption

**Milestone:** MC-06b (route the Android product through the Kotlin contract engine)
**Status:** Complete for dashboard/widget headline numbers; fan chart, cash-flow rows and
`DebtPayoffEngine` remain native
**Repos:** Android `campaign/contract-adoption` @ `002dabc`; contract pinned at `d2e621c`

## What was done

- `adoption/ContractScenarioBridge` — repository rows → canonical `ContractScenario`
  (`as_of` explicit, recurrence `start_date` as lower bound with `anchor_day`, overdue excluded,
  paid/user-moved occurrences suppressed, calibration → contract simulation params).
- `adoption/ContractDashboardMapper` — canonical `ContractResult` → existing Compose state, so the
  UI keeps working while the numbers come from the contract.
- `DashboardDeriver` and the Glance widget source headline forecast / Monte Carlo / safe-to-spend
  from `ContractRunner` behind `FeatureFlags.contractForecastEnabled` (default `true`).
- Native bug fixes at the call sites: **B-05** (opening-negative counted), **B-06** (single
  nearest-rank percentile incl. P50), **B-07** (monthly anchor preserved).
- Label correction: "Most likely first negative-balance date" → "Projected ..." (the value is the
  deterministic contract date, not a modal simulated one).

## Semantic reconciliation during integration

The agent introduced a product decision — *drop simulation when there are no scheduled events*
("first-run 0% risk"). This changes a displayed financial number without contract support, which
violates the campaign's governance rule. It was resolved the correct way:

1. **Codified in the public contract**: MCD-0023 and `contracts/simulation.md` now state explicitly
   that simulation is defined for any scenario and that surprise generation depends only on
   `horizon_days` and the surprise parameters.
2. **New fixture** `stochastic/no-events-surprises` frozen by Python and independently reproduced
   by the Kotlin contract engine (24/24).
3. **Removed the guard** in `DashboardDeriver` and `MonteCarloLedgerGlanceWidget`; the empty-ledger
   test now asserts the contract truth (probability > 0) instead of a fabricated 0%.

An explicit "not enough information yet" UX state for an empty ledger is a candidate future
presentation task, not an engine semantic.

## Evidence

```
Android  :app:testDebugUnitTest   336 passed, 0 failures
Kotlin conformance                24/24 fixtures
Cross-engine comparer             24/24, 0 divergences
Pin                               35 files, sha256 match Ledger d2e621c
```

## Remaining risks

- `ForecastEngine` still omits an opening-negative first-negative date on the flag-off path, the
  cash-flow/daily-budget rows, and `DebtPayoffEngine`; those paths were not migrated.
- `dailyBudgetCents` / cash-flow help text still uses the native meaning of safe-to-spend, which
  differs from the contract's signed quantile value.
- The fan chart is intentionally non-normative and may not visually align with the contract
  headline (different PRNG / surprise model).
- Doubled simulation compute while the flag is on (native fan + contract headlines).
- `FeatureFlags.contractForecastEnabled` is a process-wide `var`, not persisted in settings.
- Output numbers changed where the contract corrects semantics (more conservative safe-to-spend,
  nearest-rank medians, overdue excluded, anchor day fixed); verified by unit tests, not on device.

## Next parallel work

- Migrate `ForecastEngine` cash-flow rows and `DebtPayoffEngine` onto the contract primitives.
- Persist the adoption flag in Settings.
- Contract 2.0 candidates: per-category variation (D-15), per-day path percentiles, multi-account
  (D-12).
