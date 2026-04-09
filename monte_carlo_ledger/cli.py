import sys

from . import dashboards, db_manager, forecasting, monte_carlo_config, risk, workflows
from .ui import Theme, cprint, show_global_help, wait_for_user

build_financial_timeline = dashboards.build_financial_timeline
render_forecast_dashboard = dashboards.render_forecast_dashboard
render_monte_carlo_dashboard = dashboards.render_monte_carlo_dashboard
render_timeline_dashboard = dashboards.render_timeline_dashboard
show_summary = dashboards.show_summary

build_balance_forecast = forecasting.build_balance_forecast
calculate_daily_safe_spend = forecasting.calculate_daily_safe_spend
calculate_forecast_summary = forecasting.calculate_forecast_summary
calculate_safe_spend = forecasting.calculate_safe_spend
MonteCarloConfig = monte_carlo_config.MonteCarloConfig
run_monte_carlo = risk.run_monte_carlo

handle_add_bill = workflows.handle_add_bill
handle_forecast = workflows.handle_forecast
handle_manage_income = workflows.handle_manage_income
handle_manage_payments = workflows.handle_manage_payments
handle_mark_paid = workflows.handle_mark_paid
handle_process_payday = workflows.handle_process_payday
handle_reconcile = workflows.handle_reconcile
handle_reporting = workflows.handle_reporting
handle_risk_outlook = workflows.handle_risk_outlook
handle_upcoming_schedule = workflows.handle_upcoming_schedule
handle_view_history = workflows.handle_view_history
manage_payments_menu = workflows.manage_payments_menu
process_payday_flow = workflows.process_payday_flow
reconcile_flow = workflows.reconcile_flow
reporting_menu = workflows.reporting_menu
run_onboarding = workflows.run_onboarding
view_history = workflows.view_history
view_upcoming_30 = workflows.view_upcoming_30


def main():
    db_manager.init_db()

    if not db_manager.is_onboarded():
        run_onboarding()

    while True:
        try:
            render_timeline_dashboard()
            options = [
                "1. Pay a Bill               (Subtract from balance)",
                "2. Record Paycheck          (Add to balance)",
                "3. Set Up a New Bill        (Schedule recurring expense)",
                "4. Manage My Bills          (Edit/Remove existing bills)",
                "5. Manage Income Sources    (Edit/Remove payroll info)",
                "6. Reconcile Account        (Manually fix bank balance)",
                "7. View Upcoming Schedule   (Next 30 days of bills)",
                "8. View Reports & Insights  (Spending breakdowns)",
                "9. View Recent Activity     (Last 15 transactions)",
                "10. View 90-Day Forecast    (Simulate future balance)",
                "11. View 90-Day Risk Outlook(Run Monte Carlo scenarios)",
                "12. Exit Application",
            ]
            cprint("\n--- WHAT WOULD YOU LIKE TO DO? ---", Theme.CYAN + Theme.BOLD)
            for opt in options:
                parts = opt.split("  ")
                label = parts[0]
                desc = parts[1] if len(parts) > 1 else ""
                print(f" {Theme.CYAN}{label:<28}{Theme.RESET}{Theme.DIM}{desc}{Theme.RESET}")

            choice = input(f"\n {Theme.BOLD}Select an action (1-12):{Theme.RESET} ").strip()
            if choice == "?":
                show_global_help()
                continue

            if choice == "1":
                handle_mark_paid()
            elif choice == "2":
                handle_process_payday()
            elif choice == "3":
                handle_add_bill()
            elif choice == "4":
                handle_manage_payments()
            elif choice == "5":
                handle_manage_income()
            elif choice == "6":
                handle_reconcile()
            elif choice == "7":
                handle_upcoming_schedule()
            elif choice == "8":
                handle_reporting()
            elif choice == "9":
                handle_view_history()
            elif choice == "10":
                handle_forecast()
            elif choice == "11":
                handle_risk_outlook()
            elif choice == "12":
                sys.exit(0)
            else:
                cprint(
                    f"\n [!] Invalid choice: '{choice}'. Please enter a number between 1 and 12.",
                    Theme.YELLOW,
                )
                wait_for_user()
        except Exception as exc:
            print(f"\n[ERROR] An unexpected error occurred: {exc}")
            print("The application will attempt to continue. If this persists, please contact support.")
            input("Press Enter to return to menu...")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
