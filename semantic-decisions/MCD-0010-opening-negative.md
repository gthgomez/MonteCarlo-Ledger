# MCD-0010 — An already-negative opening balance is "negative from `as_of`"

- **Status:** accepted
- **Contract:** 1.0 (forecast, risk)
- **Audit ref:** D-10, B-05
- **Question:** If `starting_balance_cents < 0`, when did the balance first become negative, and does
  it count toward the probability of negative?
- **Options:** A. report `first_negative_date = as_of` and count it; B. only count an event-driven
  crossing; C. undefined.
- **Decision:** A.
- **Reason:** Kotlin only counted negatives caused by an event, so an overdrawn start with no events
  reported a 0% chance of being negative — plainly wrong. Python's forecast would technically report
  the first negative row, but had no event and no row to report. Anchoring to `as_of` is the only
  defensible answer.
- **Affected fixtures:** `deterministic/negative-start`, `stochastic/negative-start`.
- **Introduced in:** contract 1.0.
