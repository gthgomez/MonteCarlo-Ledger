# MCD-0016 — Recurrence preserves its month anchor across clamped months

- **Status:** accepted
- **Contract:** 1.0 (timeline)
- **Audit ref:** D-16, B-07
- **Question:** With a monthly obligation on the 31st, what happens after February?
- **Options:** A. preserve the anchor (Jan 31 → Feb 28 → Mar 31); B. clamp and drift (Jan 31 → Feb 28
  → Mar 28).
- **Decision:** A. The anchor day is a property of the recurrence; clamping only shortens a month
  that lacks that day.
- **Reason:** Python preserved the anchor via `due_day`; Kotlin lost it when `day_of_month` was null
  (B-07). Option A is the intuitive semantics ("rent is due on the 31st, or the last day"). The
  contract makes the anchor explicit and required for monthly recurrences.
- **Affected fixtures:** `boundary/month-end-recurrence`, `boundary/leap-year`.
- **Introduced in:** contract 1.0.
