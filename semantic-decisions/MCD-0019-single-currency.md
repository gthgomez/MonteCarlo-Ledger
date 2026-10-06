# MCD-0019 — Single currency (USD) in contract 1.0

- **Status:** accepted
- **Contract:** 1.0 (money) — scope decision
- **Audit ref:** D-19
- **Question:** Does the contract carry a currency?
- **Options:** A. fixed single currency (USD, 2 minor digits); B. a currency code per amount;
  C. multi-currency with FX.
- **Decision:** A.
- **Reason:** Neither engine models currency; both hardcode `$`. FX and per-entry currencies add large
  semantics (rates, as-of FX, rounding) that would swamp the core conformance goal. The contract
  states the assumption explicitly so it is a known limitation rather than an accident.
- **Affected fixtures:** all (no currency field).
- **Introduced in:** contract 1.0.
