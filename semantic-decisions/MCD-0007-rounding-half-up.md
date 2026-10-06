# MCD-0007 — Percentage scaling uses round-half-away-from-zero

- **Status:** accepted
- **Contract:** 1.0 (money)
- **Audit ref:** D-07, B-02
- **Question:** How is an integer percentage applied to an integer-cent amount?
- **Options:** A. floor/truncate integer division; B. round half away from zero; C. float multiply then round.
- **Decision:** B, via `round_half_away(amount * percent, 100)`. No floor division, no floats.
- **Reason:** Python used floor division `//` (`risk.py:26`), which over-subtracts for negative
  percentages (`101 * -8 // 100 = -9`, an 8.91% cut). Kotlin already used HALF_UP. A single exact
  integer rule removes the bias and the divergence.
- **Affected fixtures:** `deterministic/percentage-scaling`, `stochastic/income-variation`.
- **Introduced in:** contract 1.0.
