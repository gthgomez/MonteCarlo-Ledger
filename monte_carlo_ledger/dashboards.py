from datetime import datetime

from . import budget_engine, db_manager, timeline_service
from .forecasting import (
    build_balance_forecast,
    calculate_daily_safe_spend,
    calculate_forecast_summary,
    calculate_safe_spend,
)
from .monte_carlo_config import MonteCarloConfig
from .risk import run_monte_carlo
from .ui import Theme, clear_screen, cprint, format_currency, format_date_display

build_financial_timeline = timeline_service.build_financial_timeline


def _render_balance_warning(ledger: int, stored: int, *, verbose: bool = False):
    cprint("\n" + "!" * 50, Theme.RED)
    cprint(" [!] WARNING: BANK RECORD MISMATCH", Theme.RED + Theme.BOLD)
    if verbose:
        print(f" Recorded Balance : {format_currency(stored)}")
        print(f" Transaction Sum : {format_currency(ledger)}")
    cprint(" Action Required: Please 'Reconcile Account' below.", Theme.YELLOW)
    cprint("!" * 50, Theme.RED)


def show_summary():
    """Displays the main dashboard with financial context."""
    clear_screen()
    is_sync, ledger, stored = db_manager.validate_balance_consistency()
    if not is_sync:
        _render_balance_warning(ledger, stored, verbose=True)

    balance_cents = stored
    income_sources = db_manager.get_all_income()

    cprint("\n" + "╔" + "═" * 48 + "╗", Theme.CYAN)
    cprint(
        f"║ {Theme.BOLD}{'MONTE CARLO LEDGER DASHBOARD':^46}{Theme.RESET}{Theme.CYAN} ║",
        Theme.CYAN,
    )
    cprint("╠" + "═" * 48 + "╣", Theme.CYAN)

    bal_color = Theme.GREEN if balance_cents >= 0 else Theme.RED
    print(
        f"{Theme.CYAN}║{Theme.RESET}  CURRENT BANK BALANCE: "
        f"{bal_color}{format_currency(balance_cents):<24}{Theme.RESET} {Theme.CYAN}║{Theme.RESET}"
    )

    if income_sources:
        soonest_source = min(income_sources, key=lambda x: x.next_payday)
        display_payday = format_date_display(soonest_source.next_payday)

        print(
            f"{Theme.CYAN}║{Theme.RESET}  Next payday ({soonest_source.name}): "
            f"{Theme.YELLOW}{display_payday:<18}{Theme.RESET} {Theme.CYAN}║{Theme.RESET}"
        )

        today = datetime.now().strftime("%Y-%m-%d")
        obs_cents = db_manager.get_obligations_total(today, soonest_source.next_payday)
        display_amt = (
            soonest_source.expected_amount
            if soonest_source.expected_amount is not None
            else soonest_source.amount
        )
        is_projected = soonest_source.expected_amount is not None
        disposable_cents = balance_cents - obs_cents

        cprint("╟" + "─" * 48 + "╢", Theme.CYAN)
        print(
            f"{Theme.CYAN}║{Theme.RESET}  Pending Bills (until payday): "
            f"{Theme.RED}{format_currency(-obs_cents):<17}{Theme.RESET} {Theme.CYAN}║{Theme.RESET}"
        )

        if is_projected:
            proj_hint = (
                f" {Theme.DIM}(Incl. {format_currency(display_amt)} projected income){Theme.RESET}"
            )
            cprint(f"║   {proj_hint:^46} ║", Theme.CYAN)
            disposable_cents += display_amt

        disp_color = Theme.GREEN if disposable_cents >= 0 else Theme.RED
        print(
            f"{Theme.CYAN}║{Theme.RESET}  » {Theme.BOLD}FREE TO SPEND:{Theme.RESET} "
            f"{disp_color}{format_currency(disposable_cents):<25}{Theme.RESET} "
            f"{Theme.CYAN}║{Theme.RESET}"
        )
        cprint(
            f"║    {Theme.DIM}(Safe amount to use without missing bills){Theme.RESET}"
            f"{Theme.CYAN}      ║",
            Theme.CYAN,
        )
    else:
        cprint(
            f"║  {Theme.DIM}(No income sources added yet){Theme.RESET}{Theme.CYAN}                 ║",
            Theme.CYAN,
        )
    cprint("╚" + "═" * 48 + "╝", Theme.CYAN)


