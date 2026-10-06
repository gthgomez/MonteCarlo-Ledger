# MCD-0017 — `expected_amount_cents` applies to the first in-window occurrence

- **Status:** accepted
- **Contract:** 1.0 (timeline)
- **Audit ref:** D-17, B-03
- **Question:** If an irregular paycheck's expected amount is set, which occurrence uses it?
- **Options:** A. the first occurrence at or after `as_of`; B. the first occurrence of the recurrence
  regardless of window; C. every occurrence.
- **Decision:** A, and only that one.
- **Reason:** Python applied it to the first generated occurrence and silently dropped it when that
  occurrence fell before the window start (B-03). Kotlin applied it to the first *emitted*
  occurrence. Anchoring to the first in-window occurrence is well-defined and window-relative, which
  is the only thing a caller can observe.
- **Affected fixtures:** `deterministic/expected-amount-first`, `boundary/expected-amount-before-as-of`.
- **Introduced in:** contract 1.0.
