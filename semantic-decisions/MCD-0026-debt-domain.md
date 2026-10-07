# MCD-0026 — Debt / liability amortization domain

- **Status:** accepted
- **Contract:** 2.0 (debt; new component `debt` 1.0)
- **Audit ref:** MC-07 Contract 2.0 candidate #2 (and MC-07 finding C3)
- **Question:** The product shows debt payoff projections (months to payoff, total interest,
  snowball/avalanche strategies, extra-payment savings) computed natively by `DebtPayoffEngine`.
  Contract 1.x models exactly one cash account and defers liabilities (MCD-0012), so those
  conclusions have no canonical authority. Should the contract model debt?
- **Options:**
  - A. Keep the status quo: debt stays native and outside the contract.
  - B. Add a canonical **liability + amortization** domain: scenario `liabilities` (and
    `debt_strategy` / `extra_monthly_payment_cents`), result `debt` block with the schedule.
  - C. Keep the math native but submit the schedule as ordinary `events` (cash-only canonical).
- **Decision:** **B.** The scenario may declare `liabilities`; the engine returns a deterministic
  `debt` block computed by the normative procedure in `contracts/debt.md`.
- **Reason:** Debt payoff is a user-visible financial conclusion, so per the campaign's north star
  it must originate in the contract. Option C would make only the *cash* effect canonical and leave
  `months_to_payoff` / `total_interest_cents` / strategy comparisons without authority, so two
  implementations could still disagree about the debt answer. The debt domain is deliberately
  **separate from `forecast`**: liabilities are not auto-injected into the cash projection; a caller
  that wants them there adds the payment amounts as ordinary `events`. This keeps the ledger
  forecast orthogonal and avoids an implicit cross-domain interaction rule.
- **Supersedes:** the deferred-liabilities clause of **MCD-0012** (multi-account/transfers remain
  deferred; only liabilities are now modelled). Because this adds a new conclusion class and
  supersedes a prior scope decision, it is a **MAJOR** bump (2.0), not a minor addition.
- **Affected fixtures:** `debt/installment-basic`, `debt/revolving-minimum`, `debt/snowball-order`,
  `debt/avalanche-order`, `debt/extra-payment`, `debt/non-convergence`,
  `invalid/duplicate-liability-id`.
- **Introduced in:** contract 2.0 (debt 1.0).
