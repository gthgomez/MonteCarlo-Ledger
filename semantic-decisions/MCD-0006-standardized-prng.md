# MCD-0006 — Standardized PRNG (SplitMix64) and a specified draw order

- **Status:** accepted
- **Contract:** 1.0 (simulation)
- **Audit ref:** D-06
- **Question:** How can Python and Kotlin produce identical Monte Carlo aggregates, given their
  native RNGs differ? Options: A. standardized PRNG implemented in both; B. fixtures carry the
  stochastic samples themselves.
- **Decision:** A. Specify SplitMix64 plus exact bounded/percent draws and a fixed draw order.
  One PRNG instance is seeded once and consumed sequentially across runs.
- **Reason:** The campaign requires "same seed → same answer." Option A keeps the engine self-contained
  and testable and makes seeded results byte-identical. Option B would move randomness into test
  data and leave runtime simulations non-comparable. SplitMix64 is a few lines in each language and
  uses only 64-bit integer arithmetic, so complexity stays modest (no float distributions, no
  rejection loops). Native RNGs are retired from the conformance path.
- **Affected fixtures:** all `stochastic/*`; `stochastic/seeded-reproducibility`.
- **Introduced in:** contract 1.0.
