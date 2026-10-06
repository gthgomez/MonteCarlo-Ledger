# Forecast — Contract 1.0

The deterministic forecast is the baseline: "what happens if the schedule is exactly right?" It is a
pure function of `starting_balance_cents`, the ordered in-window events, and `as_of`.

## Procedure

```text
balance = starting_balance_cents
rows   = []
for event in canonical_order(in_window_events):
    balance = checked_add(balance, event.amount_cents)     # MONEY_OVERFLOW on range error
    rows.append({date: event.date, balance_after_cents: balance})
```

The starting balance is the balance immediately before the first event. Order affects the running
path by design (see `timeline.md`).

## Metrics

Let `B = { starting_balance_cents } ∪ { row.balance_after_cents }`.

| Metric | Definition |
|---|---|
| `minimum_balance_cents` | `min(B)` |
| `minimum_balance_date` | date of the **first** row achieving `min(B)`; if `min(B) == starting_balance_cents` and no row is strictly below the starting balance, the date is `as_of` |
| `ending_balance_cents` | last `row.balance_after_cents`, or `starting_balance_cents` if there are no rows |
| `first_negative_date` | `as_of` if `starting_balance_cents < 0`; otherwise the date of the first row with `balance_after_cents < 0`; `null` if no such row |

### Rationale for the two contested rules

- **`minimum_balance_date` is never `null`.** Audit D-18: both engines left it `null`/`None` when the
  starting balance was the lowest point, which conflates "no dip" with "unknown date". The contract
  makes it `as_of`.
- **`first_negative_date` accounts for an already-negative opening balance.** Audit D-10/B-05: Kotlin
  only set it when an event drove the balance below zero, so an overdrawn starting balance reported
  "never negative". The contract sets it to `as_of` in that case.

## Empty window

With `horizon_days = 0`, or with no in-window events:

- `minimum_balance_cents = ending_balance_cents = starting_balance_cents`
- `minimum_balance_date = as_of`
- `first_negative_date = as_of` if `starting_balance_cents < 0`, else `null`

## Boundaries

- `horizon_days` and the half-open window are defined in `timeline.md`.
- An event at exactly `as_of + horizon_days` does not affect the forecast.
- Negative results are valid and are not clamped.
