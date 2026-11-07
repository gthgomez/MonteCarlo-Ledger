"""Incomplete snapshots must never replace a populated ledger.

Regression for the destructive restore defect: ``restore_ledger_snapshot`` used
``snapshot.get(key, [])`` and ``snapshot.get("current_balance_cents", 0)``, so
``{"version": "2.1"}`` passed validation, deleted every row and committed an empty
ledger. Every rejected restore below is checked against the complete persisted
database state, not just the snapshot representation.
"""

from __future__ import annotations

import json

import pytest

from monte_carlo_ledger import db_manager, sync


def _db_state():
    """Every persisted column that influences financial state."""
    with db_manager.get_db_connection() as conn:
        state = {}
        for table, columns in {
            "income": "id, name, amount, frequency, last_payday, next_payday, expected_amount",
            "payments": "id, name, amount, due_day, recurrence, due_date, is_auto_withdraw",
            "transactions": "id, amount, category, type, date, description",
            "bill_occurrences": "id, payment_id, due_date, paid, transaction_id, original_due_date, is_user_modified",
        }.items():
            rows = conn.execute(f"SELECT {columns} FROM {table} ORDER BY id").fetchall()
            state[table] = [dict(row) for row in rows]
        row = conn.execute(
            "SELECT value FROM settings WHERE key = 'current_balance'"
        ).fetchone()
        state["stored_balance"] = row["value"] if row else None
    state["ledger_balance"] = db_manager.get_ledger_balance()
    return state


@pytest.fixture()
def populated_db(tmp_path, monkeypatch):
    db_path = tmp_path / "ledger.db"
    monkeypatch.setattr(db_manager, "DB_PATH", str(db_path))
    db_manager.init_db()
    db_manager.add_transaction(
        500_000, "System", "Opening", t_type="Adjustment", date_str="2026-10-01"
    )
    db_manager.add_transaction(
        -135_000, "Rent", "Rent", t_type="Expense", date_str="2026-10-02"
    )
    db_manager.add_income_source("Pay", 220_000, "Monthly", "2026-01-31")
    db_manager.update_income_source(
        1, "Pay", 220_000, "Monthly", "2026-01-31", "2026-02-28", expected_amount=235_000
    )
    db_manager.add_payment("Rent", 135_000, "Monthly", 1)
    db_manager.add_payment("One-off", 9_900, "One-time", "2026-12-24")
    with db_manager.get_db_connection() as conn:
        with conn:
            conn.execute(
                "INSERT INTO bill_occurrences (payment_id, due_date, paid, transaction_id, original_due_date, is_user_modified) "
                "VALUES (1, '2026-12-01', 1, 2, '2026-12-01', 0)"
            )
            conn.execute(
                "INSERT INTO bill_occurrences (payment_id, due_date, paid, transaction_id, original_due_date, is_user_modified) "
                "VALUES (2, '2026-12-20', 0, NULL, '2026-12-20', 0)"
            )
    return db_path


def _snapshot():
    return json.loads(json.dumps(sync.export_ledger_snapshot()))


def _without(snapshot, key):
    snapshot.pop(key)
    return snapshot


def _assert_unchanged(before, message):
    assert _db_state() == before, message


def test_version_only_snapshot_that_used_to_wipe_the_ledger_is_rejected(populated_db):
    before = _db_state()

    # Characterize the old permissive interpretation to prove the input is dangerous:
    # defaulting every collection and the balance would delete all persisted records.
    old_interpretation = {
        key: {"version": "2.1"}.get(key, []) for key in ("incomes", "payments", "transactions")
    }
    assert old_interpretation == {"incomes": [], "payments": [], "transactions": []}
    assert {"version": "2.1"}.get("current_balance_cents", 0) == 0

    with pytest.raises(ValueError, match="missing required field"):
        sync.restore_ledger_snapshot({"version": "2.1"})
    _assert_unchanged(before, "a version-only snapshot must not touch the ledger")


@pytest.mark.parametrize(
    "missing",
    ["current_balance_cents", "incomes", "payments", "transactions", "bill_occurrences"],
)
def test_missing_required_section_is_rejected(populated_db, missing):
    before = _db_state()
    with pytest.raises(ValueError, match=missing):
        sync.restore_ledger_snapshot(_without(_snapshot(), missing))
    _assert_unchanged(before, f"missing {missing} must not mutate the ledger")


@pytest.mark.parametrize("collection", ["incomes", "payments", "transactions", "bill_occurrences"])
def test_null_collection_is_rejected(populated_db, collection):
    before = _db_state()
    snapshot = _snapshot()
    snapshot[collection] = None
    with pytest.raises(ValueError, match=collection):
        sync.restore_ledger_snapshot(snapshot)
    _assert_unchanged(before, f"null {collection} must be rejected")


