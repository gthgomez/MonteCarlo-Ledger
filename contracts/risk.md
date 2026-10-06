# Risk — Contract 1.0

## The single percentile convention

`percentile_nearest_rank` is the **only** percentile function in the contract. For a sorted ascending
list `x` of length `N >= 1`, and a quantile `q = num/den` with `0 < num <= den`:

```text
index = ceil(N * num / den) - 1          # exact integer ceil
index = clamp(index, 0, N - 1)
value = x[index]
```

Exact integer form: `index = ((N * num) + den - 1) // den - 1`.

- The returned value is always an element of `x` (nearest-rank), never an interpolation.
- The **median is `P50`** via this same rule: for `q = 1/2`, `index = ceil(N/2) - 1`. For even `N`
  this is the lower middle element. There is no averaging, no floor-vs-midpoint discrepancy.
- This resolves audit D-05 and bug B-06: Python used a floored average median, Kotlin used an
  averaged midpoint median, and Kotlin's calibrator used a third formula. All are replaced.

Binding examples:

| N | q | index | note |
|---|---|---|---|
| 500 | 1/10 | 49 | 50th smallest |
| 500 | 1/2 | 249 | lower median |
| 500 | 9/10 | 449 | |
| 5 | 1/10 | 0 | nearest-rank collapses to the minimum |
| 1 | any | 0 | |

## Reported quantities

`result.schema.json` exposes two clearly separated families. There is no field merely called `p10`.

| Field | Meaning |
|---|---|
| `minimum_balance_p10_cents` / `p50` / `p90` | percentile of each run's **minimum (trough)** balance |
| `ending_balance_p10_cents` / `p50` / `p90` | percentile of each run's **ending** balance |
| `negative_balance_probability_ppm` | `round_half_away(negative_runs * 1_000_000, runs)` |
| `projected_low_point_cents` | the deterministic `minimum_balance_cents` (not a percentile) |
| `safe_to_spend_cents` | see below |

Audit D-09/B-06: Android's "P10/P50/P90" cards were trough percentiles labeled "worst/typical/best
case", while Python mixed a trough "worst 10%" with an *ending* median. The contract names both
families explicitly and requires the display label to match the field.

### Probability units

- Units are **integer parts-per-million** (`0 … 1_000_000`). Audit D-04: both engines used an
  untyped percent float.
- `negative_runs` counts runs whose `first_negative_date != null`, i.e. it **includes** an
  already-negative opening balance. Audit D-10/B-05.

## safe_to_spend

Contract 1.0 replaces the ambiguous term with two precise quantities.

```text
projected_low_point_cents = deterministic minimum_balance_cents          # forecast.md

safe_to_spend_cents(as_of, horizon_days, quantile_num/quantile_den, reserve_cents) =
    minimum_balance_p{quantile}_cents  -  reserve_cents
```

- `quantile` is the **lower-tail quantile of the trough distribution** (default `1/10`). Using
  `1/10` means: in 10% of simulated runs the trough was at or below this value.
- `reserve_cents` is a non-negative buffer the user chooses to keep untouched (default `0`).
- The result is **signed** and may be negative, meaning "there is no safe amount; you are projected
  to fall short even before discretionary spending." Display surfaces may clamp for presentation,
  but the contract value is signed. (Audit D-08.)
- The label **"safe to spend" must only be attached to `safe_to_spend_cents`**, never to
  `projected_low_point_cents`. The projected low point is labeled "projected low point" / "lowest
  projected balance".

The two contested numbers from the audit:

- Python `calculate_safe_spend` returned the projected low point but was documented and displayed as
  a spendable amount. It becomes `projected_low_point_cents`.
- Kotlin `ForecastSummary.safeToSpendCents` likewise was the trough; its UI already hedged
  ("Lowest balance over next 90 days"). It becomes `projected_low_point_cents`, and
  `safe_to_spend_cents` is the new, quantile-based value.

## Reserve and confidence defaults

- Default `quantile = 1/10`, default `reserve_cents = 0`, default `horizon_days = 90`.
- These defaults are product defaults, not semantics. A fixture must always state the values it
  relies on.

## What the contract does not claim

- `negative_balance_probability_ppm` is a property of the specified uncertainty model, not a
  calibrated real-world probability. Calibration is a later component version.
- No risk value is financial advice; the engine reports model output.
