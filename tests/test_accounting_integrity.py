"""Accounting integrity: payment linkage, moved bills, as_of cash, overdue visibility."""

from __future__ import annotations

import json
import sqlite3
from datetime import date

import pytest

from monte_carlo_ledger import db_manager, decisions, scenario, sync

AS_OF = "2026-11-01"
HORIZON = 30
WINDOW_END = "2026-12-01"


@pytest.fixture
def ledger(tmp_path, monkeypatch):
    monkeypatch.setattr(db_manager, "DB_PATH", str(tmp_path / "ledger.db"))
    db_manager.init_db()
    db_manager.add_transaction(
        500_000, "System", "Opening", t_type="Adjustment", date_str="2026-09-01"
    )
    return db_manager


def _occ(pid: int, due: str, *, paid: bool = False, txn: int | None = None,
         original: str | None = None, modified: bool = False) -> int:
    with db_manager.get_db_connection() as conn:
        with conn:
            cur = conn.execute(
                "INSERT INTO bill_occurrences "
                "(payment_id, due_date, paid, transaction_id, original_due_date, is_user_modified) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (pid, due, 1 if paid else 0, txn, original or due, 1 if modified else 0),
            )
            return int(cur.lastrowid)


def _events(scenario_dict):
    return [e for e in scenario_dict["events"] if e["type"] == "expense"]


# --------------------------------------------------------------------------
# One transaction pays one bill
# --------------------------------------------------------------------------


def _link_snapshot(occurrences, transactions):
    return {
        "version": "2.1",
        "current_balance_cents": sum(t["amount_cents"] for t in transactions),
        "incomes": [],
        "payments": [
            {"id": "p1", "name": "A", "amount_cents": 10_000, "recurrence": "One-time",
             "due_date": "2026-11-01", "is_auto_withdraw": True},
            {"id": "p2", "name": "B", "amount_cents": 10_000, "recurrence": "One-time",
             "due_date": "2026-11-02", "is_auto_withdraw": True},
        ],
        "transactions": transactions,
        "bill_occurrences": occurrences,
        "liabilities": [],
    }


def _expense(tid: str, amount: int = -10_000, ttype: str = "Expense") -> dict:
    return {"id": tid, "amount_cents": amount, "category": "Bills", "type": ttype,
            "date": "2026-10-01", "description": "payment"}


@pytest.fixture
def populated(ledger):
    return ledger


def test_duplicate_transaction_link_is_rejected_without_mutation(populated):
    before = sync.export_ledger_snapshot()
    snapshot = _link_snapshot(
        [
            {"id": "o1", "payment_id": "p1", "due_date": "2026-11-01", "paid": True,
             "transaction_id": "t1"},
            {"id": "o2", "payment_id": "p2", "due_date": "2026-11-02", "paid": True,
             "transaction_id": "t1"},
        ],
        [_expense("t1", -10_000)],
    )
    with pytest.raises(ValueError, match="cannot pay multiple bills"):
        sync.restore_ledger_snapshot(snapshot)
    after = sync.export_ledger_snapshot()
    before.pop("updated_at", None)
    after.pop("updated_at", None)
    assert after == before


def test_paid_occurrence_linked_to_income_is_rejected(populated):
    snapshot = _link_snapshot(
        [{"id": "o1", "payment_id": "p1", "due_date": "2026-11-01", "paid": True,
          "transaction_id": "t1"}],
        [_expense("t1", 10_000, "Income")],
    )
    with pytest.raises(ValueError, match="non-Expense"):
        sync.restore_ledger_snapshot(snapshot)


def test_unknown_transaction_reference_is_rejected(populated):
    snapshot = _link_snapshot(
        [{"id": "o1", "payment_id": "p1", "due_date": "2026-11-01", "paid": True,
          "transaction_id": "missing"}],
        [_expense("t1")],
    )
    with pytest.raises(ValueError, match="unknown id"):
        sync.restore_ledger_snapshot(snapshot)


def test_amount_mismatch_is_rejected(populated):
    snapshot = _link_snapshot(
        [{"id": "o1", "payment_id": "p1", "due_date": "2026-11-01", "paid": True,
          "transaction_id": "t1"}],
        [_expense("t1", -9_999)],
    )
    with pytest.raises(ValueError, match="does not match the bill amount"):
        sync.restore_ledger_snapshot(snapshot)