@pytest.mark.parametrize("collection", ["incomes", "payments", "transactions", "bill_occurrences"])
def test_non_list_collection_is_rejected(populated_db, collection):
    before = _db_state()
    snapshot = _snapshot()
    snapshot[collection] = {"not": "a list"}
    with pytest.raises(ValueError, match=collection):
        sync.restore_ledger_snapshot(snapshot)
    _assert_unchanged(before, f"wrong type for {collection} must be rejected")


def test_missing_balance_is_not_treated_as_zero(populated_db):
    before = _db_state()
    snapshot = _without(_snapshot(), "current_balance_cents")
    with pytest.raises(ValueError, match="current_balance_cents"):
        sync.restore_ledger_snapshot(snapshot)
    _assert_unchanged(before, "a missing balance must never become zero")


def test_non_object_row_is_rejected(populated_db):
    before = _db_state()
    snapshot = _snapshot()
    snapshot["transactions"].append("not-a-row")
    with pytest.raises(ValueError, match="must be an object"):
        sync.restore_ledger_snapshot(snapshot)
    _assert_unchanged(before, "non-object rows must be rejected")


def test_invalid_reference_is_rejected(populated_db):
    before = _db_state()
    snapshot = _snapshot()
    snapshot["bill_occurrences"][0]["payment_id"] = "does-not-exist"
    with pytest.raises(ValueError, match="references unknown id"):
        sync.restore_ledger_snapshot(snapshot)
    _assert_unchanged(before, "dangling references must be rejected")


def test_duplicate_identifiers_are_rejected(populated_db):
    before = _db_state()
    snapshot = _snapshot()
    snapshot["incomes"].append(json.loads(json.dumps(snapshot["incomes"][0])))
    with pytest.raises(ValueError, match="duplicate identifier"):
        sync.restore_ledger_snapshot(snapshot)
    _assert_unchanged(before, "duplicate ids must be rejected before mutation")


def test_unknown_row_fields_are_rejected(populated_db):
    before = _db_state()
    snapshot = _snapshot()
    snapshot["incomes"][0]["debt_balance_cents"] = 100
    with pytest.raises(ValueError, match="unsupported fields"):
        sync.restore_ledger_snapshot(snapshot)
    _assert_unchanged(before, "unknown financial fields must not be discarded")


def test_money_outside_supported_range_is_rejected(populated_db):
    before = _db_state()
    snapshot = _snapshot()
    snapshot["transactions"][0]["amount_cents"] = 2**63
    snapshot["current_balance_cents"] = sum(t["amount_cents"] for t in snapshot["transactions"])
    with pytest.raises(ValueError, match="must be <="):
        sync.restore_ledger_snapshot(snapshot)
    _assert_unchanged(before, "overflowing money must be rejected")


def test_a_genuinely_empty_ledger_snapshot_is_accepted(populated_db):
    empty = {
        "version": "2.1",
        "updated_at": "2026-11-07T00:00:00+00:00",
        "current_balance_cents": 0,
        "incomes": [],
        "payments": [],
        "transactions": [],
        "bill_occurrences": [],
        "liabilities": [],
    }
    sync.restore_ledger_snapshot(empty)
    state = _db_state()
    assert state["income"] == []
    assert state["payments"] == []
    assert state["transactions"] == []
    assert state["bill_occurrences"] == []
    assert state["ledger_balance"] == 0


def test_legacy_2_0_and_current_2_1_snapshots_restore(populated_db):
    current = _snapshot()
    assert current["version"] == "2.1"

    legacy = json.loads(json.dumps(current))
    legacy["version"] = "2.0"
    legacy["incomes"][0].pop("expected_amount", None)

    for snapshot in (current, legacy):
        sync.restore_ledger_snapshot(snapshot)
        restored = sync.export_ledger_snapshot()
        assert restored["current_balance_cents"] == snapshot["current_balance_cents"]
        assert len(restored["transactions"]) == len(snapshot["transactions"])
        assert len(restored["payments"]) == len(snapshot["payments"])
        assert len(restored["bill_occurrences"]) == len(snapshot["bill_occurrences"])


def test_repair_preserves_original_ledger_after_every_rejection(populated_db):
    """Rejected restores leave the exact persisted state, including the backup path."""
    before = _db_state()
    bad_snapshots = [
        {"version": "2.1"},
        _without(_snapshot(), "transactions"),
        _without(_snapshot(), "incomes"),
        _without(_snapshot(), "payments"),
        _without(_snapshot(), "bill_occurrences"),
        _without(_snapshot(), "current_balance_cents"),
    ]
    for bad in bad_snapshots:
        with pytest.raises(ValueError):
            sync.restore_ledger_snapshot(bad)
        _assert_unchanged(before, "each rejected restore must be a no-op")
