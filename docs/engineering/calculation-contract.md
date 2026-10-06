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
- Output: summary statistics over the simulated ending balances, including a low percentile
  (currently labeled `worst_10_percent_ending_balance`, computed at the configured
  `worst_percentile`, default `0.10`).

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
