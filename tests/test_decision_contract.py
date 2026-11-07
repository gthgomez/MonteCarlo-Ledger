"""MCP-ready decision contract: provenance, typed inputs, bounds, consistency."""

from __future__ import annotations

import pytest

from monte_carlo_ledger import db_manager, decisions
from monte_carlo_ledger.contract import ContractError

AS_OF = "2026-10-01"

REQUIRED_PROVENANCE = {
    "source",
    "contract_version",
    "read_only",
    "hypothetical",
    "balance_consistent",
    "ledger_balance_cents",
    "stored_balance_cents",
    "cached_balance_cents",
    "bank_balance_cents",
    "reconciled_with_bank",
    "snapshot",
    "model",
}


@pytest.fixture()
def seeded(tmp_path, monkeypatch):
    monkeypatch.setattr(db_manager, "DB_PATH", str(tmp_path / "ledger.db"))
    db_manager.init_db()
    db_manager.add_transaction(
        500_000, "System", "Opening", t_type="Adjustment", date_str="2026-09-01"
    )
    db_manager.add_income_source("Pay", 220_000, "Bi-weekly", "2026-09-25")
    db_manager.add_payment("Rent", 135_000, "Monthly", 1)
    return db_manager.DB_PATH


def _db_dump():
    with db_manager.get_db_connection() as conn:
        out = {}
        for table, cols in {
            "income": "*",
            "payments": "*",
            "transactions": "*",
            "bill_occurrences": "*",
            "settings": "*",
        }.items():
            out[table] = [
                dict(r) for r in conn.execute(f"SELECT {cols} FROM {table} ORDER BY 1")
            ]
        return out


def _operations():
    liability = {
        "id": "l1",
        "name": "Card",
        "balance_cents": 100_000,
        "apr_basis_points": 1999,
        "min_payment_cents": 5000,
    }
    return {
        "forecast": lambda: decisions.forecast(AS_OF),
        "risk": lambda: decisions.risk(AS_OF, sim={"runs": 50, "seed": 7}),
        "purchase": lambda: decisions.simulate_purchase(
            65_000, "2026-10-05", AS_OF, sim={"runs": 50, "seed": 7}
        ),
        "delay": lambda: decisions.simulate_paycheck_delay(
            3, AS_OF, sim={"runs": 50, "seed": 7}
        ),
        "compare": lambda: decisions.compare_scenarios(
            [], [], AS_OF, sim={"runs": 50, "seed": 7}
        ),
        "debt": lambda: decisions.compare_debt_strategies([liability], AS_OF),
        "overdraft": lambda: decisions.overdraft_risk(
            AS_OF, sim={"runs": 50, "seed": 7}
        ),
    }


def test_every_operation_exposes_complete_provenance(seeded):
    for name, operation in _operations().items():
        result = operation()
        ledger = result["ledger"]
        assert REQUIRED_PROVENANCE <= set(ledger), name
        assert ledger["as_of"] == AS_OF, name
        assert ledger["read_only"] is True, name
        assert ledger["contract_version"] == "2.0", name
        assert isinstance(ledger["snapshot"], dict), name
        assert "basis" in ledger["model"], name


def test_risk_and_purchase_provenance_record_the_simulation(seeded):
    risk = decisions.risk(AS_OF, sim={"runs": 37, "seed": 11})
    assert risk["ledger"]["simulation"] == {"runs": 37, "seed": 11}

    purchase = decisions.simulate_purchase(
        10_000, "2026-10-05", AS_OF, sim={"runs": 37, "seed": 11}
    )
    assert purchase["ledger"]["simulation"] == {"runs": 37, "seed": 11}
    assert purchase["ledger"]["hypothetical"] is True


def test_financial_snapshot_describes_its_source(seeded):
    snapshot = decisions.financial_snapshot()
    assert snapshot["contract_version"] == "2.0"
    assert snapshot["read_only"] is True
    assert snapshot["hypothetical"] is False
    assert snapshot["cached_balance_cents"] == snapshot["stored_balance_cents"]


def test_decision_operations_never_mutate_the_ledger(seeded):
    before = _db_dump()
    for name, operation in _operations().items():
        operation()
        assert _db_dump() == before, f"{name} mutated persisted state"


def test_each_operation_reads_one_consistent_view(seeded, monkeypatch):
    calls = []
    real = db_manager.read_ledger_view

    def counting(start, end):
        calls.append((start, end))
        return real(start, end)

    monkeypatch.setattr(db_manager, "read_ledger_view", counting)
    for name, operation in _operations().items():
        calls.clear()
        operation()
        assert len(calls) == 1, f"{name} opened {len(calls)} ledger views"


def test_financial_snapshot_uses_one_metadata_transaction(seeded, monkeypatch):
    real = db_manager.read_ledger_metadata
    calls = []

    def metadata_then_concurrent_write():
        meta = real()
        calls.append(meta["ledger_balance_cents"])
        db_manager.add_transaction(
            -1234, "Food", "Concurrent", t_type="Expense", date_str="2026-09-30"
        )
        return meta

    monkeypatch.setattr(db_manager, "read_ledger_metadata", metadata_then_concurrent_write)
    snapshot = decisions.financial_snapshot()

    assert calls == [500_000]
    assert snapshot["ledger_balance_cents"] == 500_000
    assert snapshot["balance_consistent"] is True
    assert snapshot["counts"]["transactions"] == 1
    assert db_manager.get_ledger_balance() == 498_766


