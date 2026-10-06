# Semantic Decisions (MCD index)

MonteCarlo Decision records document material financial-semantic choices so a future contributor
cannot unknowingly reverse deliberate behavior. Each record states the question, the options, the
decision, the reason, the affected fixtures, and the contract version that introduced it.

| MCD | Title | Contract area |
|---|---|---|
| [MCD-0001](MCD-0001-explicit-as-of.md) | Explicit `as_of`; no clock in the core | timeline |
| [MCD-0002](MCD-0002-half-open-horizon.md) | Half-open horizon | timeline |
| [MCD-0003](MCD-0003-same-day-ordering.md) | Same-day ordering | timeline |
| [MCD-0004](MCD-0004-probability-ppm.md) | Probability in ppm | risk |
| [MCD-0005](MCD-0005-percentile-nearest-rank.md) | Nearest-rank percentile | risk |
| [MCD-0006](MCD-0006-standardized-prng.md) | SplitMix64 PRNG | simulation |
| [MCD-0007](MCD-0007-rounding-half-up.md) | Round half away from zero | money |
| [MCD-0008](MCD-0008-safe-to-spend.md) | `safe_to_spend` split from low point | risk |
| [MCD-0009](MCD-0009-trough-vs-ending-percentiles.md) | Trough vs ending percentiles | risk |
| [MCD-0010](MCD-0010-opening-negative.md) | Opening-negative balance | forecast |
| [MCD-0011](MCD-0011-pending-posted.md) | Pending/posted does not change balances | ledger |
| [MCD-0012](MCD-0012-single-account-v1.md) | One logical account in 1.0 | ledger (scope) |
| [MCD-0013](MCD-0013-explicit-starting-balance.md) | Explicit starting balance | ledger |
| [MCD-0014](MCD-0014-overdue-separate.md) | Overdue separate from forecast | timeline |
| [MCD-0015](MCD-0015-expense-variation-scope.md) | Expense variation scope | simulation (scope) |
| [MCD-0016](MCD-0016-recurrence-anchor.md) | Recurrence anchor preserved | timeline |
| [MCD-0017](MCD-0017-expected-amount.md) | `expected_amount` first in-window | timeline |
| [MCD-0018](MCD-0018-min-date-never-null.md) | Minimum balance date never null | forecast |
| [MCD-0019](MCD-0019-single-currency.md) | Single currency USD | money (scope) |
| [MCD-0020](MCD-0020-overflow-policy.md) | Overflow is an error | money |
| [MCD-0021](MCD-0021-generated-entry-ordering.md) | Ordering index for generated entries | timeline |
| [MCD-0022](MCD-0022-calendar-recurrence-anchor.md) | Calendar recurrence anchoring | timeline |
| [MCD-0023](MCD-0023-simulation-empty-schedule.md) | Simulation defined for empty schedules | simulation |

## How to add an MCD

1. Copy the template at the bottom of this file to `MCD-####-short-title.md`.
2. Fill every field. Use `Status: accepted` only after the contract is updated.
3. Add the row to the table above.
4. Reference the MCD from the relevant `contracts/*.md` document and the `CONTRACT_CHANGELOG.md`.

## Template

```text
# MCD-#### — Title

- Status: proposed | accepted | superseded by MCD-####
- Contract: 1.0 (component)
- Audit ref: D-##
- Question:
- Options:
- Decision:
- Reason:
- Affected fixtures:
- Introduced in:
```
