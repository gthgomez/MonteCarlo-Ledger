# MCD-0004 — Probability of negative balance in integer parts-per-million

- **Status:** accepted
- **Contract:** 1.0 (risk)
- **Audit ref:** D-04
- **Question:** What unit represents a probability at the contract boundary?
- **Options:** A. percent float 0–100; B. fraction float 0–1; C. integer parts-per-million.
- **Decision:** C. `negative_balance_probability_ppm = round_half_away(negative_runs * 1_000_000, runs)`.
  Range `0 … 1_000_000`.
- **Reason:** Floats are not exactly comparable across runtimes and invite unit confusion (the audit
  found both engines used a bare percent float with no schema). Integer ppm is exact, monotone, and
  makes cross-engine equality meaningful. Display converts ppm to a percentage.
- **Affected fixtures:** all `stochastic/*`.
- **Introduced in:** contract 1.0.
