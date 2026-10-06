"""Structured scenario API (MC-04).

Builds a canonical Contract-1.0 scenario from persisted state. This is the single
bridge from the database to the contract engine; it contains no financial math of
its own and it never reads a clock -- ``as_of`` is always an explicit input.
"""

from __future__ import annotations

from datetime import date, timedelta
from typing import Any, Dict, List, Optional

from . import budget_engine, db_manager

CONTRACT_VERSION = "1.0"
_MAX_OCCURRENCES = 100_000


def _income_events(as_of: date, window_end: date) -> List[Dict[str, Any]]:
    """Materialize in-window income occurrences (MCD-0002, MCD-0017)."""
    events: List[Dict[str, Any]] = []
    for inc in db_manager.get_all_income():
        try:
            current = date.fromisoformat(inc.next_payday)
        except (TypeError, ValueError):
            continue
        first_in_window = True
        guard = 0
        while current < window_end and guard < _MAX_OCCURRENCES:
            if current >= as_of:
                amount = inc.amount
                if first_in_window and inc.expected_amount is not None:
                    amount = inc.expected_amount
                events.append({
                    "date": current.isoformat(),
                    "amount_cents": int(amount),
                    "type": "income",
                    "name": inc.name,
                })
                first_in_window = False
            nxt = budget_engine.get_next_payday(current.isoformat(), inc.frequency)
            try:
                next_date = date.fromisoformat(nxt)
            except ValueError:
                break
            if next_date <= current:
                break
            current = next_date
            guard += 1
    return events


def _bill_events_rw(as_of: date, window_end: date) -> List[Dict[str, Any]]:
    """Materialize in-window unpaid bill occurrences. Overdue (< as_of) is excluded (MCD-0014)."""
    db_manager.sync_bill_occurrences(as_of.isoformat(), window_end.isoformat())
    occurrences = db_manager.get_unpaid_occurrences(as_of.isoformat(), window_end.isoformat())
    events: List[Dict[str, Any]] = []
    lo, hi = as_of.isoformat(), window_end.isoformat()
    for occ in occurrences:
        if occ.amount is None or occ.name is None:
            continue
        if lo <= occ.due_date < hi:
            events.append({
                "date": occ.due_date,
                "amount_cents": -int(occ.amount),
                "type": "expense",
                "name": occ.name,
            })
    return events


def _bill_events_readonly(as_of: date, window_end: date) -> List[Dict[str, Any]]:
    """Project in-window unpaid bills in-memory (no writes), half-open ``[as_of, window_end)``."""
    payments = db_manager.get_all_payments()
    pmt_dicts = [dict(vars(p)) for p in payments]
    schedule = budget_engine.get_upcoming_schedule(
        pmt_dicts, as_of.isoformat(), window_end.isoformat()
    )
    with db_manager.get_db_connection() as conn:
        paid = conn.execute(
            "SELECT payment_id, due_date FROM bill_occurrences "
            "WHERE paid = 1 AND due_date >= ? AND due_date <= ?",
            (as_of.isoformat(), window_end.isoformat()),
        ).fetchall()
    paid_set = {(r["payment_id"], r["due_date"]) for r in paid}
    hi = window_end.isoformat()
    events: List[Dict[str, Any]] = []
    for item in schedule:
        if item["date"] >= hi:  # enforce half-open even though the helper is inclusive
            continue
        if (item["payment_id"], item["date"]) in paid_set:
            continue
        events.append({
            "date": item["date"],
            "amount_cents": -int(item["amount"]),
            "type": "expense",
            "name": item["name"],
        })
    return events


def _bill_events(as_of: date, window_end: date, read_only: bool) -> List[Dict[str, Any]]:
    return _bill_events_readonly(as_of, window_end) if read_only else _bill_events_rw(as_of, window_end)


def build_scenario(
    as_of: str,
    horizon_days: int = 90,
    include_simulation: Optional[Dict[str, Any]] = None,
    read_only: bool = False,
) -> Dict[str, Any]:
    """Return a canonical scenario for the given explicit ``as_of`` (YYYY-MM-DD)."""
    start = date.fromisoformat(as_of)
    window_end = start + timedelta(days=horizon_days)
    events = _bill_events(start, window_end, read_only) + _income_events(start, window_end)
    scenario: Dict[str, Any] = {
        "contract_version": CONTRACT_VERSION,
        "scenario_id": f"db-{as_of}-{horizon_days}",
        "as_of": as_of,
        "starting_balance_cents": db_manager.get_ledger_balance(),
        "horizon_days": horizon_days,
        "events": events,
    }
    if include_simulation is not None:
        scenario["simulation"] = include_simulation
    return scenario
