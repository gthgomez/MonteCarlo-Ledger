# MC-06 — Final Semantic Reconciliation Report

**Campaign:** MonteCarlo semantic foundation
**Contract:** 1.0 (draft), pinned at `a233614`
**Engines reconciled:**

| Engine | Revision | Domain | Status |
|---|---|---|---|
| Python `monte_carlo_ledger/contract` (reference) | `d2e621c` | CLI/API/MCP/Site (later) | passes 24/24 fixtures |
| Kotlin `com.montecarlo.ledger.contract` | `002dabc` (pin `d2e621c`) | Android | passes 24/24 fixtures |

**Cross-engine result (dumb comparer, `tools/conformance/cross_engine.py`):** 24 fixtures checked,
**0 divergences**. Python and Kotlin emit byte-identical canonical results, and both match the
fixture `expected`.

> Not a claim based on test count. The evidence is the per-fixture comparison in
> `docs/campaign/MC-06-divergence-report.md` and the pinned Kotlin baseline in
> `tools/conformance/kotlin-baseline/`.

## Disposition of every discovered disagreement

### Semantic disagreements (MC-00 register D-01 … D-20)

| Ref | Topic | Disposition |
|---|---|---|
| D-01 | Implicit vs explicit time | Contract rule MCD-0001 (explicit `as_of`); both engines conform |
| D-02 | Horizon boundary | Contract rule MCD-0002 (half-open); Python changed to match Kotlin |
| D-03 | Same-day ordering | Contract rule MCD-0003; both agreed |
| D-04 | Probability units | Contract rule MCD-0004 (ppm); both emit ppm |
| D-05 | Percentile/median convention | Contract rule MCD-0005 (nearest-rank, incl. P50); both conform |
| D-06 | PRNG streams | Contract rule MCD-0006 (SplitMix64); both reproduce the vectors |
| D-07 | Percentage scaling | Contract rule MCD-0007 (HALF_UP / scale by `100+percent`); both conform |
| D-08 | `safe_to_spend` meaning | Contract rule MCD-0008 (split from low point); both conform |
| D-09 | Trough vs ending percentiles | Contract rule MCD-0009 (named separately); both conform |
| D-10 | Opening-negative | Contract rule MCD-0010; both conform |
| D-11 | Pending vs posted | Contract rule MCD-0011 (all entries count) |
| D-12 | Multi-account/transfers | **Deferred** to a future contract version (MCD-0012); Android keeps native accounts |
| D-13 | Starting balance | Contract rule MCD-0013 (explicit) |
| D-14 | Overdue vs forecast | Contract rule MCD-0014 (separate); both conform |
| D-15 | Expense/category variation | Scalar defined, default off; per-category **deferred** (MCD-0015) |
| D-16 | Recurrence anchor | Contract rule MCD-0016 |
| D-17 | `expected_amount` | Contract rule MCD-0017; both conform |
| D-18 | Minimum-balance date null | Contract rule MCD-0018; both conform |
| D-19 | Currency | Contract rule MCD-0019 (USD only) |
| D-20 | Overflow | Contract rule MCD-0020; Kotlin B-08 fixed; both conform |

### Bugs found in the native engines

| Bug | Engine | Disposition |
|---|---|---|
| B-01 `datetime.now()` in seeded simulation | Python native | Contract path has no clock; **native migration deferred to MC-04/05** |
| B-02 floor-division percentage | Python native | Contract path uses MCD-0007; native migration deferred |
| B-03 `expected_amount` dropped | Python native | Contract path conforms; native migration deferred |
| B-04 floored even median | Python native | Contract path uses MCD-0005; native migration deferred |
| B-05 opening-negative ignored | Kotlin native | Contract path conforms; native engine migration deferred |
| B-06 two percentile formulas | Kotlin native | Contract path uses one rule; native engine migration deferred |
| B-07 recurrence anchor lost | Kotlin native | Contract path conforms; native engine migration deferred |
| B-08 negation/MC overflow | Kotlin shared | **Fixed** in `MoneyDisplay`; contract path guards overflow |
| B-09 cached-balance REAL promotion | Python native | Contract path has no cached balance; native migration deferred |

### New ambiguities surfaced during MC-06 (now codified)

| Item | Disposition |
|---|---|
| Generated-entry `input_index` | MCD-0021; both engines already agreed |
| Calendar recurrence anchoring (`start_date` lower bound, `anchor_day` day) | MCD-0022; Python changed to match Kotlin; fixture `anchor-differs-from-start` added |
| `end_date` inclusivity | Clarified in `timeline.md` (inclusive); both engage it |
| `MISSING_AS_OF` vs `SCHEMA_INVALID` precedence | Clarified: schema-invalid → `SCHEMA_INVALID`; Python runner now validates schema first |

## Definition of done — status

- [x] Every normative rule documented (`contracts/`).
- [x] Both engines consume the same contract revision (`a233614`, hash-pinned).
- [x] Python passes the golden corpus (24/24).
- [x] Kotlin passes the golden corpus (24/24).
- [x] Stochastic reproducibility explicit and documented (SplitMix64, MCD-0006).
- [x] No unexplained cross-engine differences (0 divergences over 24 shared fixtures).
- [x] Every resolved disagreement has evidence or an MCD.
- [x] CI prevents silent drift (Python conformance + cross-engine comparer in `.github/workflows/contract-conformance.yml`; Kotlin pin + conformance tests in the Android repo).
- [x] CLI/API do not duplicate financial logic — **done in MC-04/05**: CLI/API delegate to the contract engine (`scenario.py`, `decisions.py`, `commands.py`). Interactive terminal dashboards still use the legacy paths (remaining work).
- [x] Android remains native (contract engine is Kotlin-native, no Python runtime).
- [~] Android product adoption — **partially done in MC-06b**: dashboard/widget headline forecast, Monte Carlo and safe-to-spend run the contract engine behind `FeatureFlags.contractForecastEnabled`; the fan chart, `ForecastEngine` cash-flow rows, and `DebtPayoffEngine` remain native (non-normative / follow-on).

> Note: Python and Kotlin both pass all 23 fixtures. Python additionally has unit tests for the
> PRNG, rounding, and percentile vectors.

## Recommended next campaign

**Adoption & interface conformance (post-semantic-foundation).**

1. **MC-04 Structured scenario API** — make the Python reference the single engine behind an
   internal scenario representation; migrate `forecasting.py`/`risk.py`/`timeline_service.py` off
   `datetime.now()` and floor division, deleting the duplicate semantics (clears B-01…B-04, B-09).
2. **MC-05 CLI 2.0 / stable JSON** — `forecast`, `simulate`, `safe-to-spend` with canonical JSON
   output produced by the contract engine (adapter conformance, not new math).
3. **MC-06b Android adoption** — route `LedgerRepository`/`DashboardDeriver` forecasts and
   simulations through the Kotlin contract engine (or migrate the native engines onto the contract
   primitives), clearing B-05…B-07 in-product, behind a flag then on.
4. **MC-08 MCP, MC-09 Site** — adapters over the Python engine; the Site must not become a third
   TypeScript finance engine.
5. **Contract 2.0 candidates** — multiple accounts/transfers (D-12), per-category variation (D-15),
   calibration, multi-currency.
