# MC-07 — Contract 2.0 Candidate Registry

Input to the next contract-design campaign. These are problems discovered during product-wide
adoption that Contract 1.x cannot represent cleanly. Nothing here is implemented in MC-07; Contract
1.0 stays a single, stable semantic surface.

Ranking is by user impact on the "one answer per financial question" goal.

---

## 1. Arbitrary occurrence exclusions / overrides — **HIGH**

- **Problem.** Contract 1.x has no per-occurrence exclusion. A user who marks a mid-window bill
  paid or moves it cannot suppress just that generated occurrence.
- **Current product behavior.** Android suppression only works for a suppressed *prefix* of a
  recurrence's in-window occurrences (by advancing the recurrence lower bound). A mid-window
  suppression still projects the original template date, in addition to the explicit moved event —
  a double-count.
- **Why 1.0 cannot represent it.** No scenario field expresses "generate this recurrence except on
  date D".
- **Minimum required extension.** `exclude_occurrences: [{recurrence_id, date}]`, or first-class
  user-modified occurrences that suppress their generated counterpart. (An optional field is a
  MINOR addition by the versioning rules, but it changes representable semantics, so it needs an
  MCD + fixture.)
- **User impact.** Overstated bill burden and a wrong projected low point whenever a bill is moved
  or paid mid-window.

## 2. Debt / amortization semantics — **HIGH**

- **Problem.** The product shows debt payoff schedules, minimum payments, and snowball/avalanche
  strategies (`DebtPayoffEngine`) that Contract 1.x does not model.
- **Current product behavior.** Native, non-normative, outside the contract.
- **Why 1.0 cannot represent it.** MCD-0012 defers multi-account and credit/liability routing;
  there is no interest, principal, or liability-balance model.
- **User impact.** Debt guidance is a real financial conclusion with no canonical authority.
- **Note.** Only integrated into the contract if it can be modeled as deterministic ledger events;
  otherwise it needs a new contract domain.

## 3. Per-category expense variation — **MEDIUM-HIGH**

- **Problem.** Users vary spending by category; Contract 1.x models one aggregate expense-variation
  scalar (MCD-0015).
- **Current product behavior.** Android calibration computes per-category ranges but the adopted
  simulation uses the aggregate range only.
- **User impact.** The simulated risk is less personalized than the product intends.

## 4. Per-day stochastic path percentiles — **MEDIUM**

- **Problem.** The dashboard fan chart wants daily P10/P50/P90 paths; Contract 1.x exposes only
  aggregate trough/ending percentiles.
- **Current product behavior.** Native `MonteCarloEngine.dailyPercentiles`, explicitly
  non-normative; cannot contradict the contract headlines but is not canonical either.
- **User impact.** Visual only (headline risk figures are canonical); no competing *number*.

## 5. Multi-account and transfers — **MEDIUM**

- **Problem.** Contract 1.x is single-account (MCD-0012). Android has `AccountEntity` rows but one
  default account drives the pipeline; there are no transfers.
- **User impact.** Only the default account's finances are canonical.

## 6. Calibration semantics — **MEDIUM**

- **Problem.** Deriving simulation parameters from history is deferred; calibration happens in the
  product (`MonteCarloCalibrator`) and is fed into the contract as inputs.
- **Why it matters.** Calibration influences the canonical result but is not itself contract-defined,
  so two implementations could feed different parameters and get different answers.

## 7. Daily pacing / spending-velocity — **LOW**

- **Problem.** No contract concept of a daily spend guidance; both Python and Android retain a
  product heuristic derived from the canonical low point.
- **User impact.** Low; it is labelled as guidance and derived from a canonical value.

## 8. Multi-currency — **LOW**

- Single currency (USD) by MCD-0019. No near-term pressure.
