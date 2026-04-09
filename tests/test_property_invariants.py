import calendar
from datetime import date, datetime, timedelta

from hypothesis import given, settings, strategies as st

import budget_engine


@given(st.integers(min_value=-1_000_000, max_value=1_000_000))
@settings(max_examples=100)
def test_parse_money_input_round_trips_cents(cents: int):
    dollars = cents / 100
    text = f"{dollars:.2f}"
    assert budget_engine.parse_money_input(text) == cents


@given(
    recurrence=st.sampled_from(["Weekly", "Bi-weekly"]),
    due_date=st.dates(min_value=date(2025, 1, 1), max_value=date(2027, 12, 31)),
    start_offset=st.integers(min_value=-30, max_value=30),
    duration=st.integers(min_value=1, max_value=120),
)
@settings(max_examples=100)
def test_recurring_schedule_is_sorted_and_step_consistent(
    recurrence: str, due_date: date, start_offset: int, duration: int
):
    start_date = due_date + timedelta(days=start_offset)
    end_date = start_date + timedelta(days=duration)

    payments = [
        {
            "id": 1,
            "name": "Recurring",
            "amount": 1000,
            "recurrence": recurrence,
            "due_date": due_date.strftime("%Y-%m-%d"),
        }
    ]

    schedule = budget_engine.get_upcoming_schedule(
        payments,
        start_date.strftime("%Y-%m-%d"),
        end_date.strftime("%Y-%m-%d"),
    )

    dates = [datetime.strptime(item["date"], "%Y-%m-%d").date() for item in schedule]
    assert dates == sorted(dates)
    assert all(start_date <= event_date <= end_date for event_date in dates)

    expected_step = 7 if recurrence == "Weekly" else 14
    deltas = [
        (later - earlier).days
        for earlier, later in zip(dates, dates[1:])
    ]
    assert all(delta == expected_step for delta in deltas)


@given(
    due_day=st.integers(min_value=1, max_value=31),
    start_date=st.dates(min_value=date(2025, 1, 1), max_value=date(2026, 12, 31)),
    duration=st.integers(min_value=30, max_value=365),
)
@settings(max_examples=100)
def test_monthly_schedule_snaps_to_valid_month_days(
    due_day: int, start_date: date, duration: int
):
    end_date = start_date + timedelta(days=duration)
    payments = [
        {
            "id": 1,
            "name": "Monthly",
            "amount": 2000,
            "recurrence": "Monthly",
            "due_day": due_day,
        }
    ]

    schedule = budget_engine.get_upcoming_schedule(
        payments,
        start_date.strftime("%Y-%m-%d"),
        end_date.strftime("%Y-%m-%d"),
    )

    for item in schedule:
        event_date = datetime.strptime(item["date"], "%Y-%m-%d").date()
        last_day = calendar.monthrange(event_date.year, event_date.month)[1]
        assert event_date.day == min(due_day, last_day)
        assert start_date <= event_date <= end_date