def test_legitimate_exact_payment_is_accepted(populated):
    snapshot = _link_snapshot(
        [{"id": "o1", "payment_id": "p1", "due_date": "2026-11-01", "paid": True,
          "transaction_id": "t1"}],
        [_expense("t1", -10_000)],
    )
    sync.restore_ledger_snapshot(snapshot)
    exported = sync.export_ledger_snapshot()
    assert exported["bill_occurrences"][0]["transaction_id"] == exported["transactions"][0]["id"]


def test_marking_the_same_payment_twice_is_safe_and_reuse_is_impossible(ledger):
    db_manager.add_payment("Bill A", 10_000, "One-time", "2026-11-01")
    db_manager.add_payment("Bill B", 10_000, "One-time", "2026-11-02")
    txn = db_manager.add_transaction(-10_000, "Bills", "paid", t_type="Expense", date_str="2026-11-01")
    db_manager.sync_bill_occurrences(AS_OF, WINDOW_END)
    occs = db_manager.get_unpaid_occurrences(AS_OF, WINDOW_END)
    first, second = [o for o in occs if o.payment_id in (1, 2)][:2]
    db_manager.mark_occurrence_paid(first.id, txn)
    db_manager.mark_occurrence_paid(first.id, txn)  # idempotent for the same occurrence
    with pytest.raises(ValueError, match="already linked"):
        db_manager.mark_occurrence_paid(second.id, txn)
    with pytest.raises(sqlite3.IntegrityError):
        with db_manager.get_db_connection() as conn:
            with conn:
                conn.execute(
                    "UPDATE bill_occurrences SET transaction_id = ?, paid = 1 WHERE id = ?",
                    (txn, second.id),
                )


def test_migration_detaches_existing_duplicate_links_without_deleting_records(tmp_path, monkeypatch):
    path = tmp_path / "legacy.db"
    monkeypatch.setattr(db_manager, "DB_PATH", str(path))
    db_manager.init_db()
    db_manager.add_payment("A", 10_000, "One-time", "2026-11-01")
    db_manager.add_payment("B", 10_000, "One-time", "2026-11-02")
    txn = db_manager.add_transaction(-10_000, "Bills", "x", t_type="Expense", date_str="2026-11-01")
    with db_manager.get_db_connection() as conn:
        with conn:
            conn.execute("DROP INDEX IF EXISTS idx_occurrences_transaction_unique")
    a = _occ(1, "2026-11-01", paid=True, txn=txn)
    b = _occ(2, "2026-11-02", paid=True, txn=txn)
    with db_manager.get_db_connection() as conn:
        with conn:
            conn.execute("PRAGMA user_version = 10")
    db_manager.init_db()
    with db_manager.get_db_connection() as conn:
        rows = conn.execute(
            "SELECT id, paid, transaction_id FROM bill_occurrences ORDER BY id"
        ).fetchall()
        detached = conn.execute(
            "SELECT value FROM settings WHERE key = 'migration_11_detached_duplicate_links'"
        ).fetchone()
    assert len(rows) == 2
    assert [r["id"] for r in rows] == [a, b]
    assert rows[0]["transaction_id"] == txn
    assert rows[1]["transaction_id"] is None
    assert all(r["paid"] == 1 for r in rows)
    assert int(detached["value"]) == 1


def test_snapshot_rejects_bad_transaction_signs(populated):
    transactions = [_expense("t1", -10_000, "Income")]
    snapshot = _link_snapshot([], transactions)
    with pytest.raises(ValueError, match="Income but not positive"):
        sync.restore_ledger_snapshot(snapshot)
    snapshot = _link_snapshot([], [_expense("t1", 10_000, "Expense")])
    with pytest.raises(ValueError, match="Expense but not negative"):
        sync.restore_ledger_snapshot(snapshot)
    snapshot = _link_snapshot([], [_expense("t1", 0, "Adjustment")])
    with pytest.raises(ValueError, match="zero Adjustment"):
        sync.restore_ledger_snapshot(snapshot)


# --------------------------------------------------------------------------
# Moved / skipped bills
# --------------------------------------------------------------------------


