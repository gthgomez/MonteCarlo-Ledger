"""MC-04/MC-05 adoption: DB -> canonical scenario -> decision layer -> CLI/API."""

from __future__ import annotations

import json

import pytest

from monte_carlo_ledger import commands, db_manager, decisions, scenario
from monte_carlo_ledger.contract import run_scenario

AS_OF = "2026-10-01"


@pytest.fixture
def seeded(tmp_path, monkeypatch):
    monkeypatch.setattr(db_manager, "DB_PATH", str(tmp_path / "ledger.db"))
    db_manager.init_db()
    db_manager.add_transaction(
        amount_cents=100000, category="System", description="start", t_type="Adjustment"
    )
    # Bi-weekly paycheck: last 2026-09-26 -> next 2026-10-10
    db_manager.add_income_source("Paycheck", 90000, "Bi-weekly", "2026-09-26")
    # Monthly rent due on the 15th
    db_manager.add_payment("Rent", 95000, "Monthly", 15)
    return db_manager


def test_scenario_is_explicit_and_deterministic(seeded):
    first = scenario.build_scenario(AS_OF, 90, read_only=True)
    second = scenario.build_scenario(AS_OF, 90, read_only=True)
    assert first == second
    assert first["as_of"] == AS_OF
    assert first["starting_balance_cents"] == 100000
    # in-window events present, all within [as_of, as_of+90)
    assert first["events"], "expected income and/or bills"
    assert all(AS_OF <= e["date"] < "2026-12-30" for e in first["events"])


def test_forecast_matches_contract_directly(seeded):
    assert decisions.forecast(AS_OF, 90) == run_scenario(
        scenario.build_scenario(AS_OF, 90, read_only=True)
    )


def test_simulate_purchase_increases_risk(seeded):
    result = decisions.simulate_purchase(50000, "2026-10-05", AS_OF, 90)
    baseline = result["baseline"]["risk"]
    with_purchase = result["with_purchase"]["risk"]
    assert with_purchase["minimum_balance_p10_cents"] <= baseline["minimum_balance_p10_cents"]
    assert result["change"]["minimum_balance_p10_cents"] <= 0


def test_paycheck_delay_is_deterministic_and_worse_or_equal(seeded):
    first = decisions.simulate_paycheck_delay(5, AS_OF, 90)
    second = decisions.simulate_paycheck_delay(5, AS_OF, 90)
    assert first == second
    assert (
        first["delayed"]["risk"]["minimum_balance_p10_cents"]
        <= first["baseline"]["risk"]["minimum_balance_p10_cents"]
    )


def test_cli_forecast_json(seeded, capsys):
    rc = commands.main(["forecast", "--as-of", AS_OF, "--horizon", "90", "--json"])
    assert rc == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload == decisions.forecast(AS_OF, 90)


def test_cli_safe_to_spend_json(seeded, capsys):
    rc = commands.main(["safe-to-spend", "--as-of", AS_OF, "--json"])
    assert rc == 0
    payload = json.loads(capsys.readouterr().out)
    risk = payload["risk"]
    assert risk["safe_to_spend_cents"] == risk["minimum_balance_p10_cents"] - 0
    assert "projected_low_point_cents" in risk
