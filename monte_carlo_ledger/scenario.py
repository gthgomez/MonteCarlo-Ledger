"""Structured scenario API (MC-04).

Builds a canonical Contract-1.0 scenario from persisted state. This is the single
bridge from the database to the contract engine; it contains no financial math of
its own and it never reads a clock -- ``as_of`` is always an explicit input.
"""

from __future__ import annotations

import calendar
from datetime import date, timedelta
from typing import Any, Dict, List, Optional

from . import budget_engine, db_manager
from .contract import (
    CONTRACT_VERSION,
    ContractError,
    checked_add,
    recurrence_dates,
    round_half_away,
)

_INCOME_FREQUENCY = {
    "Weekly": "weekly",
    "Bi-weekly": "biweekly",
    "Monthly": "monthly",
    "One-time": "onetime",
}


def _income_recurrence(inc: db_manager.IncomeSource) -> Dict[str, Any]:
    """Map a persisted income row to canonical recurrence fields (MCD-0022).

    The anchor is the day of ``last_payday`` (the original schedule anchor), not
    the day of the possibly month-end-clamped ``next_payday``. A stored next
    payday that does not match the anchored (possibly clamped) date was moved
    deliberately, so it becomes the new anchor.
    """
    try:
        last = date.fromisoformat(inc.last_payday)
        start = date.fromisoformat(inc.next_payday)
    except (TypeError, ValueError) as exc:
        raise ContractError(
            "INVALID_DATE", f"income {inc.name!r} has an invalid payday"
        ) from exc

    frequency = _INCOME_FREQUENCY.get(inc.frequency)
    if frequency is None:
        raise ContractError(
            "INVALID_FREQUENCY", f"income {inc.name!r}: {inc.frequency!r}"
        )

    rec: Dict[str, Any] = {"frequency": frequency, "start_date": start.isoformat()}
    if frequency == "monthly":
        anchor = last.day
        clamped = min(anchor, calendar.monthrange(start.year, start.month)[1])
        if start.day != clamped:
            anchor = start.day
        rec["anchor_day"] = anchor
    return rec


def _income_events_from(
    incomes: List[db_manager.IncomeSource], as_of: date, window_end: date
) -> List[Dict[str, Any]]:
    """Materialize in-window income occurrences with a stable anchor (MCD-0002, MCD-0022)."""
    events: List[Dict[str, Any]] = []
    for inc in incomes:
        dates = recurrence_dates(_income_recurrence(inc), window_end)
        first_in_window = True
        for occurrence in dates:
            if occurrence < as_of:
                continue
            amount = inc.amount
            if first_in_window and inc.expected_amount is not None:
                amount = inc.expected_amount
            events.append({
                "date": occurrence.isoformat(),
                "amount_cents": int(amount),
                "type": "income",
                "name": inc.name,
            })
            first_in_window = False
    return events


def _bill_events_from(
    payments: List[db_manager.Payment],
    occurrences: List[Dict[str, Any]],
    as_of: date,
    window_end: date,
) -> List[Dict[str, Any]]:
    """Materialize in-window unpaid bills from one authoritative occurrence model.

    Persisted occurrences win over regenerated schedule dates. A moved row keeps its
    ``original_due_date``: the original slot and the moved date are both suppressed,
    while the obligation is emitted once at ``due_date`` (Android parity). Scheduled
    slots with no persisted row are filled in memory, so read-only decisions and the
    write path share exactly one projection rule.
    """
    payment_by_id = {p.id: p for p in payments}
    represented = set()
    suppressed = set()
    for occ in occurrences:
        slot = occ.get("original_due_date") or occ["due_date"]
        key = (occ["payment_id"], slot)
        represented.add(key)
        if occ["paid"] or occ["is_user_modified"]:
            suppressed.add(key)
        if occ["is_user_modified"]:
            suppressed.add((occ["payment_id"], occ["due_date"]))

    lo, hi = as_of.isoformat(), window_end.isoformat()
    events: List[Dict[str, Any]] = []
    for occ in occurrences:
        if occ["paid"]:
            continue
        if occ["due_date"] >= hi:
            continue
        pmt = payment_by_id.get(occ["payment_id"])
        if pmt is None:
            continue
        events.append({
            "date": max(lo, occ["due_date"]),
            "amount_cents": -int(pmt.amount),
            "type": "expense",
            "name": pmt.name,
        })

    pmt_dicts = [dict(vars(p)) for p in payments]
    schedule = budget_engine.get_upcoming_schedule(pmt_dicts, lo, hi)
    for item in schedule:
        if item["date"] >= hi:  # enforce half-open even though the helper is inclusive
            continue
        key = (item["payment_id"], item["date"])
        if key in represented or key in suppressed:
            continue
        events.append({
            "date": item["date"],
            "amount_cents": -int(item["amount"]),
            "type": "expense",
            "name": item["name"],
        })
    return events