def _add_rent(ledger):
    ledger.add_payment("Rent", 50_000, "Monthly", 1)
    return int(ledger.get_all_payments()[0].id)


def test_moved_unpaid_bill_is_counted_once_at_the_moved_date(ledger):
    pid = _add_rent(ledger)
    db_manager.sync_bill_occurrences(AS_OF, "2027-01-01")
    with db_manager.get_db_connection() as conn:
        row = conn.execute(
            "SELECT id FROM bill_occurrences WHERE payment_id = ? AND original_due_date = ?",
            (pid, "2026-11-01"),
        ).fetchone()
    db_manager.reschedule_occurrence(row["id"], "2026-11-05")

    built = scenario.build_scenario(AS_OF, HORIZON, read_only=True)
    rent = [e for e in _events(built) if e["name"] == "Rent"]
    assert [e["date"] for e in rent] == ["2026-11-05"]

    # The write path and a repeated sync must not regenerate the original slot.
    db_manager.sync_bill_occurrences(AS_OF, WINDOW_END)
    db_manager.sync_bill_occurrences(AS_OF, WINDOW_END)
    built = scenario.build_scenario(AS_OF, HORIZON)
    assert [e["date"] for e in _events(built) if e["name"] == "Rent"] == ["2026-11-05"]


def test_december_after_a_move_uses_the_original_recurrence_anchor(ledger):
    pid = _add_rent(ledger)
    db_manager.sync_bill_occurrences(AS_OF, "2027-01-01")
    with db_manager.get_db_connection() as conn:
        row = conn.execute(
            "SELECT id FROM bill_occurrences WHERE payment_id = ? AND original_due_date = ?",
            (pid, "2026-11-01"),
        ).fetchone()
    db_manager.reschedule_occurrence(row["id"], "2026-11-05")
    built = scenario.build_scenario(AS_OF, 60, read_only=True)
    assert [e["date"] for e in _events(built) if e["name"] == "Rent"] == [
        "2026-11-05", "2026-12-01",
    ]


def test_bill_moved_outside_the_horizon_is_not_projected(ledger):
    pid = _add_rent(ledger)
    db_manager.sync_bill_occurrences(AS_OF, "2027-01-01")
    with db_manager.get_db_connection() as conn:
        row = conn.execute(
            "SELECT id FROM bill_occurrences WHERE payment_id = ? AND original_due_date = ?",
            (pid, "2026-11-01"),
        ).fetchone()
    db_manager.reschedule_occurrence(row["id"], "2027-01-15")
    built = scenario.build_scenario(AS_OF, HORIZON, read_only=True)
    assert [e for e in _events(built) if e["name"] == "Rent"] == []


def test_a_bill_paid_after_being_moved_is_excluded(ledger):
    pid = _add_rent(ledger)
    db_manager.sync_bill_occurrences(AS_OF, WINDOW_END)
    with db_manager.get_db_connection() as conn:
        row = conn.execute(
            "SELECT id FROM bill_occurrences WHERE payment_id = ? AND original_due_date = ?",
            (pid, "2026-11-01"),
        ).fetchone()
    db_manager.reschedule_occurrence(row["id"], "2026-11-05")
    txn = db_manager.add_transaction(-50_000, "Rent", "paid", t_type="Expense", date_str="2026-11-05")
    db_manager.mark_occurrence_paid(row["id"], txn)
    built = scenario.build_scenario(AS_OF, HORIZON, read_only=True)
    assert [e for e in _events(built) if e["name"] == "Rent"] == []


def test_a_skipped_bill_does_not_reappear(ledger):
    pid = _add_rent(ledger)
    db_manager.sync_bill_occurrences(AS_OF, WINDOW_END)
    with db_manager.get_db_connection() as conn:
        with conn:
            conn.execute(
                "UPDATE bill_occurrences SET paid = 1, transaction_id = NULL "
                "WHERE payment_id = ? AND original_due_date = '2026-11-01'",
                (pid,),
            )
    built = scenario.build_scenario(AS_OF, HORIZON, read_only=True)
    assert [e for e in _events(built) if e["name"] == "Rent"] == []


