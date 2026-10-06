# MCD-0005 — One percentile convention: nearest-rank

- **Status:** accepted
- **Contract:** 1.0 (risk)
- **Audit ref:** D-05, B-06
- **Question:** Which percentile/median definition is canonical?
- **Options:** A. nearest-rank (`ceil(N·q)-1`); B. linear interpolation (NumPy/Excel); C. nearest-rank
  for tails but averaged midpoint for the median.
- **Decision:** A, for **all** percentiles including the median. `P50` for even `N` is the lower
  middle element; no averaging, no interpolation.
- **Reason:** The engines already used nearest-rank tails, so tails change little; the divergences
  were in the median (Python floored average, Kotlin averaged midpoint) and Kotlin's calibrator used
  a third formula. A single element-preserving rule is exact, integer, and trivially identical in
  both languages. Interpolation would reintroduce floats.
- **Affected fixtures:** `stochastic/*`, `boundary/percentile-small-n`.
- **Introduced in:** contract 1.0.
