# MCD-0022 — Calendar recurrence: `start_date` is a lower bound; `anchor_day` sets the day

- **Status:** accepted
- **Contract:** 1.0 (timeline)
- **Audit ref:** MC-06 flagged divergence between Python and Kotlin
- **Question:** For a monthly-family recurrence whose `start_date` does not fall on `anchor_day`,
  what is the first occurrence?
- **Options:** A. `start_date` is the first occurrence, then anchor dates follow (Python's original
  behavior); B. occurrences are the anchor dates on/after `start_date` (Kotlin's behavior);
  C. undefined.
- **Decision:** B. `start_date` is a **lower bound**. The anchor is `anchor_day` when present,
  otherwise `start_date.day`. Occurrence months are `start_date`'s month plus `k` steps, and the
  first occurrence is the smallest generated date `>= start_date`.
- **Reason:** `anchor_day` exists to define *the day of the month*. Forcing `start_date` as a first
  occurrence produces a partial first period and makes the anchor's meaning depend on the start day.
  Option B is the simpler, more predictable rule; the campaign explicitly allows adopting the
  better Kotlin semantics rather than defaulting to Python. Python was changed; Kotlin already did
  this. With no explicit anchor, anchor defaults to `start_date.day`, so the first occurrence is in
  `start_date`'s month, preserving prior behavior for the common case.
- **Affected fixtures:** `boundary/anchor-differs-from-start`.
- **Introduced in:** contract 1.0 (clarification of previously ambiguous text; the four stochastic
  fixtures and all other fixtures are unaffected).
