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
    return round_half_away(amount_cents * (100 + percent), 100)


def scale_cents_by_basis_points(amount_cents: int, bps: int) -> int:
    return round_half_away(amount_cents * bps, 10000)


def checked_add(a: int, b: int) -> int:
    r = a + b
    if r > MAX_MONEY_CENTS or r < MIN_MONEY_CENTS:
        raise ContractError("MONEY_OVERFLOW", f"{a} + {b}")
    return r
