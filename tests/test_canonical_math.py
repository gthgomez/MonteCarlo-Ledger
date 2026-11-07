"""Canonical monetary boundaries, overflow, simulation validation and scenario truth."""

from __future__ import annotations

from datetime import date

import pytest

from monte_carlo_ledger import decisions, scenario
from monte_carlo_ledger.contract import run_scenario
from monte_carlo_ledger.contract.money import (
    MAX_MONEY_CENTS,
    ContractError,
    round_half_away,
    scale_cents_by_percent,
)
from monte_carlo_ledger.contract.debt import amortize

AS_OF = "2026-11-01"


def _scenario(**kw):
    base = {
        "contract_version": "2.0",
        "as_of": AS_OF,
        "starting_balance_cents": 100_000,
        "horizon_days": 30,
        "events": [],
    }
    base.update(kw)
    return base


# --------------------------------------------------------------------------
# Strict monetary inputs
# --------------------------------------------------------------------------


@pytest.mark.parametrize("value", [123, -123])
def test_exact_integer_starting_balance_is_accepted(value):
    result = run_scenario(_scenario(starting_balance_cents=value))
    assert result["forecast"]["ending_balance_cents"] == value


@pytest.mark.parametrize("value", [123.99, 123.0, "123", True, False, None, [], {}])
def test_coerced_starting_balance_is_rejected(value):
    with pytest.raises(ContractError) as ctx:
        run_scenario(_scenario(starting_balance_cents=value))
    assert ctx.value.code == "INVALID_AMOUNT"


@pytest.mark.parametrize("value", [1 << 63, -(1 << 63)])
def test_out_of_range_starting_balance_is_money_overflow(value):
    with pytest.raises(ContractError) as ctx:
        run_scenario(_scenario(starting_balance_cents=value))
    assert ctx.value.code == "MONEY_OVERFLOW"


@pytest.mark.parametrize("value", [1.5, "100", True, None])
def test_event_amount_must_be_an_exact_integer(value):
    with pytest.raises(ContractError) as ctx:
        run_scenario(
            _scenario(events=[{"date": AS_OF, "amount_cents": value, "type": "income"}])
        )
    assert ctx.value.code in ("INVALID_AMOUNT", "MONEY_OVERFLOW")


def test_event_outside_signed_range_is_money_overflow():
    with pytest.raises(ContractError) as ctx:
        run_scenario(
            _scenario(events=[{"date": AS_OF, "amount_cents": 1 << 63, "type": "income"}])
        )
    assert ctx.value.code == "MONEY_OVERFLOW"


# --------------------------------------------------------------------------
# Overflow on results
# --------------------------------------------------------------------------


def test_safe_to_spend_below_signed_range_raises_money_overflow():
    with pytest.raises(ContractError) as ctx:
        run_scenario(
            _scenario(
                starting_balance_cents=-MAX_MONEY_CENTS,
                simulation={"runs": 1, "seed": 1, "reserve_cents": 1},
            )
        )
    assert ctx.value.code == "MONEY_OVERFLOW"


def test_scale_overflow_is_rejected():
    with pytest.raises(ContractError) as ctx:
        scale_cents_by_percent(MAX_MONEY_CENTS, 100)
    assert ctx.value.code == "MONEY_OVERFLOW"


def test_debt_aggregate_overflow_is_rejected():
    liabilities = [
        {"id": "a", "name": "A", "balance_cents": MAX_MONEY_CENTS, "apr_basis_points": 0,
         "min_payment_cents": MAX_MONEY_CENTS, "kind": "installment"},
        {"id": "b", "name": "B", "balance_cents": MAX_MONEY_CENTS, "apr_basis_points": 0,
         "min_payment_cents": MAX_MONEY_CENTS, "kind": "installment"},
    ]
    with pytest.raises(ContractError) as ctx:
        run_scenario(_scenario(liabilities=liabilities))
    assert ctx.value.code == "MONEY_OVERFLOW"


