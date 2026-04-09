from datetime import datetime, timedelta

from . import budget_engine, db_manager
from .dashboards import render_forecast_dashboard, render_monte_carlo_dashboard
from .ui import format_currency, format_date_display


def handle_forecast():
    render_forecast_dashboard()
    input("\nPress Enter...")


def handle_risk_outlook():
    render_monte_carlo_dashboard()
    input("\nPress Enter...")


def handle_upcoming_schedule():
    view_upcoming_30()
    input("\nPress Enter...")


def handle_reporting():
    reporting_menu()


def handle_view_history():
    view_history()
    input("\nPress Enter...")


def view_upcoming_30():
    print("\n--- Upcoming Bills Schedule (30 Days) ---")
    payments = [dict(vars(p)) for p in db_manager.get_all_payments()]
    today_str = datetime.now().strftime("%Y-%m-%d")
    end_str = (datetime.now() + timedelta(days=30)).strftime("%Y-%m-%d")
    schedule = budget_engine.get_upcoming_schedule(payments, today_str, end_str)
    if not schedule:
        print("No bills found.")
    else:
        print(f"{'Due Date':<12} {'Amount':<10} {'Recurrence':<12} {'Name'}")
        print("-" * 50)
        for item in schedule:
            due_date = format_date_display(item["date"])
            amount = budget_engine.from_cents(item["amount"])
            print(f"{due_date:<12} ${amount:<9,.2f} {item['recurrence']:<12} {item['name']}")


def reporting_menu():
    while True:
        print("\n--- Reporting & Insights ---")
        print("1. Spending by Category (30 Days)")
        print("2. Spending by Category (All Time)")
        print("3. Income vs Expense Summary (30 Days)")
        print("4. Income vs Expense Summary (All Time)")
        print("5. Adjustment Log (Reconciliations)")
        print("6. Back")
        choice = input("\nChoice: ")
        if choice in ("1", "2"):
            days = 30 if choice == "1" else None
            data = db_manager.get_spend_by_category(days)
            print(f"\n--- Spending Breakdown ({'30 Days' if days else 'All Time'}) ---")
            if not data:
                print("No expenses recorded.")
            else:
                for row in data:
                    print(
                        f" {row['category']:<20}: "
                        f"${budget_engine.from_cents(abs(row['total'])):,.2f}"
                    )
        elif choice in ("3", "4"):
            days = 30 if choice == "3" else None
            summary = db_manager.get_flow_summary(days)
            print(f"\n--- Cash Flow Summary ({'30 Days' if days else 'All Time'}) ---")
            print(f" Total Inflows : {format_currency(summary['inflow'])}")
            print(f" Total Outflows: {format_currency(-summary['outflow'])}")
            print(f" Net Change    : {format_currency(summary['inflow'] - summary['outflow'])}")
        elif choice == "5":
            adjustments = db_manager.get_adjustment_history()
            print("\n--- Recent Reconciliation Adjustments ---")
            if not adjustments:
                print("No adjustments found.")
            else:
                for adjustment in adjustments:
                    print(
                        f" {format_date_display(adjustment.date)}: "
                        f"{format_currency(adjustment.amount):<12} | {adjustment.description}"
                    )
        elif choice == "6":
            break


def view_history():
    print("\n--- Recent Transactions ---")
    history = db_manager.get_transaction_history(15)
    if not history:
        print("No transactions.")
    else:
        print(f"{'Date':<12} {'Type':<12} {'Amount':<12} {'Description'}")
        print("-" * 55)
        for entry in history:
            display_date = format_date_display(entry.date)
            print(
                f"{display_date:<12} {entry.type:<12} "
                f"{format_currency(entry.amount):<12} {entry.description}"
            )
