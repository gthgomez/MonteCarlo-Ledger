# Simulation (Monte Carlo) — Contract 1.0

The simulation stresses the deterministic forecast under bounded uncertainty. Given the same
scenario and the same parameters, **every conformant engine returns the same integer results** — not
merely statistically similar ones.

## Parameters

| Parameter | Default | Units | Notes |
|---|---|---|---|
| `runs` | `500` | count | `>= 1`; `runs = 0` is `INVALID_RUNS` |
| `seed` | `42` | uint64 | required for conformance fixtures |
| `income_variation_min` | `-8` | integer percent | inclusive |
| `income_variation_max` | `8` | integer percent | inclusive, `>= min` |
| `expense_variation_min` | `0` | integer percent | inclusive |
| `expense_variation_max` | `0` | integer percent | inclusive; `0..0` disables expense variation |
| `surprise_probability_ppm` | `150000` | parts-per-million | `0..1000000` |
| `surprise_check_interval_days` | `14` | days | `>= 1` |
| `surprise_amount_min` | `2000` | cents | inclusive |
| `surprise_amount_max` | `15000` | cents | inclusive, `>= min` |

Calibration — deriving parameters from transaction history — is **out of scope for 1.0** and must not
affect a canonical result. Canonical fixtures always supply explicit parameters. (Kotlin's
`MonteCarloCalibrator` and Python's config remain native features to be specified in a later
component version.)

## PRNG — SplitMix64

All engines implement this exact 64-bit unsigned algorithm. `state` is a `uint64`; all arithmetic is
modulo `2^64`; `>>` is a logical shift.

```text
next_u64():
    state = (state + 0x9E3779B97F4A7C15) mod 2^64
    z = state
    z = ((z xor (z >> 30)) * 0xBF58476D1CE4E5B9) mod 2^64
    z = ((z xor (z >> 27)) * 0x94D049BB133111EB) mod 2^64
    return z xor (z >> 31)

next_bounded(n):          # n >= 1
    return next_u64() mod n

next_int(min, max):       # inclusive
    return min + next_bounded(max - min + 1)

next_ppm_hit(p):          # p in 0..1_000_000
    return (next_u64() mod 1_000_000) < p
```

- The modulo reduction in `next_bounded` introduces a bias of at most `2^-64`-scale, which is
  negligible for contract bounds and, crucially, is **identical in every engine**. It is chosen over
  rejection sampling precisely so the stream is deterministic and simple.
- The PRNG instance is created **once** per simulation from `seed` and consumed sequentially across
  runs (audit D-06).

### Reference test vectors (binding)

These pin the PRNG across languages. `state` after construction is `seed`. Both columns are
**alternatives computed from the freshly seeded state** (each consumes a single `next_u64()`), not
sequential draws.

| seed | first `next_u64()` (decimal) | first `next_int(0, 100)` |
|---|---|---|
| `0` | `16294208416658607535` (`0xE220A8397B1DCDAF`) | `67` |
| `42` | `13679457532755275413` | `23` |

A conformant implementation must reproduce these. `tools/conformance` is extended in MC-03 to emit
these vectors from the Python reference; Kotlin reproduces them in MC-06.

## Simulating one run

Inputs: the canonical in-window base events (from `timeline.md`), the parameters, and `as_of`.

```text
1. scenario = copy(base_events)                       # canonical order
2. for event in canonical_order(scenario):
       if event.type == income and (income_variation_min != 0 or income_variation_max != 0):
           pct = next_int(income_variation_min, income_variation_max)
           event.amount = max(0, scale_cents_by_percent(event.amount, pct))
       else if event.type != income and (expense_variation_min != 0 or expense_variation_max != 0):
           pct = next_int(expense_variation_min, expense_variation_max)
           event.amount = min(0, scale_cents_by_percent(event.amount, pct))
3. checks = horizon_days // surprise_check_interval_days
   for i in 0 .. checks-1:
       if next_ppm_hit(surprise_probability_ppm):
           offset = i * surprise_check_interval_days + next_int(0, surprise_check_interval_days - 1)
           date   = as_of + offset
           if date < as_of + horizon_days:
               amount = -next_int(surprise_amount_min, surprise_amount_max)
               scenario.append(entry(date, amount, type = expense, sequence = 1))
4. sort scenario by (date, sequence, input_index)
5. run the deterministic forecast (forecast.md) over scenario
```

Notes:

- Draws happen **only** for the branches whose range is enabled. With the defaults
  (`income -8..8`, `expense 0..0`), each run draws once per income event and never for expenses.
  This keeps the default stream simple and identical across engines.
- Income variation is clamped at `0` (income cannot become negative). Expense variation is clamped at
  `0` (an expense cannot become income).
- The draw order is part of the contract: step 2 fully precedes step 3, events are visited in
  canonical order, and per-event branches are visited in that order.
- Everything uses the integer functions from `money.md`; no floating point is involved.

## Aggregation

Per run, record at least:

- `ending_balance_cents`
- `minimum_balance_cents`
- `first_negative_date` (from `forecast.md`, including the opening-negative rule)

Then, over all `runs`:

```text
negative_runs = count(runs where first_negative_date != null)
negative_balance_probability_ppm = round_half_away(negative_runs * 1_000_000, runs)

ending_balance_p{q}_cents    = percentile_nearest_rank(sorted(ending_balance), q)
minimum_balance_p{q}_cents   = percentile_nearest_rank(sorted(minimum_balance), q)
```

with `percentile_nearest_rank` defined once, in `risk.md`, and used for **every** percentile,
including the median. This is a single convention; the calibrator's former second formula is not
part of 1.0.

## Reproducibility requirement

Given identical `(scenario, parameters)`, the aggregate integers above are identical across Python
and Kotlin. Floating point may be used only in non-normative diagnostics that are not part of
`result.schema.json`.

## Daily grid (optional)

An implementation may expose per-day balances for charts. When it does, define index `i` as the
end-of-day balance for `as_of + i`, for `i = 0 … horizon_days - 1`; the value before the first event
of `as_of` is `starting_balance_cents`. The daily grid is not required for conformance and is not in
`result.schema.json` in 1.0.