def test_bills_with_the_same_name_but_different_ids_are_independent(ledger):
    db_manager.add_payment("Utilities", 1_000, "One-time", "2026-11-03")
    db_manager.add_payment("Utilities", 2_000, "One-time", "2026-11-04")
    db_manager.sync_bill_occurrences(AS_OF, WINDOW_END)
    built = scenario.build_scenario(AS_OF, HORIZON, read_only=True)
    util = sorted(e["amount_cents"] for e in _events(built) if e["name"] == "Utilities")
    assert util == [-2_000, -1_000]


# --------------------------------------------------------------------------
# as_of starting balance and future-dated transactions
# --------------------------------------------------------------------------


def test_future_expense_is_not_opening_cash(ledger):
    ledger.add_transaction(-100_000, "Future", "future", t_type="Expense", date_str="2026-11-15")
    view = db_manager.read_ledger_view(AS_OF, WINDOW_END)
    assert view["starting_balance_cents"] == 500_000
    assert view["ledger_balance_cents"] == 400_000
    built = scenario.build_scenario(AS_OF, HORIZON, read_only=True)
    assert built["starting_balance_cents"] == 500_000
    assert [e["date"] for e in _events(built)] == ["2026-11-15"]


def test_historical_as_of_excludes_transactions_after_the_date(ledger):
    ledger.add_transaction(-100_000, "Future", "future", t_type="Expense", date_str="2026-11-15")
    view = db_manager.read_ledger_view("2026-10-01", "2026-10-31")
    assert view["starting_balance_cents"] == 500_000
    built = scenario.build_scenario("2026-10-01", HORIZON, read_only=True)
    assert built["starting_balance_cents"] == 500_000
    assert built["events"] == []


def test_future_income_and_backdated_correction(ledger):
    ledger.add_transaction(50_000, "Future pay", "future", t_type="Income", date_str="2026-11-20")
    ledger.add_transaction(-10_000, "Correction", "backdated", t_type="Expense", date_str="2026-10-15")
    view = db_manager.read_ledger_view(AS_OF, WINDOW_END)
    assert view["starting_balance_cents"] == 490_000
    built = scenario.build_scenario(AS_OF, HORIZON, read_only=True)
    assert built["starting_balance_cents"] == 490_000
    future = [e for e in built["events"] if e["date"] == "2026-11-20"]
    assert future == [{"date": "2026-11-20", "amount_cents": 50_000, "type": "income",
                       "name": "future"}]


def test_current_date_with_no_future_transactions_starts_at_ledger_balance(ledger):
    view = db_manager.read_ledger_view("2026-11-07", WINDOW_END)
    assert view["starting_balance_cents"] == view["ledger_balance_cents"] == 500_000


# --------------------------------------------------------------------------
# Overdue obligations are visible but not injected
# --------------------------------------------------------------------------


def test_overdue_obligation_is_reported_and_not_projected(ledger):
    ledger.add_payment("Past bill", 25_000, "One-time", "2026-10-15")
    db_manager.sync_bill_occurrences(AS_OF, WINDOW_END)
    view = db_manager.read_ledger_view(AS_OF, WINDOW_END)
    assert view["overdue"] == {"count": 1, "total_cents": 25_000, "earliest_date": "2026-10-15"}
    built = scenario.build_scenario(AS_OF, HORIZON, read_only=True)
    assert [e for e in built["events"] if e.get("name") == "Past bill"] == []
    result = decisions.forecast(AS_OF, HORIZON)
    assert result["ledger"]["overdue_obligations"]["count"] == 1
    assert result["ledger"]["overdue_obligations"]["total_cents"] == 25_000


# --------------------------------------------------------------------------
# Read-only decisions never mutate occurrence state
# --------------------------------------------------------------------------


def test_read_only_decisions_do_not_create_occurrences(ledger):
    _add_rent(ledger)
    with db_manager.get_db_connection() as conn:
        before = [dict(r) for r in conn.execute("SELECT * FROM bill_occurrences ORDER BY id")]
    decisions.forecast(AS_OF, HORIZON)
    decisions.risk(AS_OF, HORIZON, {"runs": 5, "seed": 1})
    with db_manager.get_db_connection() as conn:
        after = [dict(r) for r in conn.execute("SELECT * FROM bill_occurrences ORDER BY id")]
    assert after == before
