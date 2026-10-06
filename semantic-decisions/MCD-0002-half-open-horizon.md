# MCD-0002 — Half-open horizon `[as_of, as_of + horizon_days)`

- **Status:** accepted
- **Contract:** 1.0 (timeline)
- **Audit ref:** D-02
- **Question:** Is the forecast end date inclusive or exclusive, and how long is an "N-day" horizon?
- **Options:** A. inclusive `[as_of, as_of+N]` (N+1 dates); B. half-open `[as_of, as_of+N)` (N dates).
- **Decision:** B. An event dated exactly `as_of` is included; an event dated exactly
  `as_of + horizon_days` is excluded. `horizon_days=90` spans 90 dates.
- **Reason:** Python was end-inclusive (a "30-day" horizon spanned 31 dates, and its docstring even
  contradicted its code). Kotlin was already half-open and had a coherent 91-point daily grid.
  Adopting Kotlin's convention is the smaller, clearer change.
- **Affected fixtures:** `boundary/horizon-end-exclusive`, `boundary/horizon-zero`.
- **Introduced in:** contract 1.0.
