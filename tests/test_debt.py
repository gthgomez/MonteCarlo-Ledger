"""Contract 2.0 debt/amortization domain (``debt`` 1.0).

Covers the normative procedure in ``contracts/debt.md`` and the engine/result wiring:
payoff math, minimum-payment legs, snowball/avalanche ordering, the extra pool, the
360-month cap, the overflow guard, validation, and the "debt iff liabilities" rule.
"""

from __future__ import annotations

from datetime import date

import pytest

from monte_carlo_ledger.contract import (
    MAX_MONEY_CENTS,
    ContractError,
    amortize,
    run_scenario,
    validate_liabilities,
)

AS_OF = date(2026, 1, 15)


def _loan(**overrides):
    base = {"id": "loan", "balance_cents": 500000, "apr_basis_points": 0, "min_payment_cents": 100000}
    base.update(overrides)
    return base


def _scenario(**overrides):
    base = {
        "contract_version": "2.0",
        "scenario_id": "s",
        "as_of": AS_OF.isoformat(),
        "starting_balance_cents": 0,
        "horizon_days": 30,
        "events": [],
    }
    base.update(overrides)
    return base


def test_installment_payoff_zero_apr():
    result = amortize(AS_OF, [_loan()], "snowball", 0)

    assert result["strategy"] == "snowball"
    assert result["extra_monthly_payment_cents"] == 0
    assert result["months_to_payoff"] == 5
    assert result["payoff_date"] == "2026-06-15"
    assert result["total_interest_cents"] == 0
    assert result["total_paid_cents"] == 500000
    assert result["did_not_converge"] is False

    assert result["schedule"][0] == {
        "month": 1,
        "date": "2026-02-15",
        "liability_id": "loan",
        "starting_balance_cents": 500000,
        "payment_cents": 100000,
        "interest_cents": 0,
        "principal_cents": 100000,
        "ending_balance_cents": 400000,
    }
    assert result["schedule"][-1]["month"] == 5
    assert result["schedule"][-1]["date"] == "2026-06-15"
    assert result["schedule"][-1]["ending_balance_cents"] == 0
    # Invariant: starting == ending + principal on every row.
    for row in result["schedule"]:
        assert row["starting_balance_cents"] == row["ending_balance_cents"] + row["principal_cents"]


def test_revolving_percent_minimum():
    # Percent leg: 100% of the post-interest balance pays the debt in one month.
    percent = amortize(
        AS_OF,
        [{
            "id": "card", "balance_cents": 100000, "apr_basis_points": 0, "min_payment_cents": 0,
            "kind": "revolving", "min_payment_percent_bps": 10000, "min_payment_floor_cents": 0,
        }],
        "snowball",
        0,
    )
    assert percent["months_to_payoff"] == 1
    assert percent["schedule"][0]["payment_cents"] == 100000
    assert percent["total_paid_cents"] == 100000

    # The percent leg uses min_payment_percent_bps, not min_payment_cents.
    percent_leg = amortize(
        AS_OF,
        [{
            "id": "card", "balance_cents": 100000, "apr_basis_points": 0, "min_payment_cents": 999999,
            "kind": "revolving", "min_payment_percent_bps": 500, "min_payment_floor_cents": 0,
        }],
        "snowball",
        0,
    )
    assert percent_leg["schedule"][0]["payment_cents"] == 5000  # 5% of 100000

    # Floor leg: the flat floor dominates the (smaller) percent and clears the balance.
    floor = amortize(
        AS_OF,
        [{
            "id": "card", "balance_cents": 100000, "apr_basis_points": 0, "min_payment_cents": 0,
            "kind": "revolving", "min_payment_percent_bps": 200, "min_payment_floor_cents": 2500,
        }],
        "snowball",
        0,
    )
    assert floor["schedule"][0]["payment_cents"] == 2500
    assert floor["months_to_payoff"] == 40
    assert floor["schedule"][-1]["ending_balance_cents"] == 0
    assert floor["total_paid_cents"] == 100000


def _two_liabilities():
    return [
        {"id": "big", "balance_cents": 500000, "apr_basis_points": 2400, "min_payment_cents": 10000},
        {"id": "small", "balance_cents": 100000, "apr_basis_points": 1200, "min_payment_cents": 10000},
    ]


def test_snowball_order_and_extra_targets_smallest_balance():
    result = amortize(AS_OF, _two_liabilities(), "snowball", 50000)
    # Snowball: ascending balance -> "small" first, so the extra pool hits it for this month.
    assert [row["liability_id"] for row in result["schedule"][:2]] == ["small", "big"]
    small, big = result["schedule"][0], result["schedule"][1]
    assert small["payment_cents"] == 60000  # 10000 minimum + 50000 extra
    assert small["principal_cents"] == 59000  # (10000 - 1000 interest) + 50000
    assert small["ending_balance_cents"] == 41000
    assert big["payment_cents"] == 10000
    assert big["ending_balance_cents"] == 500000


def test_avalanche_order_and_extra_targets_highest_apr():
    result = amortize(AS_OF, _two_liabilities(), "avalanche", 50000)
    # Avalanche: descending APR -> "big" first, so the extra pool hits it for this month.
    assert [row["liability_id"] for row in result["schedule"][:2]] == ["big", "small"]
    big, small = result["schedule"][0], result["schedule"][1]
    assert big["payment_cents"] == 60000
    assert big["principal_cents"] == 50000  # (10000 - 10000 interest) + 50000
    assert big["ending_balance_cents"] == 450000
    assert small["payment_cents"] == 10000
    assert small["ending_balance_cents"] == 91000


