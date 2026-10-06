# MCD-0021 — Ordering index for generated (expanded/synthetic) entries

- **Status:** accepted
- **Contract:** 1.0 (timeline) — clarification
- **Audit ref:** MC-06 flagged ambiguity
- **Question:** `input_index` is defined as "position in the scenario's `events` array"; what index do
  recurrence-expanded occurrences and Monte Carlo surprise entries use?
- **Options:** A. index after all explicit events, in generation order; B. omit and rely on date;
  C. reuse the parent recurrence's index.
- **Decision:** A. Every explicit event keeps its array position. Expanded recurrence occurrences are
  indexed after all explicit events, in recurrence-array order and then ascending occurrence date.
  Synthetic surprise entries are indexed after all base events, in append order.
- **Reason:** The order tuple `(date, sequence, input_index)` must be total and reproducible across
  engines. Python and Kotlin independently chose the same rule; codifying it prevents a future
  divergence. Only observable for same-date, same-sequence ties.
- **Affected fixtures:** `boundary/anchor-differs-from-start` (indirectly); no tie fixture yet.
- **Introduced in:** contract 1.0 (clarification; no version bump — not observable by prior valid
  fixtures).
