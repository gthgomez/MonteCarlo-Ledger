from datetime import date
from types import SimpleNamespace

from monte_carlo_ledger.scenario import _liability_min_payment_events


def _liability(
    *, id: str, name: str, balance: int, minimum: int, due_day: int = 15
) -> dict:
    return {
        "id": id,
        "name": name,
        "balance_cents": balance,
        "apr_basis_points": 0,
        "min_payment_cents": minimum,
        "kind": "installment",
        "due_day_of_month": due_day,
    }


def test_installment_minimums_reduce_balance_and_cap_final_payment() -> None:
    events = _liability_min_payment_events(
        [_liability(id="loan", name="Small Loan", balance=8_000, minimum=3_000)],
        [],
        date(2027, 1, 1),
        date(2027, 4, 1),
    )

    assert [(event["date"], event["amount_cents"]) for event in events] == [
        ("2027-01-15", -3_000),
        ("2027-02-15", -3_000),
        ("2027-03-15", -2_000),
    ]


def test_overdue_current_month_minimum_is_due_on_the_as_of_date() -> None:
    events = _liability_min_payment_events(
        [_liability(id="loan", name="Small Loan", balance=5_000, minimum=3_000, due_day=10)],
        [],
        date(2027, 1, 20),
        date(2027, 2, 20),
    )

    assert [(event["date"], event["amount_cents"]) for event in events] == [
        ("2027-01-20", -3_000),
        ("2027-02-10", -2_000),
    ]


def test_revolving_minimums_include_monthly_interest_before_future_due_dates() -> None:
    debt = _liability(
        id="card", name="Card", balance=100_000, minimum=0, due_day=10
    )
    debt.update(
        apr_basis_points=12_000,
        kind="revolving",
        min_payment_percent_bps=1_000,
        min_payment_floor_cents=0,
    )

    events = _liability_min_payment_events(
        [debt], [], date(2027, 1, 1), date(2027, 4, 1)
    )

    assert [(event["date"], event["amount_cents"]) for event in events] == [
        ("2027-01-10", -10_000),
        ("2027-02-10", -9_900),
        ("2027-03-10", -9_801),
    ]


def test_matching_monthly_bill_covers_the_debt_for_the_forecast_window() -> None:
    payment = SimpleNamespace(
        name="Small Loan", amount=3_000, recurrence="Monthly", due_day=15
    )
    events = _liability_min_payment_events(
        [_liability(id="loan", name="Small Loan", balance=8_000, minimum=3_000)],
        [payment],
        date(2027, 1, 1),
        date(2027, 4, 1),
    )

    assert events == []


def test_same_day_debt_events_use_stable_id_order() -> None:
    debts = [
        _liability(id="debt-z", name="Z Loan", balance=100_000, minimum=12_000),
        _liability(id="debt-a", name="A Loan", balance=100_000, minimum=8_000),
    ]

    forward = _liability_min_payment_events(
        debts, [], date(2026, 11, 1), date(2026, 12, 1)
    )
    reversed_events = _liability_min_payment_events(
        list(reversed(debts)), [], date(2026, 11, 1), date(2026, 12, 1)
    )

    assert [event["name"] for event in forward] == ["A Loan", "Z Loan"]
    assert reversed_events == forward


def test_unicode_case_matching_matches_web_lowercase_behavior() -> None:
    payment = SimpleNamespace(
        name="STRASSE", amount=1_000, recurrence="Monthly", due_day=15
    )
    events = _liability_min_payment_events(
        [_liability(id="loan", name="Straße", balance=8_000, minimum=1_000)],
        [payment],
        date(2027, 1, 1),
        date(2027, 2, 1),
    )

    assert [(event["name"], event["amount_cents"]) for event in events] == [
        ("Straße", -1_000)
    ]
