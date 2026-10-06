# MCD-0007 — Percentage scaling uses round-half-away-from-zero

- **Status:** accepted
- **Contract:** 1.0 (money)
- **Audit ref:** D-07, B-02
- **Question:** How is an integer percentage applied to an integer-cent amount?
- **Options:** A. floor/truncate integer division; B. round half away from zero; C. float multiply then round.
- **Decision:** B, via `round_half_away(amount * (100 + percent), 100)`. No floor division, no floats.
- **Reason:** Python used floor division `//` (`risk.py:26`) on the delta (`amount += (amount*percent)//100`),
  which over-subtracts for negative percentages (e.g. `101`, `-8`: Python yields `92`, correct is
  `93`). Kotlin already scaled by `(100 + percent)` with HALF_UP (`scaleCentsByPercent(100, 1) = 101`).
  A single exact integer rule removes the bias and the divergence. (MC-03 caught that an early draft
  of this contract mis-defined the function as a delta; this record reflects the corrected rule.)
- **Affected fixtures:** `deterministic/percentage-scaling`, `stochastic/income-variation`.
- **Introduced in:** contract 1.0.
