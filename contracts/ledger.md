# Ledger — Contract 1.0

## The ledger

- A scenario has a `starting_balance_cents` and an ordered list of ledger **entries**.
- The balance is always derived, never stored authoritatively:

  ```text
  balance = starting_balance_cents + sum(entry.amount_cents for entry in entries)
  ```

- A "cached balance", a "reconciled bank balance", and a database row are **persistence concerns**,
  not part of this contract. If an implementation keeps a cached balance, it must reconcile to the
  derived balance before producing contract-observable results; a divergence is the
  implementation's error to resolve, not a valid alternative result.

## Entry types

| Type | Sign rule | Notes |
|---|---|---|
| `income` | `amount_cents > 0` | zero or negative is `INVALID_AMOUNT` |
| `expense` | `amount_cents < 0` | zero or positive is `INVALID_AMOUNT` |
| `adjustment` | any sign, including non-zero | used for opening corrections; zero is `INVALID_AMOUNT` |

All entries, regardless of type, contribute to the derived balance.

## Starting balance

- `starting_balance_cents` is a required signed integer. It is the balance **at and before `as_of`**,
  before any in-window event.
- A negative starting balance is valid (an overdraft) and is significant: see `forecast.md` for how
  it affects `first_negative_date`, and `risk.md` for how it affects the probability of negative.
- There is no implicit opening balance and no adjustment needed to express one. This resolves audit
  D-13 (Python required an Adjustment seed; Kotlin's `starting_balance` setting was dead).

## Accounts and transfers (scope)

- **Contract 1.0 models exactly one logical cash account.** The canonical `scenario.schema.json`
  has no account field.
- Multiple accounts, transfers between accounts, and credit-card / liability routing are **deferred
  to a future contract version** (see MCD-0012). Android's `AccountEntity`, default-account
  adoption, and credit/debt routing remain valid native features but are outside the v1 canonical
  surface.
- Rationale: Python has no account model, so including accounts in v1 would require adding a whole
  subsystem to the reference engine and would not prove the core thesis. The v1 contract proves
  money/time/forecast/simulation/risk equivalence first.

## Pending vs posted

- Contract 1.0 has **no pending/posted distinction**. Every entry counts toward the balance.
- A clearing status may exist natively (Kotlin) as a display/lifecycle attribute. It must not change
  forecast or simulation numbers in the canonical surface.
- This resolves audit D-11 by adopting Kotlin's observed behavior (pending counts) and removing the
  ambiguity from the contract: since *all* entries count, the scenario schema need not carry a
  status at all.

## Sign and linkage invariants

- Entry sign rules above are enforced at construction; violating one is `INVALID_AMOUNT`.
- A single logical entry must not be applied twice. Implementations that link a transaction to a
  scheduled occurrence must enforce one-to-one linkage; double-application is an implementation
  error, not contract-permitted behavior.
