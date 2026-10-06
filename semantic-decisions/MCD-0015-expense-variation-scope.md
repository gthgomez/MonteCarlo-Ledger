# MCD-0015 — Expense/category variation is defined but disabled by default in 1.0

- **Status:** accepted
- **Contract:** 1.0 (simulation) — scope decision
- **Audit ref:** D-15
- **Question:** Does the canonical simulation vary expenses and categories?
- **Options:** A. define a single scalar expense variation range (default `0..0`) and defer
  per-category variation; B. include per-category ranges in v1; C. exclude expense variation entirely.
- **Decision:** A. `expense_variation_min/max` exist and are applied per expense event when enabled;
  with the default `0..0` no draw occurs. Per-category variation and calibration-derived ranges are
  deferred (candidate later component version).
- **Reason:** Kotlin has scalar and per-category variation; Python had none. A scalar range is small
  enough to add to Python and keeps the default draw stream identical (so default fixtures pass on
  both engines without Python gaining a category subsystem). Per-category variation depends on the
  ledger's categorization, which is not yet in the canonical scenario.
- **Affected fixtures:** `stochastic/expense-variation` (explicit enablement).
- **Introduced in:** contract 1.0.
