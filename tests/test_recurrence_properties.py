"""Property tests for canonical recurrence anchoring (MCD-0022)."""

import calendar
from datetime import date, timedelta

from hypothesis import given, settings, strategies as st

from monte_carlo_ledger.contract import recurrence_dates


def _first_of_month_n_months_later(start: date, months: int) -> date:
    year = start.year + (start.month - 1 + months) // 12
    month = (start.month - 1 + months) % 12 + 1
    return date(year, month, 1)


@settings(max_examples=300, deadline=None)
@given(
    anchor=st.integers(min_value=1, max_value=31),
    year=st.integers(min_value=2020, max_value=2030),
    month=st.integers(min_value=1, max_value=12),
    count=st.integers(min_value=1, max_value=24),
)
def test_monthly_occurrences_never_drift_from_the_anchor(anchor, year, month, count):
    start = date(year, month, 1)
    ceiling = _first_of_month_n_months_later(start, count)
    dates = recurrence_dates(
        {"frequency": "monthly", "start_date": start.isoformat(), "anchor_day": anchor},
        ceiling,
    )
    assert len(dates) == count
    for occurrence in dates:
        last_day = calendar.monthrange(occurrence.year, occurrence.month)[1]
        assert occurrence.day == min(anchor, last_day)


@settings(max_examples=100, deadline=None)
@given(
    start=st.dates(min_value=date(2020, 1, 1), max_value=date(2030, 12, 31)),
    steps=st.integers(min_value=1, max_value=40),
)
def test_weekly_occurrences_are_exact_seven_day_steps(start, steps):
    ceiling = start + timedelta(days=7 * steps)
    dates = recurrence_dates(
        {"frequency": "weekly", "start_date": start.isoformat()}, ceiling
    )
    assert len(dates) == steps
    for index, occurrence in enumerate(dates):
        assert (occurrence - start).days == 7 * index


@settings(max_examples=100, deadline=None)
@given(
    start=st.dates(min_value=date(2020, 1, 1), max_value=date(2030, 12, 31)),
    steps=st.integers(min_value=1, max_value=40),
)
def test_biweekly_occurrences_are_exact_fourteen_day_steps(start, steps):
    ceiling = start + timedelta(days=14 * steps)
    dates = recurrence_dates(
        {"frequency": "biweekly", "start_date": start.isoformat()}, ceiling
    )
    assert len(dates) == steps
    for index, occurrence in enumerate(dates):
        assert (occurrence - start).days == 14 * index
