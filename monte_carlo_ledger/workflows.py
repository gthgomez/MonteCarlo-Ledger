"""Stable facade for interactive workflow modules."""

from .workflow_account import handle_reconcile, reconcile_flow
from .workflow_income import handle_manage_income, handle_process_payday, process_payday_flow
from .workflow_onboarding import run_onboarding
from .workflow_payments import (
    handle_add_bill,
    handle_manage_payments,
    handle_mark_paid,
    manage_payments_menu,
)
from .workflow_reporting import (
    handle_forecast,
    handle_reporting,
    handle_risk_outlook,
    handle_upcoming_schedule,
    handle_view_history,
    reporting_menu,
    view_history,
    view_upcoming_30,
)

__all__ = [
    "handle_add_bill",
    "handle_forecast",
    "handle_manage_income",
    "handle_manage_payments",
    "handle_mark_paid",
    "handle_process_payday",
    "handle_reconcile",
    "handle_reporting",
    "handle_risk_outlook",
    "handle_upcoming_schedule",
    "handle_view_history",
    "manage_payments_menu",
    "process_payday_flow",
    "reconcile_flow",
    "reporting_menu",
    "run_onboarding",
    "view_history",
    "view_upcoming_30",
]