def _future_transaction_events(
    transactions: List[Dict[str, Any]], as_of: date, window_end: date
) -> List[Dict[str, Any]]:
    """Future-dated posted transactions become events at their date, not opening cash."""
    mapping = {"Income": "income", "Expense": "expense", "Adjustment": "adjustment"}
    lo, hi = as_of.isoformat(), window_end.isoformat()
    events: List[Dict[str, Any]] = []
    for tx in transactions:
        etype = mapping.get(tx["type"])
        if etype is None or not (lo <= tx["date"] < hi):
            continue
        events.append({
            "date": tx["date"],
            "amount_cents": int(tx["amount_cents"]),
            "type": etype,
            "name": tx.get("description") or tx.get("category") or "Planned transaction",
        })
    return events


def _planning_minimum_payment_cents(
    liability: Dict[str, Any], balance_cents: Optional[int] = None
) -> int:
    """Cash-plan minimum for one liability at the supplied balance.

    Matches Contract 2.0 ``minimum_payment`` on the current balance so everyday
    Safe-to-Spend includes debt outflows without changing engine injection rules.
    """
    balance = (
        int(liability.get("balance_cents") or 0)
        if balance_cents is None
        else int(balance_cents)
    )
    if balance <= 0:
        return 0
    if liability.get("kind", "installment") != "revolving":
        return min(int(liability.get("min_payment_cents") or 0), balance)
    percent = round_half_away(
        balance * int(liability.get("min_payment_percent_bps") or 0), 10_000
    )
    floor = int(liability.get("min_payment_floor_cents") or 0)
    return min(max(percent, floor), balance)


def _linked_payment_slot(payment: Any, year: int, month: int) -> Optional[date]:
    """The date a linked bill pays its debt in one calendar month.

    A link means the bill is the debt payment, so the bill's recurrence owns the
    slot even when the debt's stored due day differs. A one-time bill occupies
    only its own month; other months fall back to the debt's due day.
    """
    recurrence = getattr(payment, "recurrence", None)
    if recurrence == "Monthly":
        day = getattr(payment, "due_day", None)
        if day is None:
            return None
        last_day = calendar.monthrange(year, month)[1]
        return date(year, month, min(int(day), last_day))
    if recurrence == "One-time":
        due_date = getattr(payment, "due_date", None)
        if not due_date:
            return None
        parsed = date.fromisoformat(due_date)
        return parsed if (parsed.year, parsed.month) == (year, month) else None
    return None


def _is_unpaid_moved_occurrence(occurrence: Optional[Dict[str, Any]]) -> bool:
    return bool(
        occurrence and not occurrence["paid"] and occurrence.get("original_due_date")
        and occurrence["original_due_date"] != occurrence["due_date"]
    )


