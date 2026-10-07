from datetime import date

from . import budget_engine, db_manager, decisions
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


def _daily_buffer(cents: int, days: int) -> int:
    """Presentation-only guide: a signed projected low point spread over days.

    Not a contract quantity; it never labels a deterministic low point as a
    spendable amount (MCD-0008).
    """
    if cents <= 0:
        return 0
    if days <= 0:
        return cents
    return cents // days


def show_summary(*, as_of: date):
    """Displays the main dashboard with financial context.

    ``as_of`` is captured once at the interactive boundary and threaded in;
    financial numbers come from the contract engine (MCD-0001, MCD-0008).
    """
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

        as_of_str = as_of.isoformat()
        obs_cents = db_manager.get_obligations_total(as_of_str, soonest_source.next_payday)
        try:
            payday = date.fromisoformat(soonest_source.next_payday)
        except ValueError:
            payday = as_of
        horizon = max((payday - as_of).days, 0)
        projected_low = decisions.forecast(as_of_str, horizon)["forecast"][
            "minimum_balance_cents"
        ]

        cprint("╟" + "─" * 48 + "╢", Theme.CYAN)
        print(
            f"{Theme.CYAN}║{Theme.RESET}  Pending Bills (until payday): "
            f"{Theme.RED}{format_currency(-obs_cents):<17}{Theme.RESET} {Theme.CYAN}║{Theme.RESET}"
        )

        low_color = Theme.GREEN if projected_low >= 0 else Theme.RED
        print(
            f"{Theme.CYAN}║{Theme.RESET}  » {Theme.BOLD}PROJECTED LOW POINT:{Theme.RESET} "
            f"{low_color}{format_currency(projected_low):<22}{Theme.RESET} "
            f"{Theme.CYAN}║{Theme.RESET}"
        )
        cprint(
            f"║    {Theme.DIM}(Lowest projected balance through payday){Theme.RESET}"
            f"{Theme.CYAN} ║",
            Theme.CYAN,
        )
    else:
        cprint(
            f"║  {Theme.DIM}(No income sources added yet){Theme.RESET}{Theme.CYAN}                 ║",
            Theme.CYAN,
        )
    cprint("╚" + "═" * 48 + "╝", Theme.CYAN)


def render_monte_carlo_dashboard(days_ahead: int = 90, runs: int = 500, *, as_of: date):
    """Renders the risk outlook UI from the contract risk block."""
    clear_screen()
    is_sync, ledger, stored = db_manager.validate_balance_consistency()
    if not is_sync:
        _render_balance_warning(ledger, stored)

    result = decisions.risk(as_of.isoformat(), days_ahead, {"runs": runs, "seed": 42})
    forecast = result["forecast"]
    risk = result["risk"]
    prob = risk["negative_balance_probability_ppm"] / 10_000.0

    cprint("=" * 48, Theme.CYAN)
    print(f"{Theme.BOLD}{days_ahead}-DAY RISK OUTLOOK{Theme.RESET}")
    cprint("=" * 48, Theme.CYAN)
    print()

    cprint("Simulation Runs", Theme.BOLD)
    print(f"{runs}")
    print()

    cprint("Chance of Negative Balance", Theme.BOLD)
    prob_col = Theme.RED if prob > 0 else Theme.GREEN
    cprint(f"{prob:.2f}%", prob_col)
    print()

    cprint("Projected Low Point (deterministic)", Theme.BOLD)
    low = forecast["minimum_balance_cents"]
    cprint(
        f"{format_currency(low)} on {format_date_display(forecast['minimum_balance_date'])}",
        Theme.GREEN if low >= 0 else Theme.RED,
    )
    print()

    cprint("Minimum Balance P10 (trough)", Theme.BOLD)
    p10 = risk["minimum_balance_p10_cents"]
    cprint(f"{format_currency(p10)}", Theme.GREEN if p10 >= 0 else Theme.RED)
    print()

    cprint("Safe to Spend (P10 trough minus reserve)", Theme.BOLD)
    safe = risk["safe_to_spend_cents"]
    cprint(f"{format_currency(safe)}", Theme.GREEN if safe >= 0 else Theme.RED)
    print()

    cprint("Median (P50) Minimum Balance", Theme.BOLD)
    p50_min = risk["minimum_balance_p50_cents"]
    cprint(f"{format_currency(p50_min)}", Theme.GREEN if p50_min >= 0 else Theme.RED)
    print()

    cprint("Median (P50) Ending Balance", Theme.BOLD)
    p50_end = risk["ending_balance_p50_cents"]
    cprint(f"{format_currency(p50_end)}", Theme.GREEN if p50_end >= 0 else Theme.RED)
    print()

    cprint("Ending Balance P10", Theme.BOLD)
    end10 = risk["ending_balance_p10_cents"]
    cprint(f"{format_currency(end10)}", Theme.GREEN if end10 >= 0 else Theme.RED)
    print()

    cprint("First Negative Date (deterministic)", Theme.BOLD)
    if forecast["first_negative_date"]:
        cprint(format_date_display(forecast["first_negative_date"]), Theme.RED)
    else:
        cprint("No projected negative balance in the deterministic forecast.", Theme.DIM)
    print()

    cprint("-" * 48, Theme.DIM)
    cprint("This is a probabilistic estimate based on:", Theme.DIM)
    cprint(
        f"- income variation: {SIMULATION_DEFAULTS['income_variation_min']}% to "
        f"{SIMULATION_DEFAULTS['income_variation_max']}%",
        Theme.DIM,
    )
    cprint(
        f"- surprise expense chance: "
        f"{SIMULATION_DEFAULTS['surprise_probability_ppm'] / 10_000:.2f}% every "
        f"{SIMULATION_DEFAULTS['surprise_check_interval_days']} days",
        Theme.DIM,
    )
    cprint(
        f"- surprise expense size: "
        f"${budget_engine.from_cents(SIMULATION_DEFAULTS['surprise_amount_min']):.2f} "
        f"to ${budget_engine.from_cents(SIMULATION_DEFAULTS['surprise_amount_max']):.2f}",
        Theme.DIM,
    )
    cprint("=" * 48, Theme.CYAN)