def render_monte_carlo_dashboard(days_ahead: int = 90, runs: int = 500):
    """Renders the 90-Day Risk Outlook UI using Monte Carlo simulations."""
    clear_screen()
    is_sync, ledger, stored = db_manager.validate_balance_consistency()
    if not is_sync:
        _render_balance_warning(ledger, stored)

    balance_cents = stored
    base_timeline = build_financial_timeline(days_ahead)
    config = MonteCarloConfig(runs=runs)
    risk_summary = run_monte_carlo(balance_cents, base_timeline, config)

    cprint("=" * 48, Theme.CYAN)
    print(f"{Theme.BOLD}{days_ahead}-DAY RISK OUTLOOK{Theme.RESET}")
    cprint("=" * 48, Theme.CYAN)
    print()

    cprint("Simulation Runs", Theme.BOLD)
    print(f"{risk_summary['runs']}")
    print()

    cprint("Chance of Negative Balance", Theme.BOLD)
    prob = risk_summary["probability_negative"]
    prob_col = Theme.RED if prob > 0 else Theme.GREEN
    cprint(f"{prob:.0f}%", prob_col)
    print()

    cprint("Negative Runs", Theme.BOLD)
    cprint(f"{risk_summary['negative_runs']} / {risk_summary['runs']}", prob_col)
    print()

    cprint("Median Ending Balance", Theme.BOLD)
    m_end = risk_summary["median_ending_balance"]
    cprint(f"{format_currency(m_end)}", Theme.GREEN if m_end >= 0 else Theme.RED)
    print()

    cprint("Median Lowest Balance", Theme.BOLD)
    m_low = risk_summary["median_lowest_balance"]
    cprint(f"{format_currency(m_low)}", Theme.GREEN if m_low >= 0 else Theme.RED)
    print()

    cprint("Worst 10% Ending Balance", Theme.BOLD)
    w_end = risk_summary["worst_10_percent_ending_balance"]
    cprint(f"{format_currency(w_end)}", Theme.GREEN if w_end >= 0 else Theme.RED)
    print()

    if risk_summary["most_common_first_negative_date"]:
        cprint("Most Likely Trouble Date", Theme.BOLD)
        cprint(
            f"{format_date_display(risk_summary['most_common_first_negative_date'])}",
            Theme.RED,
        )
        print()
    else:
        cprint("No projected negative balance across simulated scenarios.", Theme.DIM)
        print()

    cprint("-" * 48, Theme.DIM)
    cprint("This is a probabilistic estimate based on:", Theme.DIM)
    cprint(f"- income variation: +/- {config.income_variation_max}%", Theme.DIM)
    cprint(
        f"- surprise expense chance: {int(config.surprise_probability * 100)}% every "
        f"{config.surprise_check_interval_days} days",
        Theme.DIM,
    )
    cprint(
        f"- surprise expense size: ${budget_engine.from_cents(config.surprise_amount_min)} "
        f"to ${budget_engine.from_cents(config.surprise_amount_max)}",
        Theme.DIM,
    )
    cprint("=" * 48, Theme.CYAN)