# --------------------------------------------------------------------------
# Simulation parameter validation
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "simulation,code",
    [
        ({"runs": 0}, "INVALID_RUNS"),
        ({"runs": 100_001}, "INVALID_RUNS"),
        ({"runs": 1.5}, "INVALID_RUNS"),
        ({"runs": True}, "INVALID_RUNS"),
        ({"seed": -1}, "INVALID_SEED"),
        ({"seed": 1 << 64}, "INVALID_SEED"),
        ({"seed": "1"}, "INVALID_SEED"),
        ({"income_variation_min": 10, "income_variation_max": -10}, "INVALID_AMOUNT"),
        ({"expense_variation_min": 5, "expense_variation_max": 1}, "INVALID_AMOUNT"),
        ({"surprise_probability_ppm": 1_000_001}, "INVALID_AMOUNT"),
        ({"surprise_probability_ppm": -1}, "INVALID_AMOUNT"),
        ({"surprise_check_interval_days": 0}, "INVALID_HORIZON"),
        ({"surprise_amount_min": 100, "surprise_amount_max": 50}, "INVALID_AMOUNT"),
        ({"quantile_num": 0}, "INVALID_QUANTILE"),
        ({"quantile_num": 11, "quantile_den": 10}, "INVALID_QUANTILE"),
        ({"quantile_den": 0}, "INVALID_QUANTILE"),
        ({"reserve_cents": -1}, "INVALID_AMOUNT"),
        ({"reserve_cents": MAX_MONEY_CENTS + 1}, "INVALID_AMOUNT"),
        ({"unknown_option": 1}, "SCHEMA_INVALID"),
        ({"expense_category_variation": [
            {"category": "food", "min": 0, "max": 1},
            {"category": "food", "min": 0, "max": 2},
        ]}, "SCHEMA_INVALID"),
        ({"expense_category_variation": [
            {"category": "food", "min": 5, "max": 1},
        ]}, "SCHEMA_INVALID"),
    ],
)
def test_invalid_simulation_parameters_are_typed_errors(simulation, code):
    with pytest.raises(ContractError) as ctx:
        run_scenario(_scenario(simulation=simulation))
    assert ctx.value.code == code


def test_zero_surprise_probability_and_single_run_are_valid():
    result = run_scenario(
        _scenario(
            starting_balance_cents=-100,
            simulation={
                "runs": 1,
                "seed": 0,
                "surprise_probability_ppm": 0,
                "quantile_num": 1,
                "quantile_den": 1,
            },
        )
    )
    assert result["risk"]["negative_balance_probability_ppm"] == 1_000_000
    assert result["risk"]["safe_to_spend_cents"] == -100


# --------------------------------------------------------------------------
# Purchase horizon
# --------------------------------------------------------------------------


@pytest.fixture
def ledger(tmp_path, monkeypatch):
    from monte_carlo_ledger import db_manager

    monkeypatch.setattr(db_manager, "DB_PATH", str(tmp_path / "ledger.db"))
    db_manager.init_db()
    db_manager.add_transaction(
        100_000, "Opening", "open", t_type="Adjustment", date_str="2026-10-01"
    )
    return db_manager


@pytest.mark.parametrize("purchase_date", ["2026-10-31", "2026-12-01", "2027-01-01"])
def test_purchase_outside_the_window_is_rejected(ledger, purchase_date):
    with pytest.raises(ContractError) as ctx:
        decisions.simulate_purchase(1_000, purchase_date, AS_OF, 30, {"runs": 5, "seed": 1})
    assert ctx.value.code == "EVENT_OUT_OF_HORIZON"


def test_purchase_inside_the_window_is_modeled(ledger):
    result = decisions.simulate_purchase(
        1_000, "2026-11-10", AS_OF, 30, {"runs": 5, "seed": 1}
    )
    assert result["with_purchase"]["forecast"]["ending_balance_cents"] == 99_000
    assert result["baseline"]["forecast"]["ending_balance_cents"] == 100_000


# --------------------------------------------------------------------------
# Paycheck selection
# --------------------------------------------------------------------------


def test_paycheck_delay_selects_the_earliest_date_not_insertion_order():
    scenario_dict = {
        "events": [
            {"date": "2026-11-20", "type": "income", "amount_cents": 100},
            {"date": "2026-11-10", "type": "income", "amount_cents": 200},
        ]
    }
    decisions._shift_first_income(scenario_dict, 3)
    assert scenario_dict["events"][0]["date"] == "2026-11-20"
    assert scenario_dict["events"][1]["date"] == "2026-11-13"


