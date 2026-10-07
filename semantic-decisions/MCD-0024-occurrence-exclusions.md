# MCD-0024 — Occurrence exclusions (per-occurrence suppression)

- **Status:** accepted
- **Contract:** 1.1 (timeline)
- **Audit ref:** MC-07 candidate #1 / finding C5
- **Question:** How can a scenario express that a single generated occurrence — in the *middle* of a
  recurrence's window — must not be projected (for example, a user who already paid or moved that
  occurrence)?
- **Options:**
  - A. Advance the recurrence's `start_date` only (status quo). Can express a suppressed *prefix*,
    but not a middle occurrence; a middle suppression leaves the template occurrence projected
    while the explicit moved event is also projected — a double count.
  - B. Add an optional top-level `occurrence_exclusions: [{recurrence_id, date}]` list.
  - C. Add a per-recurrence `exclude_dates: [date]` field.
  - D. First-class "override" events that implicitly suppress their template counterpart.
- **Decision:** **B.** The scenario may declare an optional top-level list
  `occurrence_exclusions: [{ "recurrence_id", "date" }]`. A listed `(recurrence_id, date)` removes
  that generated occurrence before the expected-amount slot is decided. Explicit `events` are
  unaffected. A pair matching no occurrence is a no-op.
- **Reason:** Any occurrence in the window (not just a prefix) must be suppressible, and the product
  already knows the `(recurrence id, date)` of a paid/moved occurrence. A flat list is a single
  schema addition and keeps recurrences unchanged; option C is equivalent but couples the exclusion
  to the recurrence object, and option D overloads explicit events with a suppression side effect.
  The addition is backward compatible (absent field = current behavior), so it is MINOR: contract
  1.1, not 2.0.
- **Affected fixtures:** `boundary/mid-window-exclusion`, `deterministic/moved-occurrence-override`,
  `boundary/exclusion-first-income-expected-amount`.
- **Introduced in:** contract 1.1 (timeline 1.1). All 1.0 scenarios and results are unchanged; the
  canonical result echoes the scenario's declared version.