def _liability_min_payment_events(
    liabilities: List[Dict[str, Any]],
    payments: List[Any],
    as_of: date,
    window_end: date,
    occurrences: Optional[List[Dict[str, Any]]] = None,
) -> List[Dict[str, Any]]:
    """Emit monthly debt minimums, with credit only for explicit payment links."""
    occurrences = occurrences or []
    owners: Dict[int, int] = {}
    for liability in liabilities:
        link = liability.get("linked_payment_id")
        if link is not None:
            owners[link] = owners.get(link, 0) + 1
    payments_by_id = {payment.id: payment for payment in payments}
    occurrences_by_payment: Dict[int, Dict[str, Dict[str, Any]]] = {}
    for row in occurrences:
        payment_id = row["payment_id"]
        if payment_id not in owners:
            continue
        slot = row.get("original_due_date") or row["due_date"]
        payment_slots = occurrences_by_payment.setdefault(payment_id, {})
        if slot in payment_slots:
            raise ValueError(f"Linked payment {payment_id} has duplicate occurrences for {slot}")
        payment_slots[slot] = row
    # Generate upcoming slots with the same recurrence helper used by bill events.
    schedule = budget_engine.get_upcoming_schedule(
        [vars(payment) for payment in payments if owners.get(payment.id) == 1],
        as_of.isoformat(),
        window_end.isoformat(),
    )
    moved_destinations = {
        (row["payment_id"], row["due_date"]) for row in occurrences if row["is_user_modified"]
    }
    scheduled_slots = {(row["payment_id"], row["date"]) for row in schedule} - moved_destinations

    events: List[Dict[str, Any]] = []
    lo, hi = as_of.isoformat(), window_end.isoformat()
    forecast_offsets = range(horizon_month_span(as_of, window_end) + 1)
    # Stable identity order keeps same-day event order, and therefore seeded risk
    # draws, consistent with the Web adapter even when snapshots use another order.
    for liability in sorted(liabilities, key=lambda item: str(item.get("id") or "")):
        name = str(liability.get("name") or "Debt payment")
        due_day = int(liability.get("due_day_of_month") or 1)
        if due_day < 1 or due_day > 31:
            due_day = 1
        if not liability.get("is_active", True):
            continue
        link = liability.get("linked_payment_id")
        payment = payments_by_id.get(link) if link is not None and owners[link] == 1 else None
        payment_slots = occurrences_by_payment.get(payment.id, {}) if payment is not None else {}
        # Visit sparse moved slots whose cash date is in the window, even when
        # their original cycle is far before or after the ordinary forecast.
        offsets = set(forecast_offsets)
        oldest_slot_by_month: Dict[str, str] = {}
        for original, row in payment_slots.items():
            month = original[:7]
            oldest_slot_by_month[month] = min(original, oldest_slot_by_month.get(month, original))
            if row["due_date"] < hi and _is_unpaid_moved_occurrence(row):
                offsets.add(horizon_month_span(as_of, date.fromisoformat(original)))

        due_slots: List[tuple[str, int, bool]] = []
        for offset in sorted(offsets):
            year_offset, month_index = divmod(as_of.month - 1 + offset, 12)
            cursor_year, cursor_month = as_of.year + year_offset, month_index + 1
            month = date(cursor_year, cursor_month, 1).isoformat()[:7]
            last_day = calendar.monthrange(cursor_year, cursor_month)[1]
            day = min(due_day, last_day)
            fallback_due = date(cursor_year, cursor_month, day)
            linked_due = (
                _linked_payment_slot(payment, cursor_year, cursor_month)
                if payment is not None
                else None
            )
            # The linked bill owns the slot; look up coverage by the original
            # date, then use the date cash will leave for any unpaid shortfall.
            due_iso = (linked_due or fallback_due).isoformat()
            cash_due_iso = due_iso
            covered = 0
            paid_coverage = False
            if payment is not None:
                occurrence = payment_slots.get(due_iso)
                if occurrence is None and getattr(payment, "recurrence", None) == "Monthly":
                    # A template edit can leave several slots in this month.
                    # Pick the oldest original slot, independent of the cash-date order.
                    oldest_slot = oldest_slot_by_month.get(month)
                    if oldest_slot is not None:
                        occurrence = payment_slots[oldest_slot]
                if offset not in forecast_offsets and not _is_unpaid_moved_occurrence(occurrence):
                    continue
                if occurrence is not None:
                    if occurrence["paid"]:
                        posted_amount = occurrence.get("transaction_amount")
                        covered = payment.amount if posted_amount is None else max(0, -posted_amount)
                        paid_coverage = True
                    else:
                        cash_due_iso = occurrence["due_date"]
                        covered = payment.amount
                elif (payment.id, due_iso) in scheduled_slots:
                    covered = payment.amount

            # Keep outstanding overdue minimums in the start-of-window cash plan.
            event_date_iso = max(cash_due_iso, lo)
            if event_date_iso < hi:
                due_slots.append((event_date_iso, covered, paid_coverage))

        # Apply by cash date; the stable sort keeps original-month order for ties.
        due_slots.sort(key=lambda slot: slot[0])
        remaining_balance = int(liability.get("balance_cents") or 0)
        if _planning_minimum_payment_cents(liability, remaining_balance) <= 0:
            continue
        interest_through_month = 0
        for event_date_iso, covered, paid_coverage in due_slots:
            if remaining_balance <= 0:
                break
            cash_month = horizon_month_span(as_of, date.fromisoformat(event_date_iso))
            while interest_through_month < cash_month:
                interest = round_half_away(
                    remaining_balance * int(liability.get("apr_basis_points") or 0),
                    120_000,
                )
                remaining_balance = checked_add(remaining_balance, interest)
                interest_through_month += 1
            amount = _planning_minimum_payment_cents(liability, remaining_balance)
            if amount <= 0:
                break
            shortfall = max(0, amount - covered)
            if shortfall:
                events.append({
                    "date": event_date_iso,
                    "amount_cents": -shortfall,
                    "type": "expense",
                    "name": name,
                })
            remaining_balance -= shortfall if paid_coverage else amount
    return events