def test_same_day_incomes_use_scenario_order_as_tie_break():
    scenario_dict = {
        "events": [
            {"date": "2026-11-10", "type": "income", "amount_cents": 100},
            {"date": "2026-11-10", "type": "income", "amount_cents": 200},
        ]
    }
    decisions._shift_first_income(scenario_dict, 2)
    assert scenario_dict["events"][0]["date"] == "2026-11-12"
    assert scenario_dict["events"][1]["date"] == "2026-11-10"


def test_paycheck_delay_rejects_zero_and_no_income(ledger):
    with pytest.raises(ContractError) as ctx:
        decisions.simulate_paycheck_delay(0, AS_OF, 30, {"runs": 5, "seed": 1})
    assert ctx.value.code == "INVALID_HORIZON"
    with pytest.raises(ContractError) as ctx:
        decisions.simulate_paycheck_delay(3, AS_OF, 30, {"runs": 5, "seed": 1})
    assert ctx.value.code == "NO_INCOME"


# --------------------------------------------------------------------------
# Independent debt reference calculator
# --------------------------------------------------------------------------


def _reference_amortize(balance: int, apr_bps: int, minimum: int, max_months: int = 360):
    rows = []
    total_interest = 0
    total_paid = 0
    month = 0
    while balance > 0 and month < max_months:
        month += 1
        interest = round_half_away(balance * apr_bps, 120_000)
        after_interest = balance + interest
        payment = min(minimum, after_interest)
        ending = after_interest - payment
        rows.append(
            {
                "month": month,
                "starting_balance_cents": balance,
                "interest_cents": interest,
                "payment_cents": payment,
                "principal_cents": payment - interest,
                "ending_balance_cents": ending,
            }
        )
        total_interest += interest
        total_paid += payment
        balance = ending
    return rows, total_interest, total_paid, balance


@pytest.mark.parametrize(
    "balance,apr,minimum",
    [
        (100_000, 1_200, 10_000),
        (250_000, 2_199, 6_500),
        (1_000_000, 0, 100_000),
        (333_333, 1_999, 33_333),
    ],
)
def test_debt_matches_an_independent_reference(balance, apr, minimum):
    liability = {
        "id": "x", "name": "X", "balance_cents": balance,
        "apr_basis_points": apr, "min_payment_cents": minimum,
        "kind": "installment",
    }
    result = amortize(date(2026, 11, 1), [liability], "snowball", 0)
    rows, total_i, total_p, remaining = _reference_amortize(balance, apr, minimum)
    assert result["total_interest_cents"] == total_i
    assert result["total_paid_cents"] == total_p
    assert result["months_to_payoff"] == len(rows)
    assert result["did_not_converge"] is (remaining > 0)
    for expected, actual in zip(rows, result["schedule"]):
        for key, value in expected.items():
            assert actual[key] == value


def test_revolving_without_percent_or_floor_is_flagged_not_silently_healthy():
    liability = {
        "id": "card", "name": "Card", "balance_cents": 100_000,
        "apr_basis_points": 1_800, "min_payment_cents": 5_000, "kind": "revolving",
    }
    result = amortize(date(2026, 11, 1), [liability], "snowball", 0)
    assert result["did_not_converge"] is True
    assert result["months_to_payoff"] == 360


def test_debt_comparison_surfaces_zero_minimum_warning(ledger):
    liabilities = [{
        "id": "card", "name": "Card", "balance_cents": 100_000,
        "apr_basis_points": 1_800, "min_payment_cents": 5_000, "kind": "revolving",
    }]
    result = decisions.compare_debt_strategies(liabilities, AS_OF)
    assert result["model_warnings"]
    assert "min_payment_percent_bps" in result["model_warnings"][0]


def test_due_day_and_extra_payment_validation():
    liability = {
        "id": "x", "name": "X", "balance_cents": 1000, "apr_basis_points": 0,
        "min_payment_cents": 100, "due_day_of_month": 32,
    }
    with pytest.raises(ContractError) as ctx:
        amortize(date(2026, 11, 1), [liability], "snowball", 0)
    assert ctx.value.code == "SCHEMA_INVALID"
    liability["due_day_of_month"] = 15
    with pytest.raises(ContractError) as ctx:
        amortize(date(2026, 11, 1), [liability], "snowball", -1)
    assert ctx.value.code == "INVALID_AMOUNT"
