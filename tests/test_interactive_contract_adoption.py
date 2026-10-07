"""Interactive adoption: dashboards/workflows must source numbers from the contract.

These tests fail if a dashboard reaches for the legacy ``forecasting`` / ``risk`` /
``timeline_service`` engines, and prove the displayed values equal the contract
engine's output (MCD-0008, MCD-0004, MCD-0001).
"""

from __future__ import annotations

from datetime import date

import pytest

from monte_carlo_ledger import dashboards, db_manager, decisions, workflow_reporting
from monte_carlo_ledger.ui import format_currency

AS_OF = "2026-10-01"
AS_OF_DATE = date(2026, 10, 1)


@pytest.fixture
def seeded(tmp_path, monkeypatch):
    monkeypatch.setattr(db_manager, "DB_PATH", str(tmp_path / "ledger.db"))
    db_manager.init_db()
    db_manager.add_transaction(
        amount_cents=100000, category="System", description="start", t_type="Adjustment"
    )
    db_manager.add_income_source("Paycheck", 90000, "Bi-weekly", "2026-09-26")
    db_manager.add_payment("Rent", 95000, "Monthly", 15)
    return db_manager


@pytest.fixture(autouse=True)
def _no_screen_clear(monkeypatch):
    monkeypatch.setattr(dashboards, "clear_screen", lambda: None)


def test_dashboards_expose_no_legacy_engine_attributes():
    for name in (
        "build_financial_timeline",
        "run_monte_carlo",
        "calculate_safe_spend",
        "calculate_daily_safe_spend",
        "build_balance_forecast",
        "calculate_forecast_summary",
    ):
        assert not hasattr(dashboards, name), f"dashboards still exposes {name}"


def test_forecast_dashboard_delegates_to_decision_layer(seeded, monkeypatch):
    calls = {}

    def fake_detail(as_of, horizon_days):
        calls["as_of"] = as_of
        calls["horizon"] = horizon_days
        return {"forecast": {
            "minimum_balance_cents": 0,
            "minimum_balance_date": as_of,
            "ending_balance_cents": 0,
            "first_negative_date": None,
        }, "rows": []}

    monkeypatch.setattr(dashboards.decisions, "forecast_detail", fake_detail)
    dashboards.render_forecast_dashboard(45, as_of=AS_OF_DATE)
    assert calls == {"as_of": AS_OF, "horizon": 45}


def test_risk_dashboard_delegates_to_decision_layer(seeded, monkeypatch):
    calls = {}

    def fake_risk(as_of, horizon_days, sim):
        calls["as_of"] = as_of
        calls["horizon"] = horizon_days
        calls["sim"] = sim
        return {
            "forecast": {
                "minimum_balance_cents": 0,
                "minimum_balance_date": as_of,
                "ending_balance_cents": 0,
                "first_negative_date": None,
            },
            "risk": {
                "negative_balance_probability_ppm": 0,
                "minimum_balance_p10_cents": 0,
                "minimum_balance_p50_cents": 0,
                "ending_balance_p50_cents": 0,
                "ending_balance_p10_cents": 0,
                "safe_to_spend_cents": 0,
            },
        }

    monkeypatch.setattr(dashboards.decisions, "risk", fake_risk)
    dashboards.render_monte_carlo_dashboard(30, runs=123, as_of=AS_OF_DATE)
    assert calls["as_of"] == AS_OF
    assert calls["horizon"] == 30
    assert calls["sim"]["runs"] == 123


def test_timeline_dashboard_delegates_to_decision_layer(seeded, monkeypatch):
    calls = {}

    def fake_detail(as_of, horizon_days):
        calls["as_of"] = as_of
        calls["horizon"] = horizon_days
        return {"forecast": {
            "minimum_balance_cents": 0,
            "minimum_balance_date": as_of,
            "ending_balance_cents": 0,
            "first_negative_date": None,
        }, "rows": []}

    monkeypatch.setattr(dashboards.decisions, "forecast_detail", fake_detail)
    dashboards.render_timeline_dashboard(as_of=AS_OF_DATE)
    assert calls == {"as_of": AS_OF, "horizon": 30}


def test_forecast_dashboard_prints_contract_numbers(seeded, capsys):
    expected = decisions.forecast_detail(AS_OF, 90)["forecast"]
    dashboards.render_forecast_dashboard(90, as_of=AS_OF_DATE)
    out = capsys.readouterr().out
    assert format_currency(expected["ending_balance_cents"]) in out
    assert format_currency(expected["minimum_balance_cents"]) in out
    assert format_currency(db_manager.get_stored_balance()) in out


def test_risk_dashboard_prints_contract_numbers(seeded, capsys):
    result = decisions.risk(AS_OF, 90, {"runs": 200, "seed": 42})
    dashboards.render_monte_carlo_dashboard(90, runs=200, as_of=AS_OF_DATE)
    out = capsys.readouterr().out
    prob = result["risk"]["negative_balance_probability_ppm"] / 10_000.0
    assert f"{prob:.2f}%" in out
    assert format_currency(result["risk"]["minimum_balance_p10_cents"]) in out
    assert format_currency(result["risk"]["safe_to_spend_cents"]) in out
    assert format_currency(result["forecast"]["minimum_balance_cents"]) in out


def test_timeline_dashboard_labels_low_point_not_safe_to_spend(seeded, capsys):
    result = decisions.forecast(AS_OF, 30)["forecast"]
    dashboards.render_timeline_dashboard(as_of=AS_OF_DATE)
    out = capsys.readouterr().out
    assert "PROJECTED LOW POINT" in out
    # MCD-0008: the deterministic low point must never be labeled "safe to spend".
    assert "FREE TO SPEND" not in out
    assert format_currency(result["minimum_balance_cents"]) in out


def test_forecast_detail_rows_agree_with_contract_forecast(seeded):
    detail = decisions.forecast_detail(AS_OF, 90)
    assert detail["forecast"] == decisions.forecast(AS_OF, 90)["forecast"]
    rows = detail["rows"]
    assert rows, "expected at least one in-window event"
    assert rows[-1]["balance_after_cents"] == detail["forecast"]["ending_balance_cents"]


def test_handle_forecast_threads_as_of(monkeypatch):
    seen = {}

    def fake_render(*, as_of):
        seen["as_of"] = as_of

    monkeypatch.setattr(workflow_reporting, "render_forecast_dashboard", fake_render)
    monkeypatch.setattr("builtins.input", lambda *args: "")
    workflow_reporting.handle_forecast(as_of=AS_OF_DATE)
    assert seen["as_of"] == AS_OF_DATE


def test_handle_risk_outlook_threads_as_of(monkeypatch):
    seen = {}

    def fake_render(*, as_of):
        seen["as_of"] = as_of

    monkeypatch.setattr(workflow_reporting, "render_monte_carlo_dashboard", fake_render)
    monkeypatch.setattr("builtins.input", lambda *args: "")
    workflow_reporting.handle_risk_outlook(as_of=AS_OF_DATE)
    assert seen["as_of"] == AS_OF_DATE


def test_view_upcoming_30_uses_explicit_as_of(seeded, monkeypatch):
    captured = {}

    def fake_schedule(payments, start_date, end_date):
        captured["start"] = start_date
        captured["end"] = end_date
        return []

    monkeypatch.setattr(
        workflow_reporting.budget_engine, "get_upcoming_schedule", fake_schedule
    )
    workflow_reporting.view_upcoming_30(as_of=AS_OF_DATE)
    assert captured == {"start": "2026-10-01", "end": "2026-10-31"}
