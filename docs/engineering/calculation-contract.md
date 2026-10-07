# Calculation Contract

This document states, in one place, what each number produced by Monte Carlo Ledger means.

Since MC-07 every user-visible financial conclusion is produced by the canonical contract engine
(`monte_carlo_ledger/contract/`), reached through the structured scenario API
(`monte_carlo_ledger/scenario.py`) and the decision layer (`monte_carlo_ledger/decisions.py`). The
normative semantics live in `/contracts`; this document describes the surfaces. The former
`forecasting.py`, `risk.py`, `monte_carlo_config.py` and `timeline_service.py` duplicate engines were
deleted.

## Deterministic forecast (baseline)

Sources: `monte_carlo_ledger/contract/engine.py` (`expand`, `forecast`), reached from
`decisions.forecast`, the CLI `forecast` command, `GET /v1/forecast`, and the interactive terminal.

- Input: an explicit `as_of` date (no clock — MCD-0001), a starting balance, and the in-window
  events of the scenario.
- Window: half-open `[as_of, as_of + horizon_days)` (MCD-0002); events before `as_of` are not
  projected (MCD-0014).
- Ordering: by date, then income before expense, then input order (MCD-0003, MCD-0021).
- Output: `minimum_balance_cents` / `minimum_balance_date` (the projected low point, never null —
  MCD-0018), `ending_balance_cents`, and `first_negative_date` (which is `as_of` when the opening
  balance is already negative — MCD-0010).

## Safe-to-spend (quantile)

Source: the `risk` block of the contract result (MCD-0008).

- `safe_to_spend_cents` is the **quantile** of the simulated trough (`minimum_balance_p{q}`) minus
  any reserve — *not* the deterministic low point. The two are distinct fields:
  `projected_low_point_cents` (deterministic) and `safe_to_spend_cents` (simulated quantile).
- Default quantile is 1/10.

## Monte Carlo risk layer (modeled uncertainty)

Source: `monte_carlo_ledger/contract/engine.py` + `prng.py`, reached from `decisions.risk` and the
CLI/API `risk` / `safe-to-spend` / `overdraft` commands.

- PRNG: SplitMix64 with a fully specified draw order (MCD-0006); results are a pure function of the
  scenario and seed.
- Percentiles: a single nearest-rank convention for every percentile including the median
  (MCD-0005); P10 ≤ P50 ≤ P90.
- Probability of a negative balance is an integer in **parts per million**
  (`negative_balance_probability_ppm`, MCD-0004).
- Trough percentiles (`minimum_balance_p10/p50/p90_cents`) and ending-balance percentiles
  (`ending_balance_p10/p50/p90_cents`) are named separately (MCD-0009).
- Simulation is defined for **any** scenario; surprise generation depends only on the horizon and
  the surprise parameters, never on whether scheduled events exist (MCD-0023).
- These are simulated estimates from a bounded variance model, **not guarantees and not worst
  cases**.

## Non-normative product heuristics

Contract 1.x defines no daily-pacing concept. The terminal's "daily pacing" guidance
(`dashboard_view.daily_pacing_cents`) and the Android daily-budget value are product heuristics:
they are derived from the canonical projected low point so they cannot contradict it, and they are
labelled as guidance, never as canonical financial truth.

## Branch and version conventions

- `master` is the intentional current default branch of this repository.
- Package version (`pyproject.toml`, currently `0.1.0`) and API contract version
  (`monte_carlo_ledger/api.py`, currently `2.0.0`) are independent domains. See the
  [Versioning section of the README](../../README.md#versioning).

## Maintenance rule

Any change that alters the meaning of these outputs (percentile convention, horizon semantics,
event ordering, probability units) must update the contract under `/contracts` and this document in
the same change.
