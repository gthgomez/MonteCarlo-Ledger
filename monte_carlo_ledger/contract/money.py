"""Money semantics for MonteCarlo Contract 1.0. No floating point."""

from __future__ import annotations

MAX_MONEY_CENTS = (1 << 63) - 1
MIN_MONEY_CENTS = -MAX_MONEY_CENTS


class ContractError(Exception):
    """A contract violation, carrying a stable error code."""

    def __init__(self, code: str, message: str = "") -> None:
        self.code = code
        super().__init__(f"{code}: {message}" if message else code)


def round_half_away(n: int, d: int) -> int:
    """Round n/d to the nearest integer, ties away from zero. d > 0."""
    if d <= 0:
        raise ValueError("denominator must be positive")
    if n == 0:
        return 0
    sign = 1 if n > 0 else -1
    return sign * ((abs(n) + d // 2) // d)


def scale_cents_by_percent(amount_cents: int, percent: int) -> int:
    """Scale an amount by a signed percent variation: (100 + percent)% of the amount."""
    return _checked_round(amount_cents * (100 + percent), 100)


def scale_cents_by_basis_points(amount_cents: int, bps: int) -> int:
    return _checked_round(amount_cents * bps, 10000)


def _checked_round(numerator: int, denominator: int) -> int:
    result = round_half_away(numerator, denominator)
    if result > MAX_MONEY_CENTS or result < MIN_MONEY_CENTS:
        raise ContractError("MONEY_OVERFLOW", f"scaled money {result}")
    return result


def checked_add(a: int, b: int) -> int:
    r = a + b
    if r > MAX_MONEY_CENTS or r < MIN_MONEY_CENTS:
        raise ContractError("MONEY_OVERFLOW", f"{a} + {b}")
    return r


def checked_sub(a: int, b: int) -> int:
    """Subtract with the same signed-64-bit overflow policy as ``checked_add``."""
    r = a - b
    if r > MAX_MONEY_CENTS or r < MIN_MONEY_CENTS:
        raise ContractError("MONEY_OVERFLOW", f"{a} - {b}")
    return r


def require_cents(
    value: object,
    field: str,
    *,
    minimum: int = MIN_MONEY_CENTS,
    maximum: int = MAX_MONEY_CENTS,
) -> int:
    """Return ``value`` only when it is an exact in-range integer number of cents.

    Booleans, floats (including integral floats), numeric strings, null and any
    other type are rejected. No implicit truncation, rounding or saturation.
    """
    if not isinstance(value, int) or isinstance(value, bool):
        raise ContractError(
            "INVALID_AMOUNT",
            f"{field} must be an integer number of cents, got {value!r}",
        )
    if value < minimum or value > maximum:
        raise ContractError(
            "MONEY_OVERFLOW",
            f"{field} {value} is outside [{minimum}, {maximum}]",
        )
    return value
