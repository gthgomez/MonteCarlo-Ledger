# Calculation Contract

This document states, in one place, what each number produced by Monte Carlo Ledger means. The
implementation is authoritative; this document describes it and must be kept in sync.

## Safe-to-spend (baseline-derived)

Sources: `monte_carlo_ledger/forecasting.py` (`calculate_safe_spend`), the
`GET /safe-to-spend` endpoint in `monte_carlo_ledger/api.py`, and the CLI forecast view.

- Input: current cached balance (reconciled against the ledger; a divergence returns `409 Conflict`
  on the API endpoint) and a deterministic timeline of scheduled income and bills.
- Behavior: walk the timeline, apply each event's amount in order, and track the running balance.
- Output: the **lowest projected balance point** over the horizon (before the next income event in
  the CLI's payday framing).

This is a **deterministic baseline calculation**. It assumes scheduled events happen exactly as
planned and includes no randomness. It is the answer to "what is the lowest point my plan reaches?"

## Monte Carlo risk layer (modeled uncertainty)

Sources: `monte_carlo_ledger/risk.py`, configured by
`monte_carlo_ledger/monte_carlo_config.py`.

- Input: the same baseline timeline, plus a seeded RNG and a config describing bounded income
  variation and bounded surprise expenses.
- Behavior: sample many scenario timelines by varying income amounts within configured bounds and
  injecting surprise expenses at random, then run the same balance walk on each scenario.
- Output: summary statistics over the simulated ending balances, including a low percentile named
  `low_percentile_ending_balance`, computed at the configured `low_percentile` value
  (`worst_percentile` in the config, default `0.10`). The key `worst_10_percent_ending_balance` is
  a deprecated alias kept for backwards compatibility and always equals
  `low_percentile_ending_balance`; it no longer implies a fixed 10% selection.

### Config validation contract (MC03)

All `MonteCarloConfig` fields are validated at construction time, before any sampling occurs;
invalid configurations raise `ValueError` and can never produce a partial run.

- `runs`: integer in `[1, 100_000]` (`MAX_RUNS`, the documented resource budget for a single
  invocation).
- `seed`: integer.
- `income_variation_min` / `income_variation_max`: integers with `min <= max` and `max >= 0`
  (percent points; a negative lower bound is allowed by design).
- `surprise_probability`: number in the closed interval `[0, 1]`; `0` means no surprise is ever
  injected and `1` means every check injects one (both boundaries behave exactly). NaN and
  non-numeric values are rejected.
- `surprise_check_interval_days`: integer `>= 1`.
- `surprise_amount_min` / `surprise_amount_max`: nonnegative integers (cents) with `min <= max`.
- `worst_percentile`: number in the **normalized scale `(0, 1]`** — the scale historically used by
  this configuration (`0.10` = 10th percentile). It is deliberately not a 0-100 percentage and is
  not reinterpreted, so previously saved configurations keep their exact meaning. NaN, zero,
  negative, and values above `1` are rejected.

This layer **models uncertainty**. Percentile outputs are simulated estimates from a bounded
variance model. **They are not guarantees and not worst cases.** Reality can be worse than any
sampled scenario: the model only varies what the config says to vary. In particular, no percentile
of the simulation should be read as "the worst that can happen."

The safe-to-spend number is not itself Monte Carlo output; the risk layer sits on top of the
baseline and asks how robust that baseline answer is.

## Branch and version conventions

- `master` is the intentional current default branch of this repository.
- Package version (`pyproject.toml`, currently `0.1.0`) and API contract version
  (`monte_carlo_ledger/api.py`, currently `1.0.0`) are independent domains. See the
  [Versioning section of the README](../../README.md#versioning).

## Maintenance rule

Any change that alters the meaning of these outputs (percentile scale, horizon semantics, event
ordering) must update this document in the same change.
