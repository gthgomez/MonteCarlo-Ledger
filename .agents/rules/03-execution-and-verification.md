# Montecarlo Budget Sim Execution And Verification

Read this rule for all non-trivial work.

## Plan Vs Act

- `LOW` risk: CLI copy, isolated presentation changes, doc-only edits
- `MEDIUM` risk: API behavior, timeline output, recurrence edge cases, onboarding flow
- `HIGH` risk: money math, balance logic, persistence, schema, or risk-engine behavior

Act directly only when the change is small and the invariant surface is clear.
For medium or high-risk work, identify the affected invariants before editing.

## Verification Expectations

- Never call a financial change complete without tests or direct reconciliation evidence.
- Prefer this order of evidence:
  1. direct file inspection
  2. targeted tests
  3. reproduction scripts
  4. inferred behavior, clearly labeled

## Required Checks

- Money or balance logic: run targeted finance tests and mention ledger consistency.
- Persistence or API change: include API or persistence tests when relevant.
- Timeline or risk-engine change: include projection and paid-occurrence checks explicitly.
