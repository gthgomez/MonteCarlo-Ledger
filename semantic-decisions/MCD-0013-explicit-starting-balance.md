# MCD-0013 — Starting balance is an explicit required input

- **Status:** accepted
- **Contract:** 1.0 (ledger, forecast)
- **Audit ref:** D-13
- **Question:** How is the opening balance represented?
- **Options:** A. explicit `starting_balance_cents`; B. an adjustment entry; C. a stored setting.
- **Decision:** A. Required, signed, applied before any in-window event.
- **Reason:** Python required seeding an Adjustment transaction; Kotlin had a dead `starting_balance`
  setting and inferred the opening balance from reconciled bank vs ledger. An explicit input removes
  reconciliation ambiguity from the contract, makes a negative (overdraft) start expressible, and is
  necessary for `first_negative_date` semantics.
- **Affected fixtures:** all.
- **Introduced in:** contract 1.0.
