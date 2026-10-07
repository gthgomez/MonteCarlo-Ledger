# MC-11 — Contract 2.0: the debt / liability domain

**Goal:** resolve the highest-impact remaining MC-07 candidate — `DebtPayoffEngine` produced
user-visible debt conclusions (months to payoff, total interest, snowball/avalanche savings) with no
canonical authority.

**Delivered:** a canonical **liability + amortization** domain (scenario `liabilities`, result `debt`
block), implemented identically in the Python reference and the Kotlin engine, with fixtures and
cross-engine conformance.

## Version decision: 2.0 (MAJOR)

Debt adds a **new conclusion class** and supersedes the deferred-liabilities clause of **MCD-0012**
(a scope decision). Even though the schema changes are additive, that combination is a MAJOR bump:
**contract 2.0**, new component `debt` 1.0. No existing scenario's forecast, risk, or result changes.

## Semantics (see `contracts/debt.md` for the normative text)

- Scenario: `liabilities` (id, balance_cents, apr_basis_points, min_payment_cents, kind ∈
  {installment, revolving}, min_payment_percent_bps, min_payment_floor_cents, due_day_of_month),
  `debt_strategy` ∈ {snowball, avalanche}, `extra_monthly_payment_cents`.
- Result: `debt` block with the schedule + summary. Deterministic; liabilities do **not** participate
  in `simulation`, and are **not** auto-injected into `forecast` (a caller that wants that adds the
  payment amounts as ordinary `events`).
- Interest `round_half_away(balance × apr_bps, 120000)` charged before the payment; payment capped at
  the post-interest balance; stable strategy order (ties keep the array order); extra pool folded into
  the month's rows; 360-month cap; overflow guard.

## Fixtures — 31 → 38

| Fixture | Protects |
|---|---|
| `debt/installment-basic` | 0% installment payoff + month-end clamping (Jan 31 → Feb 28) |
| `debt/revolving-minimum` | revolving `max(floor, pct)` minimum; `min_payment_cents` ignored |
| `debt/snowball-order` | lowest balance first; extra pool targets it |
| `debt/avalanche-order` | highest APR first (same liabilities as snowball) |
| `debt/extra-payment` | extra pool reduces months and interest |
| `debt/non-convergence` | interest guard overflow → `did_not_converge`, no rows |
| `invalid/duplicate-liability-id` | duplicate id → `SCHEMA_INVALID` |

## Evidence

Ledger (Python 3.10.1, pytest 8.4.2):

```text
python -m pytest          -> 169 passed in 126.63s
python -m ruff check .    -> All checks passed!
python -m pyright         -> 0 errors
cross_engine.py           -> 38 fixtures checked, 0 divergences
```

Android side and the product integration are recorded in
`MonteCarloLedger-Android/docs/contract-adoption.md` and the MC-11 Android PR.
