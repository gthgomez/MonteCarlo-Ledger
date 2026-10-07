# MonteCarlo Financial Contract

**Contract version: 2.0** (see `version.json`)

This directory is the **normative** definition of MonteCarlo's financial semantics. It is
language-neutral and implementation-independent. The Python `MonteCarlo-Ledger` engine and the
Kotlin `MonteCarloLedger-Android` engine are both **conformant implementations** of this contract,
not sources of truth.

> If an implementation and this contract disagree, the implementation is wrong (or the contract
> must be deliberately revised via a new version and an MCD record).

## Authority model

```text
              NORMATIVE MONTECARLO CONTRACT  (this directory)
                         │
             ┌───────────┴───────────┐
             │                       │
          Schemas               Golden corpus
          /schemas              /fixtures
             │                       │
             └───────────┬───────────┘
                         │
                 Contract version 2.0
                         │
              ┌──────────┴──────────┐
              │                     │
        Python engine          Kotlin engine
             │                     │
          pytest                  JUnit
              │                     │
              └──────────┬──────────┘
                         │
                  dumb comparer
                         │
                 divergence report
```

Neither Python nor Kotlin defines truth independently. Ideas, bugs, and better semantics may be
discovered in **either** engine; a semantic change is canonical only after it is written into this
contract (or a new version) **and** captured in the golden corpus. Semantic discoveries are not
proprietary implementation code, so they may be contributed to this public contract from either
project; proprietary Kotlin *implementation* code must not be copied here.

## Documents

| File | Area | Version |
|---|---|---|
| [`money.md`](money.md) | integer money, rounding, overflow, currency | money 1.0 |
| [`timeline.md`](timeline.md) | `as_of`, horizon boundaries, ordering, recurrence, occurrence exclusions | timeline 1.1 |
| [`ledger.md`](ledger.md) | entries, balances, accounts, pending/posted | ledger 1.0 |
| [`forecast.md`](forecast.md) | deterministic projection metrics | forecast 1.0 |
| [`simulation.md`](simulation.md) | PRNG, uncertainty model, aggregation, per-category variation | simulation 1.1 |
| [`risk.md`](risk.md) | percentiles, probability of negative, safe-to-spend | risk 1.0 |
| [`debt.md`](debt.md) | liabilities, amortization schedule, payoff strategy | debt 1.0 |

Related artifacts:

- `/schemas/scenario.schema.json` — canonical scenario input.
- `/schemas/result.schema.json` — canonical engine output.
- `/fixtures/` — the golden scenario corpus.
- `/semantic-decisions/` — MCD records for material decisions.
- `/CONTRACT_CHANGELOG.md` — versioned history.
- `/tools/conformance/` — the dumb comparer.

## Rules for reading this contract

1. The contract defines **observable behavior**, not implementation structure. "If two events share
   a date, income sorts before expense" is contract; "the Python function calls X before Y" is not.
2. All quantities that cross the contract boundary are integers. Money is signed 64-bit cents.
   Probabilities are parts-per-million integers. Percent variation is an integer percent.
3. Every engine entry point takes an explicit `as_of` date. No financial function may read a clock.
4. Where this contract is silent, an implementation may choose; but whatever it chooses must not be
   observable through the canonical result schema.
5. A silent change to financial meaning is forbidden. Change the contract version and add an MCD.

## Versioning

The contract uses `MAJOR.MINOR`:

- **MAJOR** — a change that alters a financial conclusion for an existing valid scenario, or removes
  or renames a field in the canonical schemas.
- **MINOR** — a backward-compatible clarification or addition (new optional field, new fixture, a
  stricter definition that no existing valid scenario can observe).

Each area has its own component version. A contract release pins all component versions together.
Implementations declare which contract release they target.

The canonical **result** echoes the `contract_version` declared by its scenario (`"1.0"` or `"1.1"`),
so a 1.0 scenario is never silently reinterpreted as a later version. A MINOR addition keeps every
prior version's scenarios valid; the schema enumerates the accepted values.