def test_extra_payment_reduces_interest_and_months():
    debt = [{"id": "x", "balance_cents": 1000000, "apr_basis_points": 1800, "min_payment_cents": 50000}]
    without = amortize(AS_OF, debt, "snowball", 0)
    with_extra = amortize(AS_OF, debt, "snowball", 50000)

    assert with_extra["months_to_payoff"] < without["months_to_payoff"]
    assert with_extra["total_interest_cents"] < without["total_interest_cents"]
    # The extra applied to the only debt is folded into its monthly row, not a new row.
    assert len(with_extra["schedule"]) == with_extra["months_to_payoff"]
    assert with_extra["schedule"][0]["payment_cents"] == 50000 + 50000


def test_negative_amortization_runs_to_the_360_month_cap():
    # A 36% APR loan with a zero minimum payment grows every month: it never pays off and
    # never overflows, so it hits the 360-month cap with did_not_converge set.
    result = amortize(
        AS_OF,
        [{"id": "x", "balance_cents": 100000, "apr_basis_points": 3600, "min_payment_cents": 0}],
        "snowball",
        0,
    )
    assert result["months_to_payoff"] == 360
    assert result["did_not_converge"] is True
    assert len(result["schedule"]) == 360
    assert result["total_interest_cents"] > 0
    assert all(row["principal_cents"] < 0 for row in result["schedule"])  # negative amortization


def test_overflow_guard_stops_without_raising():
    # balance near MAX_MONEY_CENTS with any positive APR overflows the interest guard.
    result = amortize(
        AS_OF,
        [
            {"id": "a", "balance_cents": MAX_MONEY_CENTS - 1, "apr_basis_points": 1, "min_payment_cents": 0},
            {"id": "b", "balance_cents": 500000, "apr_basis_points": 0, "min_payment_cents": 100},
        ],
        "snowball",
        1000,
    )
    assert result["months_to_payoff"] == 1
    assert result["did_not_converge"] is True
    # Snowball visits "b" first; the overflow on "a" stops the month cleanly.
    assert [(row["liability_id"], row["ending_balance_cents"]) for row in result["schedule"]] == [
        ("b", 499900)
    ]


def test_duplicate_liability_id_is_schema_invalid():
    duplicates = [_loan(), _loan()]

    with pytest.raises(ContractError) as exc:
        validate_liabilities(duplicates)
    assert exc.value.code == "SCHEMA_INVALID"

    with pytest.raises(ContractError) as exc:
        amortize(AS_OF, duplicates, "snowball", 0)
    assert exc.value.code == "SCHEMA_INVALID"

    with pytest.raises(ContractError) as exc:
        run_scenario(_scenario(liabilities=duplicates))
    assert exc.value.code == "SCHEMA_INVALID"


@pytest.mark.parametrize(
    "bad",
    [
        {"id": "x", "balance_cents": -1, "apr_basis_points": 0, "min_payment_cents": 0},
        {"id": "x", "balance_cents": 0, "apr_basis_points": -1, "min_payment_cents": 0},
        {"id": "x", "balance_cents": 0, "apr_basis_points": 0, "min_payment_cents": -1},
        {"id": "x", "balance_cents": 0, "apr_basis_points": 0, "min_payment_cents": 0,
         "min_payment_percent_bps": -1},
        {"id": "x", "balance_cents": 0, "apr_basis_points": 0, "min_payment_cents": 0,
         "min_payment_floor_cents": -1},
        {"id": "x", "balance_cents": 0, "apr_basis_points": 0, "min_payment_cents": 0, "kind": "charge"},
    ],
)
def test_validation_rejects_negative_fields_and_unknown_kind(bad):
    with pytest.raises(ContractError) as exc:
        validate_liabilities([bad])
    assert exc.value.code == "SCHEMA_INVALID"


def test_unknown_strategy_is_schema_invalid():
    with pytest.raises(ContractError) as exc:
        amortize(AS_OF, [_loan()], "waterfall", 0)
    assert exc.value.code == "SCHEMA_INVALID"


def test_debt_block_present_only_when_liabilities_declared():
    assert "debt" not in run_scenario(_scenario())

    result = run_scenario(_scenario(liabilities=[]))
    assert result["debt"] == {
        "strategy": "snowball",
        "extra_monthly_payment_cents": 0,
        "months_to_payoff": 0,
        "payoff_date": AS_OF.isoformat(),
        "total_interest_cents": 0,
        "total_paid_cents": 0,
        "did_not_converge": False,
        "schedule": [],
    }


def test_debt_block_echoes_strategy_and_extra_and_coexists_with_risk():
    # No simulation: debt is still emitted (deterministic, independent of the cash ledger).
    echoes = run_scenario(
        _scenario(liabilities=[_loan()], debt_strategy="avalanche", extra_monthly_payment_cents=1000)
    )
    assert echoes["debt"]["strategy"] == "avalanche"
    assert echoes["debt"]["extra_monthly_payment_cents"] == 1000
    assert echoes["debt"]["months_to_payoff"] == 5

    # With a simulation both the stochastic risk block and the deterministic debt block appear.
    plain = run_scenario(_scenario(liabilities=[_loan()]))
    both = run_scenario(_scenario(liabilities=[_loan()], simulation={"runs": 2, "seed": 1}))
    assert "risk" in both
    assert "debt" in both
    assert both["debt"] == plain["debt"]  # debt is deterministic; simulation only varies cash


def test_month_end_clamping():
    # as_of on the 31st: months clamp to the target month's last valid day.
    result = amortize(
        date(2026, 1, 31),
        [{"id": "x", "balance_cents": 100, "apr_basis_points": 0, "min_payment_cents": 100}],
        "snowball",
        0,
    )
    assert result["payoff_date"] == "2026-02-28"
    assert result["schedule"][0]["date"] == "2026-02-28"
