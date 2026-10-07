# MonteCarlo Contract Changelog

All material changes to financial semantics are recorded here. A change that alters a financial
conclusion for an existing valid scenario requires a MAJOR version bump; a backward-compatible
clarification requires a MINOR bump. Every entry links to an MCD where applicable.

## 2.0 — 2026-10-07 (draft)

MAJOR: adds a new liability/amortization conclusion domain and supersedes the deferred-liabilities
clause of MCD-0012. No existing scenario's forecast, risk, or result changes.

### Added

- `contracts/debt.md` (component `debt` 1.0): scenario `liabilities`,
  `debt_strategy` (`snowball` | `avalanche`), `extra_monthly_payment_cents`; result `debt` block
  (schedule + summary). Deterministic amortization procedure with interest before payment, a 360-month
  cap, and an overflow guard (MCD-0026).
- Schemas: `liabilities`/`debt_strategy`/`extra_monthly_payment_cents` in `scenario.schema.json`;
  `debt` in `result.schema.json`.
- Fixtures `debt/installment-basic`, `debt/revolving-minimum`, `debt/snowball-order`,
  `debt/avalanche-order`, `debt/extra-payment`, `debt/non-convergence`,
  `invalid/duplicate-liability-id`.

### Note

- Liabilities are **not** injected into `forecast`; a caller that wants debt payments in the cash
  projection adds them as ordinary `events`. Liabilities do not participate in `simulation`.

## 1.2 — 2026-10-07 (draft)

Backward-compatible MINOR addition. No existing scenario's draw stream or result changes.

### Added

- `expense_category_variation` simulation parameter and an optional `category` on scenario `events`
  and `recurrences` (MCD-0025). A non-income event whose `category` matches an entry draws from that
  entry's `[min, max]` (the scalar range is ignored for it); otherwise it falls back to the scalar
  `expense_variation_min/max`. Duplicate category entries are `SCHEMA_INVALID`.
- Fixtures `stochastic/expense-variation` (scalar enablement; the fixture MCD-0015 referenced but
  which had never landed), `stochastic/category-expense-variation`,
  `invalid/duplicate-category-variation`.
- Simulation component version 1.1.

## 1.1 — 2026-10-07 (draft)

Backward-compatible MINOR addition. No existing 1.0 scenario or result changes.

### Added

- `occurrence_exclusions` scenario field and schema definition
  (`schemas/scenario.schema.json`): `[{ "recurrence_id", "date" }]` removes a single generated
  occurrence from the projection (MCD-0024). Motivated by MC-07/C5 — a paid or user-moved
  occurrence in the *middle* of a recurrence window could not be suppressed, so the template
  occurrence and the explicit moved event were both projected (a double count).
- Fixtures `boundary/mid-window-exclusion`, `deterministic/moved-occurrence-override`,
  `boundary/exclusion-first-income-expected-amount`.
- Timeline component version 1.1.

### Clarified

- The canonical result echoes the scenario's declared `contract_version` (`"1.0"` or `"1.1"`), so a
  1.0 scenario remains byte-identical; both engines accept every released version's scenarios.
- `occurrence_exclusions` is a 1.1 field: a `1.0` document that carries it is `SCHEMA_INVALID`
  (engine-enforced, since a JSON-Schema `if/then` is not portable across both validators).
  Fixture `invalid/exclusion-requires-1-1`.

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
- MC-06b added `MCD-0023`: simulation is defined for any scenario; surprise generation depends only
  on the horizon and surprise parameters, not on scheduled events (`fixtures/stochastic/no-events-surprises`).

### Deferred to a future version

- Calibration (deriving simulation parameters from history).
- Per-category expense variation.
- Multiple accounts, transfers, credit/liability routing.
- Multi-currency.
