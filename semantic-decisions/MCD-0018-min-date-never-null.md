# MCD-0018 — `minimum_balance_date` is never null

- **Status:** accepted
- **Contract:** 1.0 (forecast)
- **Audit ref:** D-18
- **Question:** When the starting balance is the lowest point, what date is reported?
- **Options:** A. `as_of`; B. `null`; C. the last event date.
- **Decision:** A. When `min(B)` equals the starting balance and no row is strictly lower, the date is
  `as_of`; otherwise it is the date of the first row achieving the minimum.
- **Reason:** Both engines returned `null`/`None`, conflating "no dip" with "unknown date". A
  non-nullable date is simpler for schemas and consumers and is well-defined under tie-breaking.
- **Affected fixtures:** `deterministic/no-dip`, `boundary/exact-zero`.
- **Introduced in:** contract 1.0.