def render_forecast_dashboard(days_ahead: int = 90):
    """Renders the 90-Day Forecast Engine UI."""
    clear_screen()
    is_sync, ledger, stored = db_manager.validate_balance_consistency()
    if not is_sync:
        _render_balance_warning(ledger, stored)

    balance_cents = stored
    timeline = build_financial_timeline(days_ahead)
    forecast_rows = build_balance_forecast(balance_cents, timeline)
    summary = calculate_forecast_summary(balance_cents, forecast_rows)

    cprint("=" * 48, Theme.CYAN)
    print(f"{Theme.BOLD}{days_ahead}-DAY FORECAST{Theme.RESET}")
    print()

    cprint("Starting Balance", Theme.BOLD)
    print(f"{format_currency(summary['starting_balance'])}")
    print()

    cprint("Projected End Balance", Theme.BOLD)
    end_color = Theme.GREEN if summary["ending_balance"] >= 0 else Theme.RED
    cprint(f"{format_currency(summary['ending_balance'])}", end_color)
    print()

    cprint("Lowest Projected Balance", Theme.BOLD)
    low_col = Theme.GREEN if summary["lowest_balance"] >= 0 else Theme.RED
    if summary["lowest_balance_date"]:
        d_disp = format_date_display(summary["lowest_balance_date"])
        cprint(f"{format_currency(summary['lowest_balance'])} on {d_disp}", low_col)
    else:
        cprint(f"{format_currency(summary['lowest_balance'])}", low_col)
    print()

    cprint("First Negative Date", Theme.BOLD)
    if summary["first_negative_date"]:
        cprint(f"{format_date_display(summary['first_negative_date'])}", Theme.RED)
    else:
        cprint("No projected overdraft in the next 90 days", Theme.DIM)
    print()

    if summary["first_negative_date"]:
        cprint("-" * 48, Theme.DIM)
        cprint(
            f" ⚠ WARNING: Projected negative balance on "
            f"{format_date_display(summary['first_negative_date'])}",
            Theme.RED + Theme.BOLD,
        )

    cprint("-" * 48, Theme.DIM)
    print(f"{'Date':<10} {'Event':<16} {'Amount':<11} {'Balance After'}")

    for row in forecast_rows:
        date_disp = datetime.strptime(row["date"], "%Y-%m-%d").strftime("%m-%d-%Y")
        amt_color = Theme.GREEN if row["type"] == "income" else Theme.RED
        bal_color = Theme.GREEN if row["balance_after"] >= 0 else Theme.RED
        print(
            f"{date_disp:<10} {row['name']:<16} "
            f"{amt_color}{format_currency(row['amount']):<11}{Theme.RESET} "
            f"{bal_color}{format_currency(row['balance_after'])}{Theme.RESET}"
        )

    cprint("=" * 48, Theme.CYAN)


def render_timeline_dashboard():
    """Renders the main financial timeline dashboard."""
    clear_screen()
    is_sync, ledger, stored = db_manager.validate_balance_consistency()
    if not is_sync:
        _render_balance_warning(ledger, stored)

    balance_cents = stored
    timeline = build_financial_timeline(30)
    safe_spend = calculate_safe_spend(balance_cents, timeline)

    next_event = timeline[0] if timeline else None
    next_paycheck = None
    for event in timeline:
        if event["type"] == "income":
            next_paycheck = event
            break

    days_until_payday = 1
    if next_paycheck:
        payday_dt = datetime.strptime(next_paycheck["date"], "%Y-%m-%d").date()
        days_until_payday = max(1, (payday_dt - datetime.now().date()).days)

    daily_limit = calculate_daily_safe_spend(safe_spend, days_until_payday)

    cprint("=" * 48, Theme.CYAN)
    print(f"{Theme.BOLD}TODAY: {datetime.now().strftime('%b %d')}{Theme.RESET}")
    print()

    cprint("FREE TO SPEND", Theme.BOLD)
    disp_color = Theme.GREEN if safe_spend >= 0 else Theme.RED
    cprint(f"{format_currency(safe_spend)}", disp_color + Theme.BOLD)
    print()

    cprint("SAFE DAILY LIMIT (until next paycheck)", Theme.BOLD)
    limit_color = Theme.GREEN if daily_limit >= 0 else Theme.RED
    cprint(f"{format_currency(daily_limit)} / day", limit_color)
    print()

    if next_event:
        cprint("Next Event", Theme.BOLD)
        print(f"{next_event['name']} {format_currency(next_event['amount'])}")
        cprint(f"{format_date_display(next_event['date'])}", Theme.DIM)
        print()

    if next_paycheck:
        cprint("Next Paycheck", Theme.BOLD)
        print(f"{next_paycheck['name']} {format_currency(next_paycheck['amount'])}")
        cprint(f"{format_date_display(next_paycheck['date'])}", Theme.DIM)
        print()

    cprint("-" * 48, Theme.DIM)
    cprint("FINANCIAL TIMELINE", Theme.BOLD)
    print()

    for event in timeline[:10]:
        color = Theme.GREEN if event["type"] == "income" else Theme.RED
        date_disp = datetime.strptime(event["date"], "%Y-%m-%d").strftime("%b %d")
        print(
            f"{date_disp:<8} {event['name']:<14} "
            f"{color}{format_currency(event['amount']):>12}{Theme.RESET}"
        )

    cprint("=" * 48, Theme.CYAN)
