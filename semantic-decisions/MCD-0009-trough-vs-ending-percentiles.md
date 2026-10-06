# MCD-0009 — Trough percentiles and ending percentiles are named separately

- **Status:** accepted
- **Contract:** 1.0 (risk)
- **Audit ref:** D-09
- **Question:** Do "P10/P50/P90" describe the trough of each run or the ending balance?
- **Options:** A. expose both families with explicit names; B. trough only; C. ending only.
- **Decision:** A. `minimum_balance_p*_cents` (trough) and `ending_balance_p*_cents` are both
  reported. No field is merely `p10`.
- **Reason:** Kotlin surfaced trough percentiles but labeled them "worst/typical/best case"; Python
  mixed a trough "worst 10%" with a median **ending** balance. The labels were ambiguous and the
  underlying quantities differed. Explicit names make the divergence impossible to hide.
- **Affected fixtures:** `stochastic/*`.
- **Introduced in:** contract 1.0.
