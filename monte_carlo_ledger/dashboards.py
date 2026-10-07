"""Interactive terminal dashboards rendered from the canonical contract engine (MC-07).

Every financial number below originates in ``monte_carlo_ledger.dashboard_view`` (which runs
the Contract 1.x engine over an explicit ``as_of``). The only retained product heuristic is
the daily pacing guidance, which is labelled non-normative and derived from the canonical
projected low point. Rendering never reads a clock for financial placement.
"""

from datetime import date, datetime

from . import dashboard_view, db_manager
from .contract import SIMULATION_DEFAULTS
from .ui import Theme, clear_screen, cprint, format_currency, format_date_display


def _render_balance_warning(ledger: int, stored: int, *, verbose: bool = False):
    cprint("\n" + "!" * 50, Theme.RED)
    cprint(" [!] WARNING: BANK RECORD MISMATCH", Theme.RED + Theme.BOLD)
    if verbose:
        print(f" Recorded Balance : {format_currency(stored)}")
        print(f" Transaction Sum : {format_currency(ledger)}")
    cprint(" Action Required: Please 'Reconcile Account' below.", Theme.YELLOW)
    cprint("!" * 50, Theme.RED)


def _days_until(when: str, as_of: date) -> int:
    return max(1, (datetime.strptime(when, "%Y-%m-%d").date() - as_of).days)


def render_monte_carlo_dashboard(days_ahead: int = 90, runs: int = 500, *, as_of: date):
    """Renders the Risk Outlook from the canonical contract risk block (MCD-0008/0009)."""
    clear_screen()
    is_sync, ledger, stored = db_manager.validate_balance_consistency()
    if not is_sync:
        _render_balance_warning(ledger, stored)

    view = dashboard_view.build(as_of, days_ahead, runs=runs)
    result = view["result"]
    forecast = result["forecast"]
    risk = result["risk"]

    cprint("=" * 48, Theme.CYAN)
    print(f"{Theme.BOLD}{days_ahead}-DAY RISK OUTLOOK{Theme.RESET}")
    cprint("=" * 48, Theme.CYAN)
    print()

    ppm = risk["negative_balance_probability_ppm"]
    prob = ppm / 10_000
    negative_runs = (ppm * runs + 500_000) // 1_000_000
    prob_col = Theme.RED if prob > 0 else Theme.GREEN

    cprint("Simulation Runs", Theme.BOLD)
    print(f"{runs}")
    print()

    cprint("Chance of Negative Balance", Theme.BOLD)
    cprint(f"{prob:.0f}%", prob_col)
    print()

    cprint("Negative Runs", Theme.BOLD)
    cprint(f"{negative_runs} / {runs}", prob_col)
    print()

    cprint("Safe to Spend (10th percentile trough)", Theme.BOLD)
    safe = risk["safe_to_spend_cents"]
    cprint(f"{format_currency(safe)}", Theme.GREEN if safe >= 0 else Theme.RED)
    print()

    cprint("Projected Low Point (deterministic)", Theme.BOLD)
    low = forecast["minimum_balance_cents"]
    cprint(f"{format_currency(low)}", Theme.GREEN if low >= 0 else Theme.RED)
    print()

    cprint("Trough Percentiles (P10 / P50 / P90)", Theme.BOLD)
    for label, key in (("P10", "minimum_balance_p10_cents"), ("P50", "minimum_balance_p50_cents"), ("P90", "minimum_balance_p90_cents")):
        cprint(f"  {label}: {format_currency(risk[key])}", Theme.GREEN if risk[key] >= 0 else Theme.RED)
    print()

    if forecast["first_negative_date"]:
        cprint("Projected First Negative-Balance Date", Theme.BOLD)
        cprint(f"{format_date_display(forecast['first_negative_date'])}", Theme.RED)
        print()
    else:
        cprint("No projected negative balance across the deterministic plan.", Theme.DIM)
        print()

    cprint("-" * 48, Theme.DIM)
    cprint("This is a probabilistic estimate based on:", Theme.DIM)
    cprint(
        f"- income variation: {SIMULATION_DEFAULTS['income_variation_min']}% "
        f"to +{SIMULATION_DEFAULTS['income_variation_max']}%",
        Theme.DIM,
    )
    cprint(
        f"- surprise expense chance: {SIMULATION_DEFAULTS['surprise_probability_ppm'] / 10_000:.0f}% every "
        f"{SIMULATION_DEFAULTS['surprise_check_interval_days']} days",
        Theme.DIM,
    )
    cprint(
        f"- surprise expense size: ${SIMULATION_DEFAULTS['surprise_amount_min'] / 100:,.2f} "
        f"to ${SIMULATION_DEFAULTS['surprise_amount_max'] / 100:,.2f}",
        Theme.DIM,
    )
    cprint("=" * 48, Theme.CYAN)


