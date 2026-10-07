"""Regression tests for the native-engine bugs B-02, B-03 and B-04.

The interactive/CLI/API surfaces no longer use the native ``risk`` /
``timeline_service`` engines, but those deprecated shims are fixed in place so
they cannot silently re-introduce a different convention than the contract.
"""

from __future__ import annotations

from datetime import date, timedelta

from monte_carlo_ledger import db_manager, risk, timeline_service
from monte_carlo_ledger.contract import nearest_rank, scale_cents_by_percent
from monte_carlo_ledger.monte_carlo_config import MonteCarloConfig


class _FixedRng:
    """Deterministic stand-in for ``random.Random``."""

    def __init__(self, value: int):
        self._value = value

    def randint(self, a: int, b: int) -> int:
        return self._value

    def random(self) -> float:
        return 0.0


def test_b02_income_variation_uses_contract_rounding():
    # MCD-0007: 101 cents at -8% -> round_half_away(101*92, 100) = 93.
    # The old floor-division path produced 101 + (-808 // 100) = 92.
    config = MonteCarloConfig(runs=1, seed=1, surprise_probability=0.0)
    base = [{"date": "2026-10-05", "name": "Pay", "type": "income",
             "priority": 0, "amount": 101}]
    scenario = risk.generate_scenario_timeline(
        base, _FixedRng(-8), config, as_of=date(2026, 10, 1)
    )
    pay = next(e for e in scenario if e["name"] == "Pay")
    assert pay["amount"] == 93
    assert pay["amount"] == scale_cents_by_percent(101, -8)
    assert pay["amount"] != 92


def test_b04_median_is_nearest_rank_lower_middle():
    # MCD-0005: P50 is nearest-rank; for even N it is the lower middle element,
    # never the floored average of the two middle elements.
    assert risk._median([0, 10]) == 0  # a floored average would be 5
    assert risk._median([1, 2, 3, 4]) == 2
    assert risk._median([1, 2, 3]) == 2
    assert risk._median([]) == 0
    assert risk._median([5, 100]) == nearest_rank([5, 100], 1, 2)


def test_b03_expected_amount_applies_to_first_in_window_payday(tmp_path, monkeypatch):
    # MCD-0017: expected_amount applies to the first occurrence at or after the
    # window start, even when earlier generated paydays fall before it.
    monkeypatch.setattr(db_manager, "DB_PATH", str(tmp_path / "ledger.db"))
    db_manager.init_db()

    start = date(2026, 10, 15)
    last = start - timedelta(days=21)  # next payday lands 14 days before start
    db_manager.add_income_source("Job", 100000, "Weekly", last.isoformat())
    source = db_manager.get_all_income()[0]
    db_manager.update_income_source(
        source.id, source.name, source.amount, source.frequency,
        source.last_payday, source.next_payday, 80000,
    )

    events = timeline_service.generate_income_events(
        start.isoformat(), (start + timedelta(days=30)).isoformat()
    )
    assert len(events) >= 2
    # Old behavior dropped the override (first event would be 100000).
    assert events[0]["amount"] == 80000
    assert events[1]["amount"] == 100000
    assert sum(1 for e in events if e["amount"] == 80000) == 1


def test_b01_simulation_requires_explicit_as_of():
    config = MonteCarloConfig(runs=1, seed=1)
    timeline = [{"date": "2026-10-05", "name": "Pay", "type": "income",
                 "priority": 0, "amount": 100000}]
    # as_of is a required keyword: the engine cannot fall back to a wall clock.
    try:
        risk.run_monte_carlo(100000, timeline, config)  # type: ignore[call-arg]
    except TypeError:
        pass
    else:  # pragma: no cover - defensive
        raise AssertionError("run_monte_carlo accepted a missing as_of")
