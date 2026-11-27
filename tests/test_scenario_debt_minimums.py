from datetime import date
from types import SimpleNamespace
import pytest

from monte_carlo_ledger import db_manager, sync
from monte_carlo_ledger.contract import run_scenario
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


@pytest.mark.parametrize(("recurrence", "due_info"), [("Weekly", "2027-01-15"), ("One-time", None)])
def test_cannot_edit_a_linked_bill_to_an_incompatible_schedule(tmp_path, monkeypatch, recurrence, due_info):
    _restore(tmp_path, monkeypatch, _snapshot())
    payment = db_manager.get_all_payments()[0]

    with pytest.raises(ValueError, match="dated monthly or one-time"):
        db_manager.update_payment(payment.id, "Changed bill", payment.amount, recurrence, due_info)

    assert db_manager.get_all_payments() == [payment]
    exported = sync.export_ledger_snapshot()
    assert next(row for row in exported["liabilities"] if row["id"] == "loan")["linked_payment_id"] == "external-payment"
    db_manager.update_payment(payment.id, "Renamed bill", payment.amount, "Monthly", 29)
    assert sync.export_ledger_snapshot()["payments"][0]["name"] == "Renamed bill"


@pytest.mark.parametrize(("has_exact_slot", "expected_date"), [
    (False, "2027-01-20"),
    (True, "2027-01-25"),
])
def test_linked_monthly_slot_prefers_exact_date_then_oldest_original(
    tmp_path, monkeypatch, has_exact_slot, expected_date,
):
    snapshot = _snapshot()
    payment = snapshot["payments"][0]
    payment["amount_cents"] = 2_000
    snapshot["payments"].append(dict(payment, id="unlinked-lookalike"))
    slots = [
        (1, "external-payment", "2027-01-08", "2027-01-10"),
        (2, "external-payment", "2027-01-05", "2027-01-20"),
        (3, "unlinked-lookalike", "2027-01-01", "2027-01-03"),
    ]
    if has_exact_slot:
        slots.append((4, "external-payment", "2027-01-15", "2027-01-25"))
    snapshot["bill_occurrences"] = [
        {
            "id": occurrence_id, "payment_id": payment_id, "original_due_date": original,
            "due_date": due, "is_user_modified": True, "paid": False,
        }
        for occurrence_id, payment_id, original, due in slots
    ]
    _restore(tmp_path, monkeypatch, snapshot)

    assert [event for event in _cash_events(horizon=31) if event[1] == "Debt"] == [
        (expected_date, "Debt", -1_000),
    ]


