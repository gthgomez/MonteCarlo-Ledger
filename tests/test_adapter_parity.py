"""Shared persisted-ledger adapter corpus (Python side).

The same fixture is consumed by the TypeScript adapter test. Both start from the
persisted household records, build a canonical scenario with their normal adapter,
and must reach the same canonical conclusion. This closes the gap between "the pure
engines agree on JSON fixtures" and "the real data-to-contract pipelines agree".
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from monte_carlo_ledger import db_manager, decisions, sync

FIXTURE = Path(__file__).resolve().parents[1] / "testdata" / "adapters" / "synthetic-household.json"


def _fixture():
    return json.loads(FIXTURE.read_text())


@pytest.fixture()
def restored(tmp_path, monkeypatch):
    data = _fixture()
    monkeypatch.setattr(db_manager, "DB_PATH", str(tmp_path / "ledger.db"))
    db_manager.init_db()
    sync.restore_ledger_snapshot(json.loads(json.dumps(data["ledger"])))
    return data


def test_persisted_household_reaches_the_shared_canonical_result(restored):
    result = decisions.risk(
        restored["as_of"],
        restored["horizon_days"],
        dict(restored["simulation"]),
    )
    assert result["forecast"] == restored["expected"]["forecast"]
    assert result["risk"] == restored["expected"]["risk"]
    # Provenance is part of the adapter contract, not an optional extra.
    assert result["ledger"]["read_only"] is True
    assert result["ledger"]["as_of"] == restored["as_of"]
    assert result["ledger"]["simulation"] == {
        "runs": restored["simulation"]["runs"],
        "seed": restored["simulation"]["seed"],
    }


def _run_ledger(ledger, data, tmp_path, monkeypatch):
    monkeypatch.setattr(db_manager, "DB_PATH", str(tmp_path / "mutant.db"))
    db_manager.init_db()
    sync.restore_ledger_snapshot(json.loads(json.dumps(ledger)))
    return decisions.risk(
        data["as_of"], data["horizon_days"], dict(data["simulation"])
    )


@pytest.mark.parametrize(
    "mutate",
    [
        pytest.param(
            lambda ledger: ledger["incomes"][0].__setitem__("last_payday", "2026-01-28"),
            id="wrong-monthly-anchor",
        ),
        pytest.param(
            lambda ledger: ledger["incomes"][0].pop("expected_amount"),
            id="missing-expected-amount-override",
        ),
        pytest.param(
            lambda ledger: ledger["bill_occurrences"][0].__setitem__("paid", False),
            id="missing-paid-bill-exclusion",
        ),
        pytest.param(
            lambda ledger: ledger.__setitem__("current_balance_cents", -20001),
            id="one-cent-balance-drift",
        ),
    ],
)
def test_corpus_detects_an_adapter_divergence(mutate, tmp_path, monkeypatch):
    """Negative controls: a deliberately wrong adapter must fail the parity assertion."""
    data = _fixture()
    mutant = json.loads(json.dumps(data["ledger"]))
    mutate(mutant)
    # Keep the snapshot internally consistent where the mutation only changes one cent.
    if mutant["current_balance_cents"] != data["ledger"]["current_balance_cents"]:
        delta = mutant["current_balance_cents"] - data["ledger"]["current_balance_cents"]
        mutant["transactions"][-1]["amount_cents"] += delta
    result = _run_ledger(mutant, data, tmp_path, monkeypatch)
    assert result["forecast"] != data["expected"]["forecast"], "corpus must detect this fault"


def test_liabilities_are_an_explicit_compatibility_error_not_silent_loss(tmp_path, monkeypatch):
    data = _fixture()
    data["ledger"]["liabilities"] = [
        {
            "id": "card-1",
            "name": "Card",
            "balance_cents": 1000,
            "apr_basis_points": 1999,
            "min_payment_cents": 100,
        }
    ]
    monkeypatch.setattr(db_manager, "DB_PATH", str(tmp_path / "ledger.db"))
    db_manager.init_db()
    with pytest.raises(ValueError, match="cannot persist"):
        sync.restore_ledger_snapshot(data["ledger"])
