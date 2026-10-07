# MCD-0025 — Per-category expense variation

- **Status:** accepted
- **Contract:** 1.2 (simulation; simulation component 1.1)
- **Audit ref:** MC-00 D-15 / MC-07 Contract 2.0 candidate #3
- **Question:** Contract 1.0/1.1 varied expenses by a single scalar range applied to every
  non-income event. The product calibrates a variation range **per category** and could not express
  it. How should per-category variation enter the contract?
- **Options:**
  - A. Keep the scalar only (status quo); the product drops its per-category ranges.
  - B. Add an optional `expense_category_variation` list plus an optional `category` on events and
    recurrences, with a matching category overriding the scalar range.
  - C. Make category variation required and remove the scalar.
- **Decision:** **B** — an optional list of `{ "category", "min", "max" }` and an optional
  `category` string on `events` and `recurrences`. For a non-income event, a matching category range
  is used and the scalar range is ignored; otherwise the event falls back to the scalar range (or no
  draw if the scalar is disabled). Duplicate `category` entries are `SCHEMA_INVALID`. Matching is by
  exact string (no normalization).
- **Reason:** A very small number of product categories currently have enough history to calibrate
  (the Android calibrator requires `MIN_CATEGORY_MONTHS` and excludes uncategorized spend), so most
  events must keep the scalar fallback. An optional, additive field keeps every 1.0/1.1 scenario and
  its draw stream **byte-identical** while letting the product express the ranges it already
  computes. Option C would break every existing scenario for no benefit.
- **Affected fixtures:** `stochastic/expense-variation` (the scalar fixture MCD-0015 referenced but
  which had never landed), `stochastic/category-expense-variation` (category override + scalar
  fallback), `invalid/duplicate-category-variation`.
- **Introduced in:** contract 1.2. Backward compatible: an empty `expense_category_variation` (the
  default) leaves the RNG stream identical to 1.1.