@pytest.mark.parametrize(
    ("paid", "moved_to", "expected"),
    [
        (False, "2027-01-22", [("2027-01-22", "Scheduled payment", -3_000)]),
        (False, "2027-02-22", [("2027-02-22", "Scheduled payment", -3_000)]),
        (False, "2027-01-15", [("2027-01-20", "Scheduled payment", -3_000)]),
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
    assert _cash_events("2027-01-20", 40) == sorted(
        expected + [("2027-02-15", "Debt", -3_000)], key=lambda row: (row[0], row[1])
    )


@pytest.mark.parametrize(
    ("original", "moved", "horizon"),
    [
        ("2027-01-15", "2027-01-22", 25),
        ("2027-02-15", "2027-01-12", 14),
    ],
)
def test_moved_unpaid_bill_and_debt_shortfall_share_cash_date(tmp_path, monkeypatch, original, moved, horizon):
    snapshot = _snapshot()
    snapshot["payments"][0].update(
        recurrence="One-time", due_day=None, due_date=original, amount_cents=2_000
    )
    snapshot["liabilities"][0]["due_day_of_month"] = 28
    snapshot["bill_occurrences"] = [{
        "id": 1,
        "payment_id": "external-payment",
        "original_due_date": original,
        "due_date": moved,
        "paid": False,
        "is_user_modified": True,
    }]
    _restore(tmp_path, monkeypatch, snapshot)

    assert _cash_events(horizon=horizon) == [(moved, "Debt", -1_000), (moved, "Scheduled payment", -2_000)]
    assert _cash_events(horizon=date.fromisoformat(moved).day - 1) == []


def test_far_future_linked_bill_moved_early_includes_shortfall_without_future_interest(tmp_path, monkeypatch):
    snapshot = _snapshot()
    snapshot["current_balance_cents"] = 50_000
    snapshot["transactions"][0].update(date="2026-11-01", amount_cents=50_000)
    snapshot["payments"][0].update(
        recurrence="One-time", due_day=None, due_date="2027-01-15", amount_cents=20_000
    )
    snapshot["liabilities"][0].update(
        kind="revolving", balance_cents=60_000, apr_basis_points=1_200,
        min_payment_cents=0, min_payment_percent_bps=5_000, due_day_of_month=29,
    )
    snapshot["bill_occurrences"] = [{
        "id": 1, "payment_id": "external-payment", "original_due_date": "2027-01-15",
        "due_date": "2026-11-16", "is_user_modified": True, "paid": False,
    }]
    _restore(tmp_path, monkeypatch, snapshot)

    assert _cash_events("2026-11-10", 6) == []
    assert _cash_events("2026-11-10", 10) == [
        ("2026-11-16", "Debt", -10_000),
        ("2026-11-16", "Scheduled payment", -20_000),
    ]
    forecast = run_scenario(build_scenario("2026-11-10", 10, read_only=True))["forecast"]
    assert (forecast["minimum_balance_cents"], forecast["ending_balance_cents"]) == (20_000, 20_000)
    # The early slot consumes principal before the ordinary November minimum.
    assert _cash_events("2026-11-10", 20)[-1] == ("2026-11-29", "Debt", -15_000)


def test_prior_month_moved_shortfall_carries_principal_without_backdated_interest(tmp_path, monkeypatch):
    snapshot = _snapshot()
    snapshot["current_balance_cents"] = 25_000
    snapshot["transactions"][0].update(date="2026-11-01", amount_cents=25_000)
    snapshot["incomes"] = [{
        "id": "paycheck", "name": "Paycheck", "amount_cents": 40_000, "frequency": "One-time",
        "last_payday": "2026-11-13", "next_payday": "2026-11-13",
    }]
    snapshot["payments"][0].update(name="Card bill", amount_cents=20_000, due_day=29)
    snapshot["bill_occurrences"] = [{
        "id": "october", "payment_id": "external-payment", "original_due_date": "2026-10-29",
        "due_date": "2026-11-16", "is_user_modified": True, "paid": False,
    }]
    snapshot["liabilities"][0].update(
        name="Card", balance_cents=55_000, min_payment_cents=30_000,
        apr_basis_points=1_200, due_day_of_month=29,
    )
    _restore(tmp_path, monkeypatch, snapshot)

    as_of = "2026-11-10"
    expected = [
        ("2026-11-13", "Paycheck", 40_000),
        ("2026-11-16", "Card", -10_000),
        ("2026-11-16", "Card bill", -20_000),
    ]
    assert _cash_events(as_of, 10) == expected
    assert _cash_events(as_of, 20) == expected + [
        ("2026-11-29", "Card", -5_000),
        ("2026-11-29", "Card bill", -20_000),
    ]
    short = run_scenario(build_scenario(as_of, 10, read_only=True))["forecast"]
    full = run_scenario(build_scenario(as_of, 20, read_only=True))["forecast"]
    assert (short["minimum_balance_cents"], short["ending_balance_cents"]) == (25_000, 35_000)
    assert full["ending_balance_cents"] == 10_000


def test_only_unpaid_moved_cycles_use_opening_principal_in_cash_date_order():
    debt = _liability(id="card", name="Card", balance=55_000, minimum=30_000, due_day=29)
    debt.update(linked_payment_id=1, apr_basis_points=1_200)
    payment = SimpleNamespace(id=1, name="Card bill", amount=20_000, recurrence="Monthly", due_day=29)
    occurrences = [
        {
            "payment_id": 1, "original_due_date": original, "due_date": due,
            "paid": paid, "is_user_modified": original != due,
        }
        for original, due, paid in [
            ("2026-10-29", "2026-11-16", False),
            ("2026-09-29", "2026-11-19", False),
            ("2026-08-29", "2026-11-12", True),
            ("2026-07-29", "2026-07-29", False),
        ]
    ]

    events = _liability_min_payment_events(
        [debt], [payment], date(2026, 11, 10), date(2026, 11, 30), occurrences,
    )

    assert [(event["date"], event["amount_cents"]) for event in events] == [
        ("2026-11-16", -10_000),  # October pays first, taking $300 of the $550 opening principal.
        ("2026-11-19", -5_000),   # September's $250 minimum has $50 left after its bill.
    ]


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
        ("2027-01-20", "Debt", -1_000),
        ("2027-02-15", "Debt", -1_000),
        ("2027-02-15", "Scheduled payment", -2_000),
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


def test_linked_leap_year_slot_keeps_anchor_after_february(tmp_path, monkeypatch):
    snapshot = _snapshot()
    snapshot["payments"][0]["due_day"] = 31
    snapshot["liabilities"][0]["due_day_of_month"] = 31
    _restore(tmp_path, monkeypatch, snapshot)
    assert _cash_events("2028-02-01", 65) == [
        ("2028-02-29", "Scheduled payment", -3_000),
        ("2028-03-31", "Scheduled payment", -3_000),
    ]


def test_unlinked_replacement_cannot_inherit_an_old_link_for_same_local_id(tmp_path, monkeypatch):
    first = _snapshot()
    _restore(tmp_path, monkeypatch, first)
    second = _snapshot()
    second["version"] = "2.1"
    second["payments"][0].update(id=1, name="Independent bill")
    del second["liabilities"][0]["linked_payment_id"]
    second["liabilities"].pop()
    sync.restore_ledger_snapshot(second)
    assert _cash_events(horizon=30) == [
        ("2027-01-15", "Debt", -3_000),
        ("2027-01-15", "Independent bill", -3_000),
    ]


def test_linked_bill_covers_minimum_when_liability_due_day_differs(tmp_path, monkeypatch):
    """A linked bill is the debt payment even if the debt's stored due day is stale.

    The hand oracle is $500.00 cash - one $300.00 payment = $200.00 left. Charging
    the bill on the 15th and a second minimum on the debt's stored 20th would
    deduct $600.00 and report -$100.00.
    """
    snapshot = _snapshot()
    snapshot["current_balance_cents"] = 50_000
    snapshot["transactions"][0]["amount_cents"] = 50_000
    snapshot["payments"][0]["amount_cents"] = 30_000
    snapshot["liabilities"][0]["due_day_of_month"] = 20
    snapshot["liabilities"][0]["min_payment_cents"] = 30_000
    snapshot["liabilities"][0]["balance_cents"] = 100_000
    _restore(tmp_path, monkeypatch, snapshot)

    events = _cash_events("2026-12-01", 20)
    assert events == [("2026-12-15", "Scheduled payment", -30_000)]
    scenario = build_scenario("2026-12-01", 20, include_simulation={
        "runs": 10,
        "seed": 42,
        "quantile_num": 1,
        "quantile_den": 10,
        "income_variation_min": 0,
        "income_variation_max": 0,
        "expense_variation_min": 0,
        "expense_variation_max": 0,
        "surprise_probability_ppm": 0,
        "surprise_amount_min": 0,
        "surprise_amount_max": 0,
        "surprise_check_interval_days": 14,
        "reserve_cents": 0,
    }, read_only=True)
    assert run_scenario(scenario)["risk"]["safe_to_spend_cents"] == 20_000


def test_linked_bill_due_after_liability_slot_also_charges_once(tmp_path, monkeypatch):
    snapshot = _snapshot()
    snapshot["payments"][0]["due_day"] = 20
    snapshot["liabilities"][0]["due_day_of_month"] = 15
    _restore(tmp_path, monkeypatch, snapshot)
    assert _cash_events("2026-12-01", 25) == [
        ("2026-12-20", "Scheduled payment", -3_000),
    ]
