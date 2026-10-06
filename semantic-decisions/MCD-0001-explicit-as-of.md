# MCD-0001 — Explicit `as_of`; no clock in the financial core

- **Status:** accepted
- **Contract:** 1.0 (timeline)
- **Audit ref:** D-01, B-01
- **Question:** May a forecast or simulation read the current date implicitly?
- **Options:** A. implicit `now()`; B. required `as_of` date input; C. injected clock with `now` default.
- **Decision:** B. Every forecast/simulation takes a required calendar `as_of` (date-only, no time,
  no timezone). The financial core may not read a wall clock.
- **Reason:** Python's seeded Monte Carlo was not reproducible across days (`risk.py:33` used
  `datetime.now()`); Kotlin injected `today` but still defaulted to the clock. Reproducibility and
  cross-engine conformance are impossible without an explicit date. Date-only removes timezone
  semantics entirely.
- **Affected fixtures:** all. `invalid/missing-as-of`.
- **Introduced in:** contract 1.0.