def test_calculation_and_provenance_share_one_snapshot(seeded, monkeypatch):
    baseline = decisions.forecast(AS_OF)
    real = db_manager.read_ledger_view
    captured = {}

    def snapshot_then_concurrent_write(start, end):
        view = real(start, end)
        captured["balance"] = view["ledger_balance_cents"]
        # Another writer edits the ledger after the decision's read snapshot.
        db_manager.add_transaction(
            -1234, "Food", "Concurrent", t_type="Expense", date_str="2026-09-30"
        )
        return view

    monkeypatch.setattr(db_manager, "read_ledger_view", snapshot_then_concurrent_write)
    result = decisions.forecast(AS_OF)

    assert captured["balance"] == 500_000
    # Neither the calculation nor its provenance absorbed the later write.
    assert result["forecast"] == baseline["forecast"]
    assert result["ledger"]["ledger_balance_cents"] == 500_000
    assert result["ledger"]["balance_consistent"] is True
    assert db_manager.get_ledger_balance() == 498_766


# --- compare_scenarios typed input ----------------------------------------


def _valid_event(**overrides):
    event = {
        "date": "2026-10-05",
        "amount_cents": -65_000,
        "type": "expense",
        "name": "New sofa",
    }
    event.update(overrides)
    return event


def test_compare_scenarios_rejects_a_dictionary_container(seeded):
    with pytest.raises(ContractError) as ctx:
        decisions.compare_scenarios(
            {"date": "2026-10-05", "amount_cents": -100, "type": "expense"},
            [],
            AS_OF,
        )
    assert ctx.value.code == "SCHEMA_INVALID"


@pytest.mark.parametrize(
    "bad_event,code",
    [
        (_valid_event(date="not-a-date"), "INVALID_DATE"),
        (_valid_event(date="2026-12-31"), "EVENT_OUT_OF_HORIZON"),
        (_valid_event(date="2026-09-01"), "EVENT_OUT_OF_HORIZON"),
        (_valid_event(amount_cents=100), "INVALID_AMOUNT"),
        (_valid_event(amount_cents=0, type="adjustment"), "INVALID_AMOUNT"),
        (_valid_event(type="refund"), "INVALID_EVENT_TYPE"),
        (_valid_event(amount_cents=2**63), "MONEY_OVERFLOW"),
        (_valid_event(surprise_field=1), "SCHEMA_INVALID"),
        (_valid_event(name=123), "SCHEMA_INVALID"),
    ],
)
def test_compare_scenarios_rejects_malformed_events(seeded, bad_event, code):
    with pytest.raises(ContractError) as ctx:
        decisions.compare_scenarios([bad_event], [], AS_OF)
    assert ctx.value.code == code


def test_compare_scenarios_rejects_an_exact_duplicate_event(seeded):
    event = _valid_event()
    with pytest.raises(ContractError) as ctx:
        decisions.compare_scenarios([event, dict(event)], [], AS_OF)
    assert ctx.value.code == "SCHEMA_INVALID"
    assert "duplicates" in str(ctx.value)


def test_compare_scenarios_accepts_valid_typed_events(seeded):
    result = decisions.compare_scenarios(
        [_valid_event()],
        [],
        AS_OF,
        sim={"runs": 50, "seed": 3},
    )
    assert result["first"]["risk"]["minimum_balance_p10_cents"] <= result["second"]["risk"][
        "minimum_balance_p10_cents"
    ]
    assert result["ledger"]["hypothetical"] is True


# --- central execution bounds --------------------------------------------


@pytest.mark.parametrize(
    "kwargs,code",
    [
        ({"sim": {"runs": 0}}, "INVALID_RUNS"),
        ({"sim": {"runs": decisions.MAX_RUNS + 1}}, "INVALID_RUNS"),
        ({"sim": {"seed": -1}}, "INVALID_SEED"),
        ({"sim": {"quantile_num": 0}}, "INVALID_QUANTILE"),
        ({"sim": {"quantile_num": 11, "quantile_den": 10}}, "INVALID_QUANTILE"),
        ({"sim": {"reserve_cents": decisions.MAX_RESERVE_CENTS + 1}}, "INVALID_AMOUNT"),
    ],
)
def test_risk_rejects_out_of_bounds_simulation(seeded, kwargs, code):
    with pytest.raises(ContractError) as ctx:
        decisions.risk(AS_OF, **kwargs)
    assert ctx.value.code == code


def test_horizon_out_of_bounds_is_rejected(seeded):
    with pytest.raises(ContractError) as ctx:
        decisions.forecast(AS_OF, decisions.MAX_HORIZON_DAYS + 1)
    assert ctx.value.code == "INVALID_HORIZON"


def test_purchase_amount_out_of_bounds_is_rejected(seeded):
    with pytest.raises(ContractError) as ctx:
        decisions.simulate_purchase(decisions.MAX_AMOUNT_CENTS + 1, "2026-10-05", AS_OF)
    assert ctx.value.code == "INVALID_AMOUNT"
