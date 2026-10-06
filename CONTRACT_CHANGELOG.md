# MonteCarlo Contract Changelog

All material changes to financial semantics are recorded here. A change that alters a financial
conclusion for an existing valid scenario requires a MAJOR version bump; a backward-compatible
clarification requires a MINOR bump. Every entry links to an MCD where applicable.

## 1.0 — 2026-10-06 (draft)

Initial semantic foundation. Derived from the MC-00 cross-engine inventory
(`docs/campaign/MC-00-semantic-inventory.md`).

### Added

- Canonical contract documents: money, timeline, ledger, forecast, simulation, risk.
- Canonical JSON schemas: `scenario.schema.json`, `result.schema.json`.
- Golden scenario corpus under `/fixtures`.
- MCD-0001 … MCD-0020.
- Dumb comparer under `/tools/conformance`.

### Pinned semantics (each resolves an audit finding)

| Ref | Decision | MCD |
|---|---|---|
| D-01 | Explicit required `as_of`; no clock in the core | MCD-0001 |
| D-02 | Half-open horizon `[as_of, as_of + horizon_days)` | MCD-0002 |
| D-03 | Same-day order: income before expense, overridable by `sequence` | MCD-0003 |
| D-04 | Probability in integer parts-per-million | MCD-0004 |
| D-05 | Single nearest-rank percentile convention (incl. median) | MCD-0005 |
| D-06 | SplitMix64 PRNG and specified draw order | MCD-0006 |
| D-07 | Percentage scaling rounds half away from zero | MCD-0007 |
| D-08 | `safe_to_spend` is quantile-based; low point is separate | MCD-0008 |
| D-09 | Trough and ending percentile families named separately | MCD-0009 |
| D-10 | Already-negative opening balance is negative from `as_of` | MCD-0010 |
| D-11 | Pending/posted does not change balances | MCD-0011 |
| D-12 | One logical account in 1.0; multi-account deferred | MCD-0012 |
| D-13 | Explicit `starting_balance_cents` | MCD-0013 |
| D-14 | Overdue is separate from the forecast window | MCD-0014 |
| D-15 | Scalar expense variation defined, default disabled; category variation deferred | MCD-0015 |
| D-16 | Recurrence preserves its month anchor | MCD-0016 |
| D-17 | `expected_amount_cents` applies to first in-window occurrence | MCD-0017 |
| D-18 | `minimum_balance_date` is never null | MCD-0018 |
| D-19 | Single currency (USD) | MCD-0019 |
| D-20 | Overflow is an error, never a wrap | MCD-0020 |

### Corrected while drafting (pre-release)

- `scale_cents_by_percent` was initially written as a *delta* function. The MC-03 reference exposed
  the contradiction with the simulation pseudocode and with Kotlin's `scaleCentsByPercent`
  (`scale(100,1)=101`). It is now defined as scaling by `(100 + percent)%`, and the basis-point
  functions remain fractions. See MCD-0007. No version bump: 1.0 was never released.
- During MC-06 integration the recurrence text was clarified: `start_date` is a lower bound and
  `anchor_day` sets the day of month (MCD-0022); generated-entry ordering indices are specified
  (MCD-0021); `end_date` is inclusive; schema-invalid scenarios report `SCHEMA_INVALID` before
  engine semantics. No version bump: these clarify previously ambiguous text and are not observable
  by prior valid fixtures except the new `boundary/anchor-differs-from-start`.

### Deferred to a future version

- Calibration (deriving simulation parameters from history).
- Per-category expense variation.
- Multiple accounts, transfers, credit/liability routing.
- Multi-currency.