def horizon_month_span(as_of: date, window_end: date) -> int:
    return (window_end.year - as_of.year) * 12 + (window_end.month - as_of.month)


def _bill_events_readonly(as_of: date, window_end: date) -> List[Dict[str, Any]]:
    """Standalone readonly projection (opens its own consistent view)."""
    view = db_manager.read_ledger_view(as_of.isoformat(), window_end.isoformat())
    return _bill_events_from(
        view["payments"], view["occurrences"], as_of, window_end
    )


def _bill_events_rw(as_of: date, window_end: date) -> List[Dict[str, Any]]:
    """Materialize any missing slots, then use the same projection as read-only."""
    db_manager.sync_bill_occurrences(as_of.isoformat(), window_end.isoformat())
    return _bill_events_readonly(as_of, window_end)


def _bill_events(as_of: date, window_end: date, read_only: bool) -> List[Dict[str, Any]]:
    return _bill_events_readonly(as_of, window_end) if read_only else _bill_events_rw(as_of, window_end)


def canonical_event_order(events: List[Dict[str, Any]]) -> None:
    """Sort explicit events by the surface-independent same-day order."""
    events.sort(
        key=lambda event: (
            event["date"],
            0 if event["type"] == "income" else 2 if event["type"] == "adjustment" else 1,
            event.get("name") or "",
            event["amount_cents"],
            event.get("category") or "",
        )
    )


def build_scenario(
    as_of: str,
    horizon_days: int = 90,
    include_simulation: Optional[Dict[str, Any]] = None,
    read_only: bool = False,
    ledger: Optional[Dict[str, Any]] = None,
    *,
    paycheck_delay_days: Optional[int] = None,
) -> Dict[str, Any]:
    """Return a canonical scenario for the given explicit ``as_of`` (YYYY-MM-DD).

    When ``ledger`` is supplied (a ``db_manager.read_ledger_view`` result), the whole
    scenario is derived from that one consistent snapshot rather than reopening the
    database several times. ``paycheck_delay_days`` affects only the earliest
    in-window event from the explicit income schedule.
    """
    start = date.fromisoformat(as_of)
    window_end = start + timedelta(days=horizon_days)
    if ledger is None:
        if not read_only:
            db_manager.sync_bill_occurrences(as_of, window_end.isoformat(), include_lookback=False)
        ledger = db_manager.read_ledger_view(as_of, window_end.isoformat())
    liabilities = ledger.get("liabilities") or []
    scheduled_income = _income_events_from(ledger["incomes"], start, window_end)
    events = (
        _bill_events_from(ledger["payments"], ledger["occurrences"], start, window_end)
        + scheduled_income
        + _future_transaction_events(ledger["future_transactions"], start, window_end)
        + _liability_min_payment_events(
            liabilities, ledger["payments"], start, window_end, ledger["occurrences"]
        )
    )
    # Canonicalize same-day ties by stable, surface-independent fields. The engine's
    # input-order tie-breaker must not depend on SQL/array order: otherwise the same
    # ledger could assign seeded bill/income draws differently on Web/Python.
    canonical_event_order(events)
    if paycheck_delay_days is not None:
        if not scheduled_income:
            raise ContractError("NO_INCOME", "no paycheck is scheduled in this window")
        # Follow event identity so a posted transaction with the same fields is
        # never chosen. Keep the original order for ties at the new date.
        scheduled_ids = {id(event) for event in scheduled_income}
        target = next(event for event in events if id(event) in scheduled_ids)
        target["date"] = (
            date.fromisoformat(target["date"]) + timedelta(days=paycheck_delay_days)
        ).isoformat()
    starting_balance = ledger["starting_balance_cents"]
    scenario: Dict[str, Any] = {
        "contract_version": CONTRACT_VERSION,
        "scenario_id": f"db-{as_of}-{horizon_days}",
        "as_of": as_of,
        "starting_balance_cents": starting_balance,
        "horizon_days": horizon_days,
        "events": events,
    }
    # Contract 2.0 keeps amortization in the debt block; adapters also add ordinary
    # minimum-payment expense events so everyday Safe-to-Spend includes entered debts.
    # Omit the liabilities key when empty (Web/legacy parity); never invent debt rows.
    active_liabilities = [
        {key: value for key, value in item.items() if key not in ("linked_payment_id", "is_active")}
        for item in liabilities
        if item.get("is_active", True)
    ]
    if active_liabilities:
        scenario["liabilities"] = active_liabilities
        scenario["debt_strategy"] = "snowball"
    if include_simulation is not None:
        scenario["simulation"] = include_simulation
    return scenario
