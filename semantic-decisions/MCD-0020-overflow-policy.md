# MCD-0020 — Overflow is an error, never a wrap or a silent saturation

- **Status:** accepted
- **Contract:** 1.0 (money)
- **Audit ref:** D-20, B-08
- **Question:** What happens when an arithmetic result exceeds the signed-64-bit cents range?
- **Options:** A. error (`MONEY_OVERFLOW`); B. wrap; C. saturate to the range bound.
- **Decision:** A. Additions/subtractions and scaling must be overflow-checked; a result outside
  `[-(2^63-1), 2^63-1]` is `MONEY_OVERFLOW`. Negating `MIN_MONEY_CENTS` is also `MONEY_OVERFLOW`.
- **Reason:** Neither engine guarded Monte Carlo arithmetic (B-08); Kotlin's display code negated
  values unguarded, which overflows at `Long.MIN_VALUE`. Silent wrapping produces a wrong financial
  answer with no signal — the opposite of the project's trust goal. (The debt engine's saturating
  behavior is a separate, non-normative concern.)
- **Affected fixtures:** `invalid/money-overflow`, `invalid/negate-min`.
- **Introduced in:** contract 1.0.
