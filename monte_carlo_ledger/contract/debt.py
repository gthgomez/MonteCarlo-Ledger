"""Debt / amortization domain for MonteCarlo Contract 2.0 (`debt` 1.0).

Pure and clock-free: the only time input is the scenario's ``as_of``. This module
implements the normative procedure in ``contracts/debt.md`` using integer cents and
``round_half_away`` only (no floating point). It is deliberately independent of the
cash-ledger forecast and of the Monte Carlo simulation: the ``debt`` block is
deterministic for a fixed scenario.
"""

from __future__ import annotations

import calendar
from datetime import date
from typing import Any, Dict, List, Set

from .money import MAX_MONEY_CENTS, ContractError, round_half_away

STRATEGIES = ("snowball", "avalanche")
_KINDS = ("installment", "revolving")
_REQUIRED_NON_NEGATIVE = ("balance_cents", "apr_basis_points", "min_payment_cents")
_OPTIONAL_NON_NEGATIVE = ("min_payment_percent_bps", "min_payment_floor_cents")
_MAX_MONTHS = 360
_APR_DENOMINATOR = 120_000  # apr_basis_points / 10_000 / 12 months
_PERCENT_DENOMINATOR = 10_000


def _add_months(day: date, months: int) -> date:
    """``day`` advanced by ``months`` calendar months, clamped to the target month's last day."""
    index = day.year * 12 + (day.month - 1) + months
    year, month = divmod(index, 12)
    month += 1
    last = calendar.monthrange(year, month)[1]
    return date(year, month, min(day.day, last))


def validate_liabilities(liabilities: Any) -> None:
    """Reject a malformed ``liabilities`` array with ``SCHEMA_INVALID`` (contracts/debt.md).

    Enforces unique ``id``, a known ``kind``, and non-negative ``balance_cents`` /
    ``apr_basis_points`` / ``min_payment_cents`` / ``min_payment_percent_bps`` /
    ``min_payment_floor_cents``. The last two default to ``0`` when omitted.
    """
    if not isinstance(liabilities, list):
        raise ContractError("SCHEMA_INVALID", "liabilities must be an array")
    seen: Set[str] = set()
    for index, liability in enumerate(liabilities):
        if not isinstance(liability, dict):
            raise ContractError("SCHEMA_INVALID", f"liability[{index}] must be an object")
        lid = liability.get("id")
        if not isinstance(lid, str):
            raise ContractError("SCHEMA_INVALID", f"liability[{index}] id must be a string")
        if lid in seen:
            raise ContractError("SCHEMA_INVALID", f"duplicate liability id {lid!r}")
        seen.add(lid)
        kind = liability.get("kind", "installment")
        if kind not in _KINDS:
            raise ContractError("SCHEMA_INVALID", f"liability {lid!r} kind {kind!r}")
        for field in _REQUIRED_NON_NEGATIVE:
            value = liability.get(field)
            if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                raise ContractError(
                    "SCHEMA_INVALID", f"liability {lid!r} {field} must be an integer >= 0"
                )
        for field in _OPTIONAL_NON_NEGATIVE:
            if field in liability:
                value = liability[field]
                if not isinstance(value, int) or isinstance(value, bool) or value < 0:
                    raise ContractError(
                        "SCHEMA_INVALID", f"liability {lid!r} {field} must be an integer >= 0"
                    )


def _monthly_interest(balance: int, apr_basis_points: int) -> int:
    return round_half_away(balance * apr_basis_points, _APR_DENOMINATOR)


def _minimum_payment(liability: Dict[str, Any], balance_after_interest: int) -> int:
    if balance_after_interest <= 0:
        return 0
    if liability.get("kind", "installment") != "revolving":
        return min(liability["min_payment_cents"], balance_after_interest)
    percent = round_half_away(
        balance_after_interest * liability.get("min_payment_percent_bps", 0), _PERCENT_DENOMINATOR
    )
    floor = liability.get("min_payment_floor_cents", 0)
    return min(max(percent, floor), balance_after_interest)


def amortize(
    as_of: date,
    liabilities: List[Dict[str, Any]],
    strategy: str,
    extra_monthly_payment_cents: int,
) -> Dict[str, Any]:
    """Return the ``debt`` block of ``result.schema.json`` for ``liabilities``.

    Implements the normative loop of ``contracts/debt.md``: per month, liabilities with a
    positive balance are visited in ``snowball`` (balance ascending) or ``avalanche``
    (APR descending) order, interest is rounded and added before the minimum payment (which
    is capped at the post-interest balance), then the extra pool is folded into the same
    month's rows in that same order. The loop stops at payoff, at the 360-month cap, or when
    the interest guard overflows ``MAX_MONEY_CENTS``.
    """
    if strategy not in STRATEGIES:
        raise ContractError("SCHEMA_INVALID", f"unknown debt strategy {strategy!r}")
    validate_liabilities(liabilities)

    balances: Dict[str, int] = {
        liability["id"]: liability["balance_cents"] for liability in liabilities
    }
    months = 0
    total_interest = 0
    total_paid = 0
    schedule: List[Dict[str, Any]] = []
    overflowed = False

    while (
        months < _MAX_MONTHS
        and any(balance > 0 for balance in balances.values())
        and not overflowed
    ):
        months += 1
        month_date = _add_months(as_of, months)

        # (a) target order: active liabilities, stable-sorted; array order breaks ties.
        active = [liability for liability in liabilities if balances[liability["id"]] > 0]
        if strategy == "snowball":
            order = sorted(active, key=lambda liability: balances[liability["id"]])
        else:
            order = sorted(
                active, key=lambda liability: liability["apr_basis_points"], reverse=True
            )

        extra_pool = extra_monthly_payment_cents
        month_rows: Dict[str, Dict[str, Any]] = {}

        # (b) interest before payment; the `else` runs only if no overflow interrupted the loop.
        for liability in order:
            lid = liability["id"]
            interest = _monthly_interest(balances[lid], liability["apr_basis_points"])
            if interest > MAX_MONEY_CENTS - balances[lid]:
                overflowed = True
                break
            starting = balances[lid]
            balances[lid] += interest
            total_interest += interest
            payment = _minimum_payment(liability, balances[lid])
            balances[lid] -= payment
            total_paid += payment
            row = {
                "month": months,
                "date": month_date.isoformat(),
                "liability_id": lid,
                "starting_balance_cents": starting,
                "payment_cents": payment,
                "interest_cents": interest,
                "principal_cents": payment - interest,
                "ending_balance_cents": balances[lid],
            }
            schedule.append(row)
            month_rows[lid] = row
        else:
            # (c) fold the extra pool into this month's rows, in the same order.
            for liability in order:
                if extra_pool <= 0:
                    break
                lid = liability["id"]
                if balances[lid] <= 0:
                    continue
                extra = min(extra_pool, balances[lid])
                balances[lid] -= extra
                extra_pool -= extra
                total_paid += extra
                row = month_rows[lid]
                row["payment_cents"] += extra
                row["principal_cents"] += extra
                row["ending_balance_cents"] = balances[lid]

    did_not_converge = overflowed or any(balance > 0 for balance in balances.values())
    return {
        "strategy": strategy,
        "extra_monthly_payment_cents": extra_monthly_payment_cents,
        "months_to_payoff": months,
        "payoff_date": _add_months(as_of, months).isoformat(),
        "total_interest_cents": total_interest,
        "total_paid_cents": total_paid,
        "did_not_converge": did_not_converge,
        "schedule": schedule,
    }