def render_forecast_dashboard(days_ahead: int = 90, *, as_of: date):
    """Renders the deterministic forecast UI from the contract forecast block."""
    clear_screen()
    is_sync, ledger, stored = db_manager.validate_balance_consistency()
    if not is_sync:
        _render_balance_warning(ledger, stored)

    detail = decisions.forecast_detail(as_of.isoformat(), days_ahead)
    summary = detail["forecast"]
    rows = detail["rows"]

    cprint("=" * 48, Theme.CYAN)
    print(f"{Theme.BOLD}{days_ahead}-DAY FORECAST{Theme.RESET}")
    print()

    cprint("Starting Balance", Theme.BOLD)
    print(f"{format_currency(stored)}")
    print()

    cprint("Projected End Balance", Theme.BOLD)
    end_color = Theme.GREEN if summary["ending_balance_cents"] >= 0 else Theme.RED
    cprint(f"{format_currency(summary['ending_balance_cents'])}", end_color)
    print()

    cprint("Lowest Projected Balance", Theme.BOLD)
    low_col = Theme.GREEN if summary["minimum_balance_cents"] >= 0 else Theme.RED
    d_disp = format_date_display(summary["minimum_balance_date"])
    cprint(f"{format_currency(summary['minimum_balance_cents'])} on {d_disp}", low_col)
    print()

    cprint("First Negative Date", Theme.BOLD)
    if summary["first_negative_date"]:
        cprint(format_date_display(summary["first_negative_date"]), Theme.RED)
    else:
        cprint(f"No projected overdraft in the next {days_ahead} days", Theme.DIM)
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

    for row in rows:
        date_disp = format_date_display(row["date"])
        amt_color = Theme.GREEN if row["type"] == "income" else Theme.RED
        bal_color = Theme.GREEN if row["balance_after_cents"] >= 0 else Theme.RED
        print(
            f"{date_disp:<10} {row['name']:<16} "
            f"{amt_color}{format_currency(row['amount_cents']):<11}{Theme.RESET} "
            f"{bal_color}{format_currency(row['balance_after_cents'])}{Theme.RESET}"
        )

    cprint("=" * 48, Theme.CYAN)


def render_timeline_dashboard(*, as_of: date):
    """Renders the main financial timeline dashboard from the contract forecast."""
    clear_screen()
    is_sync, ledger, stored = db_manager.validate_balance_consistency()
    if not is_sync:
        _render_balance_warning(ledger, stored)

    detail = decisions.forecast_detail(as_of.isoformat(), 30)
    summary = detail["forecast"]
    rows = detail["rows"]
    projected_low = summary["minimum_balance_cents"]

    next_event = rows[0] if rows else None
    next_paycheck = next((row for row in rows if row["type"] == "income"), None)

    days_until_payday = 1
    if next_paycheck:
        days_until_payday = max(1, (date.fromisoformat(next_paycheck["date"]) - as_of).days)

    daily_limit = _daily_buffer(projected_low, days_until_payday)

    cprint("=" * 48, Theme.CYAN)
    print(f"{Theme.BOLD}TODAY: {as_of.strftime('%b %d')}{Theme.RESET}")
    print()

    cprint("PROJECTED LOW POINT", Theme.BOLD)
    disp_color = Theme.GREEN if projected_low >= 0 else Theme.RED
    cprint(f"{format_currency(projected_low)}", disp_color + Theme.BOLD)
    cprint(f"on {format_date_display(summary['minimum_balance_date'])}", Theme.DIM)
    print()

    cprint("DAILY BUFFER GUIDE (until next paycheck)", Theme.BOLD)
    limit_color = Theme.GREEN if daily_limit >= 0 else Theme.RED
    cprint(f"{format_currency(daily_limit)} / day", limit_color)
    print()

    if next_event:
        cprint("Next Event", Theme.BOLD)
        print(f"{next_event['name']} {format_currency(next_event['amount_cents'])}")
        cprint(f"{format_date_display(next_event['date'])}", Theme.DIM)
        print()

    if next_paycheck:
        cprint("Next Paycheck", Theme.BOLD)
        print(f"{next_paycheck['name']} {format_currency(next_paycheck['amount_cents'])}")
        cprint(f"{format_date_display(next_paycheck['date'])}", Theme.DIM)
        print()

    cprint("-" * 48, Theme.DIM)
    cprint("FINANCIAL TIMELINE", Theme.BOLD)
    print()

    for event in rows[:10]:
        color = Theme.GREEN if event["type"] == "income" else Theme.RED
        date_disp = date.fromisoformat(event["date"]).strftime("%b %d")
        print(
            f"{date_disp:<8} {event['name']:<14} "
            f"{color}{format_currency(event['amount_cents']):>12}{Theme.RESET}"
        )

    cprint("=" * 48, Theme.CYAN)
