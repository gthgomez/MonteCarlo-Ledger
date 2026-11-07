"""Metamorphic / property tests for the canonical contract engine.

These assert relationships that must hold across a whole class of inputs, rather than
pinning individual fixtures. Each property is chosen because it is *actually* implied
by the contract (MCD-0002/0003/0005/0006/0020/0024/0026), not because it sounds
intuitive.
"""

from __future__ import annotations

from datetime import date, timedelta

from hypothesis import given, settings, strategies as st

from monte_carlo_ledger import contract

AS_OF = "2026-11-09"


def _base(as_of: str = AS_OF, horizon: int = 60, start: int = 100_000) -> dict:
    return {
        "contract_version": "2.0",
        "scenario_id": "property",
        "as_of": as_of,
        "starting_balance_cents": start,
        "horizon_days": horizon,
        "events": [],
    }


@given(
    start=st.integers(min_value=-1_000_000, max_value=1_000_000),
    amount=st.integers(min_value=1, max_value=500_000),
    offset=st.integers(min_value=0, max_value=59),
)
@settings(max_examples=60, deadline=None)
def test_adding_an_expense_never_improves_the_projected_trough(start, amount, offset):
    purchase_date = (date.fromisoformat(AS_OF) + timedelta(days=offset)).isoformat()
    baseline = contract.run_scenario(_base(start=start))
    scenario = _base(start=start)
    scenario["events"].append(
        {"date": purchase_date, "amount_cents": -amount, "type": "expense", "name": "x"}
    )
    worse = contract.run_scenario(scenario)

    assert worse["forecast"]["minimum_balance_cents"] <= baseline["forecast"]["minimum_balance_cents"]
    assert (
        worse["forecast"]["ending_balance_cents"]
        == baseline["forecast"]["ending_balance_cents"] - amount
    )


@given(seed=st.integers(min_value=0, max_value=2**63 - 1))
@settings(max_examples=25, deadline=None)
def test_a_seeded_scenario_replays_exactly(seed):
    scenario = _base(start=250_000)
    scenario["events"] = [
        {"date": "2026-11-15", "amount_cents": 220_000, "type": "income", "name": "Pay"},
        {"date": "2026-11-20", "amount_cents": -135_000, "type": "expense", "name": "Rent"},
    ]
    scenario["simulation"] = {
        "runs": 150,
        "seed": seed,
        "income_variation_min": -8,
        "income_variation_max": 8,
        "expense_variation_min": -5,
        "expense_variation_max": 5,
    }
    assert contract.run_scenario(scenario) == contract.run_scenario(scenario)


@given(
    rows=st.lists(
        st.tuples(
            st.integers(min_value=0, max_value=59),
            st.sampled_from([(220_000, "income"), (-50_000, "expense")]),
        ),
        min_size=1,
        max_size=6,
        unique_by=lambda row: row[0],
    ),
)
@settings(max_examples=50, deadline=None)
def test_reordering_distinct_date_events_does_not_change_the_result(rows):
    events = [
        {
            "date": (date.fromisoformat(AS_OF) + timedelta(days=day)).isoformat(),
            "amount_cents": amount,
            "type": kind,
            "name": f"e{day}",
        }
        for day, (amount, kind) in rows
    ]
    forward = _base(start=100_000)
    forward["events"] = events
    backward = _base(start=100_000)
    backward["events"] = list(reversed(events))

    assert contract.run_scenario(forward) == contract.run_scenario(backward)


@given(
    balance=st.integers(min_value=1, max_value=10_000_000),
    apr=st.integers(min_value=1, max_value=30_000),
)
@settings(max_examples=40, deadline=None)
def test_zero_percent_debt_never_accumulates_interest(balance, apr):
    scenario = _base()
    scenario["liabilities"] = [
        {
            "id": "card",
            "balance_cents": balance,
            "apr_basis_points": 0,
            "min_payment_cents": max(1, balance // 24),
            "kind": "installment",
        }
    ]
    debt = contract.run_scenario(scenario)["debt"]
    assert debt["total_interest_cents"] == 0
    assert debt["total_paid_cents"] == balance

    # A non-zero APR must never report less interest than the zero-APR case.
    scenario["liabilities"][0]["apr_basis_points"] = apr
    with_interest = contract.run_scenario(scenario)["debt"]
    assert with_interest["total_interest_cents"] >= debt["total_interest_cents"]


@given(
    start_day=st.integers(min_value=1, max_value=28),
    amount=st.integers(min_value=100, max_value=500_000),
)
@settings(max_examples=40, deadline=None)
def test_an_exclusion_removes_exactly_one_occurrence(start_day, amount):
    start = date(2026, 11, start_day)
    scenario = _base(as_of=start.isoformat(), horizon=90)
    scenario["recurrences"] = [
        {
            "id": "rec",
            "type": "expense",
            "amount_cents": -amount,
            "frequency": "monthly",
            "start_date": start.isoformat(),
        }
    ]
    base_events = contract.ordered_events(scenario)
    assert base_events, "the property assumes at least one occurrence"

    excluded = base_events[0]["date"].isoformat()
    scenario["occurrence_exclusions"] = [{"recurrence_id": "rec", "date": excluded}]
    after = contract.ordered_events(scenario)

    assert len(after) == len(base_events) - 1
    assert all(ev["date"].isoformat() != excluded for ev in after)


def test_overflow_is_detected_not_wrapped():
    scenario = _base(start=contract.MAX_MONEY_CENTS)
    scenario["events"] = [
        {"date": AS_OF, "amount_cents": 1, "type": "income", "name": "overflow"}
    ]
    try:
        contract.run_scenario(scenario)
    except contract.ContractError as exc:
        assert exc.code == "MONEY_OVERFLOW"
    else:  # pragma: no cover - the assertion below is the point
        raise AssertionError("overflow must raise MONEY_OVERFLOW, never wrap")
