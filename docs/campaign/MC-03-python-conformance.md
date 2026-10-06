# MC-03 — Python Reference Conformance

**Milestone:** MC-03 (bring the Python engine into conformance with Contract 1.0)
**Status:** Complete for the reference engine; legacy DB-coupled paths deferred to MC-04/MC-05
**Date:** 2026-10-06
**Branch:** `campaign/semantic-contract`

## What was built

- `monte_carlo_ledger/contract/` — a pure, clock-free reference implementation of Contract 1.0:
  - `money.py` — integer cents, `round_half_away`, `scale_cents_by_percent` (scales by
    `100+percent`), `scale_cents_by_basis_points`, overflow-checked add.
  - `prng.py` — SplitMix64 with the contract's bounded/int/ppm draws.
  - `engine.py` — recurrence expansion, half-open window, canonical ordering, deterministic
    forecast, Monte Carlo simulation, nearest-rank aggregation, risk block.
- `tools/conformance/run_python.py` — runs the golden corpus through the reference and emits one
  canonical result JSON per fixture; `--freeze`/`--refreeze` freeze stochastic expectations.
- `tests/test_contract_conformance.py` — parametrized over every fixture, plus PRNG, rounding, and
  percentile vector tests.
- Frozen stochastic expectations for the four `fixtures/stochastic/*` scenarios.

## Evidence

```text
pytest                        75 passed (18 fixture cases + vector tests + existing suite)
ruff check                     All checks passed
runner (--out) x2, diff -rq   outputs byte-identical  -> deterministic
run_python.py --freeze        4 stochastic fixtures frozen
compare.py                     deterministic + stochastic fixtures PASS
SplitMix64 vectors            seed 0 / 42 match contract (incl. 0xE220A8397B1DCDAF)
```

## Disagreements discovered

- **Contract self-contradiction (caught here):** MC-01 mis-defined `scale_cents_by_percent` as a
  delta; the simulation pseudocode and Kotlin both scale by `(100+percent)%`. Money.md and MCD-0007
  corrected. This is the process working as intended — the contract, not an engine, was at fault.
- **Explicit past/future events were initially NOT windowed** in the reference; the
  `past-due-excluded`, `horizon-zero`, and `horizon-end-exclusive` fixtures failed until explicit
  events were filtered to `[as_of, as_of+horizon_days)` (MCD-0002/MCD-0014). Fixed.

## Semantic decisions made

None new. The reference encodes MCD-0001…MCD-0020. The `scale_cents_by_percent` correction is a
pre-release fix to MCD-0007, not a new decision.

## Remaining risks

- The **legacy DB-coupled engine** (`forecasting.py`, `risk.py`, `timeline_service.py`, `api.py`) is
  still non-conformant: it reads `datetime.now()`, uses floor division, and labels the low point as
  safe-to-spend. The new reference is conformant; migrating the live surfaces is MC-04 (structured
  scenario API) and MC-05 (CLI 2.0). This is deliberate scope control, not an oversight.
- Stochastic expectations are frozen from the Python reference and are **not yet independently
  reproduced by Kotlin** (MC-06, in progress). Any Kotlin divergence must be investigated; a shared
  bug is possible.
- `leap-year-recurrence` proves Feb-29 → Feb-28 but does not reach the next leap year (horizon too
  short to observe the return to Feb 29); add a longer-horizon boundary fixture later.
- `semimonthly` recurrence is implemented but not covered by a fixture yet.

## Next parallel work

- MC-06 Kotlin conformance (in progress) — must reproduce the frozen stochastic expectations and the
  SplitMix64 vectors.
- MC-04/05 — migrate CLI/API onto the reference engine (one scenario representation, stable JSON).
