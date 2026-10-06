# MCD-0011 — Pending/posted does not change balances in the contract

- **Status:** accepted
- **Contract:** 1.0 (ledger)
- **Audit ref:** D-11
- **Question:** Do pending entries count toward balances and forecasts?
- **Options:** A. all entries count, clearing status is display-only; B. only posted count;
  C. pending is a separate balance.
- **Decision:** A. The canonical scenario has no clearing field; every entry counts.
- **Reason:** Kotlin already counts pending in `SUM(amount_cents)` but exposed a status, while Python
  had no pending concept at all. Choosing A matches the one existing behavior and removes the field
  from the canonical surface, keeping v1 small. If a future product needs posted-only authoritative
  balances, it becomes a new contract version with fixtures.
- **Affected fixtures:** `ledger/*` (no clearing field)
- **Introduced in:** contract 1.0.
