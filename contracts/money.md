# Money — Contract 1.0

## Representation

- Money is an **integer number of minor units**: signed 64-bit cents. `1 USD = 100 cents`.
- No floating-point value may cross a contract boundary. Parsing/formatting of decimal strings is
  an input/output concern, not part of core semantics; core functions accept and return `int`
  (Python) / `Long` (Kotlin) cents.
- Valid range: `MIN_MONEY_CENTS = -(2^63 - 1)`, `MAX_MONEY_CENTS = 2^63 - 1`.

## Currency

- Contract 1.0 assumes a **single currency**, USD, with 2 minor digits. No currency field exists in
  the canonical schemas. Multi-currency is deferred (see MCD-0019).

## Rounding

The only rounding rule in the contract is **round half away from zero** (`HALF_UP`).

For integer numerator `n` and positive integer denominator `d`:

```text
round_half_away(n, d) = sign(n) * ((abs(n) + d // 2) // d)
```

This is exact integer arithmetic and is identical in every language. `sign(0) = 0`.

- Decimal-string parsing to cents uses `round_half_away(value * 100, 1)` (equivalently,
  `Decimal`/`BigDecimal` HALF_UP).
- Banker's rounding (round-half-to-even) is **not** used anywhere.

## Percentage scaling

Two canonical scaling functions, both built only on `round_half_away`:

```text
scale_cents_by_percent(amount_cents, percent)  = round_half_away(amount_cents * percent, 100)
scale_cents_by_basis_points(amount_cents, bps) = round_half_away(amount_cents * bps, 10000)
scale_cents_by_bps_over_months(amount_cents, bps, months)
                                               = round_half_away(amount_cents * bps, 10000 * months)
```

Examples (binding):

| call | result |
|---|---|
| `scale_cents_by_percent(100, 1)` | `1` |
| `scale_cents_by_percent(100, -1)` | `-1` |
| `scale_cents_by_percent(101, -8)` | `-8` (not `-9`) |
| `scale_cents_by_percent(150, 0)` | `0` |
| `scale_cents_by_basis_points(999, 500)` | `50` (5% of 999 = 49.95 → 50) |

Integer floor division (`//`, `Math.floorDiv`) must **not** be used to apply a percentage; that is
the mechanism behind audit bug B-02.

## Overflow

- A money operation whose exact result falls outside the valid range is an error, code
  `MONEY_OVERFLOW`. Implementations must not wrap, saturate silently, or promote to floating point.
- Adding or subtracting amounts must be overflow-checked. Kotlin must use `Math.addExact` /
  `Math.subtractExact` (or an explicit check); Python must range-check the result.
- The negation of `MIN_MONEY_CENTS` is out of range and is itself `MONEY_OVERFLOW`; in particular,
  display code must not compute `-cents` unguarded.

## Invalid values

- A monetary amount that is not an integer, is `null`/`None`, or is unparseable is an error, code
  `INVALID_AMOUNT`. Implementations must not coerce invalid input to `0`.
- Zero is valid for the `adjustment` ledger type only; zero `income`/`expense` is `INVALID_AMOUNT`
  (see `ledger.md`).
