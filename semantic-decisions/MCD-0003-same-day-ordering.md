# MCD-0003 — Same-day ordering: income before expense, overridable by sequence

- **Status:** accepted
- **Contract:** 1.0 (timeline)
- **Audit ref:** D-03
- **Question:** When a paycheck and a bill fall on the same date, what is the canonical order?
- **Options:** A. income first; B. expense first; C. explicit sequence only; D. undefined.
- **Decision:** Sort by `(date, sequence, input_index)`, where `sequence` defaults to `0` for income
  and `1` for expense/adjustment. An explicit `sequence` overrides the default.
- **Reason:** Both engines already applied income first; pinning it preserves behavior and keeps
  results stable. Exposing `sequence` preserves an escape hatch without changing the default. This
  is a deterministic convention, not a claim about intraday reality (an intraday-low warning is left
  to a non-normative surface).
- **Affected fixtures:** `deterministic/same-day-income-before-bill`.
- **Introduced in:** contract 1.0.
