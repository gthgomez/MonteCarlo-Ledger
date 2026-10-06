# MCD-0008 — `safe_to_spend` is a quantile-based value; the low point is separate

- **Status:** accepted
- **Contract:** 1.0 (risk)
- **Audit ref:** D-08
- **Question:** What does "safe to spend" mean, and how does it differ from the projected low point?
- **Options:** A. split: `projected_low_point` (deterministic min) vs
  `safe_to_spend = minimum_balance_p{q} - reserve`; B. one deterministic low point renamed; C. only
  a conservative P10-minus-reserve number.
- **Decision:** A. Both are exposed under distinct names. `safe_to_spend` is signed and may be
  negative. `reserve_cents` defaults to 0; `q` defaults to `1/10`.
- **Reason:** Both engines returned the deterministic minimum but labeled or documented it as a
  spendable amount — a real terminology/math drift (audit D-08). Splitting keeps the transparent
  baseline and gives "safe" a precise, quantile-based meaning. Product/UX work may choose different
  defaults, but the semantics are fixed.
- **Affected fixtures:** `stochastic/safe-to-spend`, `deterministic/projected-low-point`.
- **Introduced in:** contract 1.0.
