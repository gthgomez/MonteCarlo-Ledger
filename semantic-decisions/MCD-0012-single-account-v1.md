# MCD-0012 — Contract 1.0 models one logical cash account; multi-account deferred

- **Status:** accepted
- **Contract:** 1.0 (ledger) — scope decision
- **Audit ref:** D-12
- **Question:** Does the canonical contract include multiple accounts and transfers?
- **Options:** A. single logical account in v1, defer accounts/transfers; B. include accounts and
  transfers in v1; C. accounts without transfers.
- **Decision:** A.
- **Reason:** Android has accounts, default-account adoption, and credit/debt routing; Python has no
  account model at all. Including accounts in v1 would require building a new subsystem into the
  reference engine before the core money/time/forecast/simulation/risk equivalence is even proven.
  The campaign's own guidance is to keep scope disciplined and prove the core thesis first.
  Multi-account and transfers become a deliberate later contract version (candidate 2.0). Android
  keeps its native account features; they are simply outside the v1 canonical surface.
- **Affected fixtures:** deferred; a `deferred/` note points here.
- **Introduced in:** contract 1.0.
