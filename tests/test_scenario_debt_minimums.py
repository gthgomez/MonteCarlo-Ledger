from datetime import date
from types import SimpleNamespace
import pytest

from monte_carlo_ledger import db_manager, sync
from monte_carlo_ledger.scenario import _liability_min_payment_events, build_scenario


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


def test_unrelated_identical_monthly_bill_does_not_cover_the_debt() -> None:
    payment = SimpleNamespace(
        id=1, name="Small Loan", amount=3_000, recurrence="Monthly", due_day=15
    )
    events = _liability_min_payment_events(
        [_liability(id="loan", name="Small Loan", balance=8_000, minimum=3_000)],
        [payment],
        date(2027, 1, 1),
        date(2027, 4, 1),
    )

    assert [(event["date"], event["amount_cents"]) for event in events] == [
        ("2027-01-15", -3_000),
        ("2027-02-15", -3_000),
        ("2027-03-15", -2_000),
    ]


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
        id=1, name="STRASSE", amount=1_000, recurrence="Monthly", due_day=15
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


def _snapshot():
    return {
        "version": "2.2",
        "current_balance_cents": 100_000,
        "incomes": [],
        "payments": [{
            "id": "external-payment",
            "name": "Scheduled payment",
            "amount_cents": 3_000,
            "recurrence": "Monthly",
            "due_day": 15,
        }],
        "transactions": [
            {"id": 1, "amount_cents": 100_000, "type": "Adjustment", "date": "2026-12-01"}
        ],
        "bill_occurrences": [],
        "liabilities": [
            dict(
                _liability(id="loan", name="Debt", balance=50_000, minimum=3_000),
                linked_payment_id="external-payment",
            ),
            dict(_liability(id="archived", name="Archived", balance=70_000, minimum=6_000), is_active=False),
        ],
    }


def _restore(tmp_path, monkeypatch, snapshot):
    monkeypatch.setattr(db_manager, "DB_PATH", str(tmp_path / "linked.db"))
    db_manager.init_db()
    sync.restore_ledger_snapshot(snapshot)


def _cash_events(as_of="2027-01-01", horizon=60):
    scenario = build_scenario(as_of, horizon, read_only=True)
    return [(row["date"], row["name"], row["amount_cents"]) for row in scenario["events"]]


def test_link_survives_repeated_restore_and_delete_keeps_debt(tmp_path, monkeypatch):
    _restore(tmp_path, monkeypatch, _snapshot())

    expected = [
        ("2027-01-15", "Scheduled payment", -3_000),
        ("2027-02-15", "Scheduled payment", -3_000),
    ]
    assert _cash_events(horizon=59) == expected
    exported = sync.export_ledger_snapshot()
    assert exported["version"] == "2.2"
    archived, loan = exported["liabilities"]
    assert archived["is_active"] is False
    assert loan["linked_payment_id"] == exported["payments"][0]["id"] == "external-payment"
    for _ in range(2):
        sync.restore_ledger_snapshot(exported)
        assert _cash_events(horizon=59) == expected

    db_manager.delete_payment(db_manager.get_all_payments()[0].id)
    assert _cash_events(horizon=59) == [
        ("2027-01-15", "Debt", -3_000),
        ("2027-02-15", "Debt", -3_000),
    ]


@pytest.mark.parametrize(
    ("paid", "moved_to", "expected"),
    [
        (False, "2027-01-22", [("2027-01-22", "Scheduled payment", -3_000)]),
        (False, "2027-02-22", [("2027-02-22", "Scheduled payment", -3_000)]),
        (False, "2027-01-15", [("2027-01-20", "Debt", -3_000)]),
        (True, "2027-01-15", []),
    ],
)
def test_linked_one_time_occurrence_uses_original_slot(tmp_path, monkeypatch, paid, moved_to, expected):
    snapshot = _snapshot()
    snapshot["payments"][0].update(recurrence="One-time", due_day=None, due_date="2027-01-15")
    snapshot["bill_occurrences"] = [{
        "id": 1,
        "payment_id": "external-payment",
        "original_due_date": "2027-01-15",
        "due_date": moved_to,
        "paid": paid,
        "is_user_modified": moved_to != "2027-01-15",
    }]
    _restore(tmp_path, monkeypatch, snapshot)
    assert _cash_events("2027-01-20", 40) == expected + [("2027-02-15", "Debt", -3_000)]


def test_paid_link_only_covers_recorded_amount_and_preserves_next_minimum(tmp_path, monkeypatch):
    snapshot = _snapshot()
    snapshot["payments"][0]["amount_cents"] = 2_000
    snapshot["liabilities"][0]["balance_cents"] = 4_000
    snapshot["transactions"].append({
        "id": 2, "amount_cents": -2_000, "type": "Expense", "date": "2027-01-15"
    })
    snapshot["current_balance_cents"] -= 2_000
    snapshot["bill_occurrences"] = [{
        "id": 1, "payment_id": "external-payment", "due_date": "2027-01-15",
        "paid": True, "transaction_id": 2,
    }]
    _restore(tmp_path, monkeypatch, snapshot)
    assert _cash_events("2027-01-20", 40) == [
        ("2027-02-15", "Scheduled payment", -2_000),
        ("2027-01-20", "Debt", -1_000),
        ("2027-02-15", "Debt", -1_000),
    ]


@pytest.mark.parametrize("fault", ["version", "duplicate", "dangling", "collision"])
def test_invalid_links_leave_the_existing_database_intact(tmp_path, monkeypatch, fault):
    snapshot = _snapshot()
    _restore(tmp_path, monkeypatch, snapshot)
    before = _cash_events()
    if fault == "version":
        snapshot["version"] = "2.1"
    elif fault == "duplicate":
        snapshot["liabilities"][1]["linked_payment_id"] = "external-payment"
    elif fault == "dangling":
        snapshot["liabilities"][0]["linked_payment_id"] = "unknown"
    else:
        payment = snapshot["payments"][0]
        payment["id"] = 1
        snapshot["payments"].append(dict(payment, id="1"))
    with pytest.raises(ValueError):
        sync.restore_ledger_snapshot(snapshot)
    assert _cash_events() == before
