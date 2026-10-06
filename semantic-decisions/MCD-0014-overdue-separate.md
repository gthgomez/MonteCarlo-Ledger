# MCD-0014 — Overdue events are separate from the forecast window

- **Status:** accepted
- **Contract:** 1.0 (timeline)
- **Audit ref:** D-14
- **Question:** How do unpaid obligations dated before `as_of` affect the projection?
- **Options:** A. exclude them from the forecast; expose an explicit overdue list; B. Python's 30-day
  lookback merged into the timeline; C. Kotlin's emit-everything-past-on-`as_of`.
- **Decision:** A. The forecast window contains only events dated `>= as_of`. Overdue items, if any,
  are a separate non-normative list and must not change forecast numbers. A scenario that wants a
  past obligation to matter sets its balance effect through `starting_balance_cents` or an explicit
  event date.
- **Reason:** Python and Kotlin each used a different implicit past-due model, both of which could
  move `minimum_balance_date` and `first_negative_date` for reasons invisible in the scenario. Making
  overdue state explicit removes a major source of unexplainable cross-engine differences.
- **Affected fixtures:** `boundary/past-due-excluded`, `deterministic/overdue-separate`.
- **Introduced in:** contract 1.0.