def render_forecast_dashboard(days_ahead: int = 90, *, as_of: date):
    """Renders the Forecast Engine UI from the canonical forecast block."""
    clear_screen()
    is_sync, ledger, stored = db_manager.validate_balance_consistency()
    if not is_sync:
        _render_balance_warning(ledger, stored)

    view = dashboard_view.build(as_of, days_ahead)
    scenario = view["scenario"]
    result = view["result"]
    forecast = result["forecast"]
    rows = view["rows"]

    cprint("=" * 48, Theme.CYAN)
    print(f"{Theme.BOLD}{days_ahead}-DAY FORECAST{Theme.RESET}")
    print()

    cprint("Starting Balance", Theme.BOLD)
    print(f"{format_currency(scenario['starting_balance_cents'])}")
    print()

    cprint("Projected End Balance", Theme.BOLD)
    end_color = Theme.GREEN if forecast["ending_balance_cents"] >= 0 else Theme.RED
    cprint(f"{format_currency(forecast['ending_balance_cents'])}", end_color)
    print()

    cprint("Projected Low Point", Theme.BOLD)
    low_col = Theme.GREEN if forecast["minimum_balance_cents"] >= 0 else Theme.RED
    cprint(
        f"{format_currency(forecast['minimum_balance_cents'])} "
        f"on {format_date_display(forecast['minimum_balance_date'])}",
        low_col,
    )
    print()

    cprint("First Negative Date", Theme.BOLD)
    if forecast["first_negative_date"]:
        cprint(f"{format_date_display(forecast['first_negative_date'])}", Theme.RED)
    else:
        cprint(f"No projected overdraft in the next {days_ahead} days", Theme.DIM)
    print()

    if forecast["first_negative_date"]:
        cprint("-" * 48, Theme.DIM)
        cprint(
            f" ⚠ WARNING: Projected negative balance on "
            f"{format_date_display(forecast['first_negative_date'])}",
            Theme.RED + Theme.BOLD,
        )

    cprint("-" * 48, Theme.DIM)
    print(f"{'Date':<10} {'Event':<16} {'Amount':<11} {'Balance After'}")

    for row in rows:
        date_disp = datetime.strptime(row["date"], "%Y-%m-%d").strftime("%m-%d-%Y")
        amt_color = Theme.GREEN if row["type"] == "income" else Theme.RED
        bal_color = Theme.GREEN if row["balance_after"] >= 0 else Theme.RED
        print(
            f"{date_disp:<10} {row['name']:<16} "
            f"{amt_color}{format_currency(row['amount']):<11}{Theme.RESET} "
            f"{bal_color}{format_currency(row['balance_after'])}{Theme.RESET}"
        )

    cprint("=" * 48, Theme.CYAN)


def render_timeline_dashboard(*, as_of: date):
    """Renders the main financial timeline dashboard from the canonical forecast."""
    clear_screen()
    is_sync, ledger, stored = db_manager.validate_balance_consistency()
    if not is_sync:
        _render_balance_warning(ledger, stored)

    view = dashboard_view.build(as_of, 30)
    result = view["result"]
    rows = view["rows"]
    low_point = dashboard_view.projected_low_point(result)
    next_income = dashboard_view.next_income(rows)
    next_event = rows[0] if rows else None
    days_until_payday = _days_until(next_income["date"], as_of) if next_income else 30
    daily_limit = dashboard_view.daily_pacing_cents(low_point, days_until_payday)

    cprint("=" * 48, Theme.CYAN)
    print(f"{Theme.BOLD}TODAY: {as_of.strftime('%b %d')}{Theme.RESET}")
    print()

    cprint("PROJECTED LOW POINT (next 30 days)", Theme.BOLD)
    disp_color = Theme.GREEN if low_point >= 0 else Theme.RED
    cprint(f"{format_currency(low_point)}", disp_color + Theme.BOLD)
    print()

    cprint("DAILY PACING (guidance, not a contract value)", Theme.BOLD)
    limit_color = Theme.GREEN if daily_limit >= 0 else Theme.RED
    cprint(f"{format_currency(daily_limit)} / day", limit_color)
    print()

    if next_event:
        cprint("Next Event", Theme.BOLD)
        print(f"{next_event['name']} {format_currency(next_event['amount'])}")
        cprint(f"{format_date_display(next_event['date'])}", Theme.DIM)
        print()

    if next_income:
        cprint("Next Paycheck", Theme.BOLD)
        print(f"{next_income['name']} {format_currency(next_income['amount'])}")
        cprint(f"{format_date_display(next_income['date'])}", Theme.DIM)
        print()

    cprint("-" * 48, Theme.DIM)
    cprint("FINANCIAL TIMELINE", Theme.BOLD)
    print()

    for row in rows[:10]:
        color = Theme.GREEN if row["type"] == "income" else Theme.RED
        date_disp = datetime.strptime(row["date"], "%Y-%m-%d").strftime("%b %d")
        print(
            f"{date_disp:<8} {row['name']:<14} "
            f"{color}{format_currency(row['amount']):>12}{Theme.RESET}"
        )

    cprint("=" * 48, Theme.CYAN)
