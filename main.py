import sys
import os
from datetime import datetime, timedelta
import random
import math
from typing import Optional, Any, List, Dict
from collections import Counter

# Ensure local modules can be found
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.append(BASE_DIR)

import db_manager     # type: ignore[import-not-found]
import budget_engine  # type: ignore[import-not-found]
import timeline_service
from monte_carlo_config import MonteCarloConfig

# --- ANSI COLOR THEME ---
class Theme:
    CYAN = "\033[96m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    RED = "\033[91m"
    DIM = "\033[90m"
    BOLD = "\033[1m"
    ITALIC = "\033[3m"
    RESET = "\033[0m"

def cprint(msg: str, color: str = "", end: str = "\n"):
    """Prints colored text safely."""
    print(f"{color}{msg}{Theme.RESET}", end=end)

def clear_screen():
    """Clears the terminal screen based on OS."""
    os.system('cls' if os.name == 'nt' else 'clear')

def wait_for_user(message: str = "\n Press Enter to continue..."):
    """Pauses execution until the user presses enter."""
    input(f"{Theme.DIM}{message}{Theme.RESET}")

def show_global_help():
    """Displays a short reference for the user."""
    cprint("\n--- QUICK HELP GUIDE ---", Theme.CYAN)
    print(" 'q', 'quit', 'cancel' : Stop what you're doing and go back.")
    print(" '?' or 'help'         : Show this message.")
    print(" Enter / Blank         : Use the suggested [default] value.")
    print(" Amounts               : You can use $ or commas (e.g. $1,200.50).")
    print(" Dates/Days            : '15' means the 15th, 'next' or '+7' works too.")
    cprint("------------------------", Theme.CYAN)

def format_currency(cents: int) -> str:
    """Formats cents into a user-friendly string like +$45.99."""
    dollars = budget_engine.from_cents(cents)
    sign = "+" if cents > 0 else "-" if cents < 0 else ""
    return f"{sign}${abs(dollars):,.2f}"

def format_date_display(date_str: str) -> str:
    """Converts YYYY-MM-DD to MM-DD-YYYY."""
    try:
        return datetime.strptime(date_str, '%Y-%m-%d').strftime('%m-%d-%Y')
    except (ValueError, TypeError):
        return str(date_str)

def get_ordinal(n: int) -> str:
    """Returns the ordinal suffix (1st, 2nd, 3rd...)."""
    if 11 <= (n % 100) <= 13:
        suffix = 'th'
    else:
        suffix = {1: 'st', 2: 'nd', 3: 'rd'}.get(n % 10, 'th')
    return f"{n}{suffix}"

class CancelInput(Exception):
    """Raised when the user wants to cancel an input flow."""
    pass

def prompt_user(msg: str, validation_type: str = "string", default: Optional[str] = None) -> Any:
    """Helper for robust input validation with deterministic cent parsing."""
    while True:
        # Format the prompt with colors
        hint = f"{Theme.DIM}['q' to cancel, '?' for help]{Theme.RESET}"
        default_hint = f" {Theme.YELLOW}[default: {default}]{Theme.RESET}" if default is not None else ""
        
        prompt_text = f" {Theme.CYAN}»{Theme.RESET} {msg}{default_hint} {hint}: "
        
        try:
            val = input(prompt_text).strip()
        except EOFError:
            raise CancelInput()

        if val.lower() in ('?', 'help'):
            show_global_help()
            continue

        if val.lower() in ('q', 'quit', 'cancel'):
            raise CancelInput()
        
        if not val and default is not None:
            val = str(default)
        
        if not val and validation_type != "optional":
            cprint(" (!) This field cannot be empty.", Theme.YELLOW)
            continue
            
        if validation_type == "money":
            try:
                # Clean up input (strip $, commas)
                clean_val = val.replace('$', '').replace(',', '').strip()
                cents = budget_engine.parse_money_input(clean_val)
                if cents < 0:
                    cprint(" (!) Amount must be non-negative.", Theme.YELLOW)
                    continue
                if cents == 0:
                    cprint(" (!) Amount cannot be zero.", Theme.YELLOW)
                    continue
                return cents
            except ValueError as e:
                cprint(f" (!) Invalid amount: {e}", Theme.RED)
        elif validation_type == "int":
            try:
                return int(val)
            except ValueError:
                cprint(" (!) Please enter a whole number.", Theme.YELLOW)
        elif validation_type == "due_day":
            try:
                d = int(val)
                if 1 <= d <= 31: return d
                cprint(" (!) Day must be between 1 and 31.", Theme.YELLOW)
            except ValueError:
                cprint(" (!) Invalid day.", Theme.YELLOW)
        elif validation_type == "date":
            try:
                return budget_engine.normalize_date(val)
            except ValueError as e:
                cprint(f" (!) Invalid date format: {e}", Theme.RED)
        elif validation_type == "frequency":
            try:
                return budget_engine.normalize_frequency(val)
            except ValueError as e:
                cprint(f" (!) {e}", Theme.RED)
        else:
            return val

def show_summary():
    """Displays the main dashboard with financial context."""
    clear_screen()
    # Ledger validation
    is_sync, ledger, stored = db_manager.validate_balance_consistency()
    if not is_sync:
        cprint("\n" + "!" * 50, Theme.RED)
        cprint(" [!] WARNING: BANK RECORD MISMATCH", Theme.RED + Theme.BOLD)
        print(f" Recorded Balance : {format_currency(stored)}")
        print(f" Transaction Sum : {format_currency(ledger)}")
        cprint(" Action Required: Please 'Reconcile Account' below.", Theme.YELLOW)
        cprint("!" * 50, Theme.RED)

    balance_cents = stored
    income_sources = db_manager.get_all_income()
    
    cprint("\n" + "╔" + "═"*48 + "╗", Theme.CYAN)
    cprint(f"║ {Theme.BOLD}{'PERSONAL BUDGET DASHBOARD':^46}{Theme.RESET}{Theme.CYAN} ║", Theme.CYAN)
    cprint("╠" + "═"*48 + "╣", Theme.CYAN)
    
    bal_color = Theme.GREEN if balance_cents >= 0 else Theme.RED
    print(f"{Theme.CYAN}║{Theme.RESET}  CURRENT BANK BALANCE: {bal_color}{format_currency(balance_cents):<24}{Theme.RESET} {Theme.CYAN}║{Theme.RESET}")
    
    if income_sources:
        soonest_source = min(income_sources, key=lambda x: x.next_payday)
        display_payday = format_date_display(soonest_source.next_payday)
        
        print(f"{Theme.CYAN}║{Theme.RESET}  Next payday ({soonest_source.name}): {Theme.YELLOW}{display_payday:<18}{Theme.RESET} {Theme.CYAN}║{Theme.RESET}")
        
        today = datetime.now().strftime('%Y-%m-%d')
        obs_cents = db_manager.get_obligations_total(today, soonest_source.next_payday)
        
        # Use expected_amount if available for the soonest paycheck
        display_amt = soonest_source.expected_amount if soonest_source.expected_amount is not None else soonest_source.amount
        is_projected = soonest_source.expected_amount is not None
        
        disposable_cents = balance_cents - obs_cents
        
        cprint("╟" + "─"*48 + "╢", Theme.CYAN)
        print(f"{Theme.CYAN}║{Theme.RESET}  Pending Bills (until payday): {Theme.RED}{format_currency(-obs_cents):<17}{Theme.RESET} {Theme.CYAN}║{Theme.RESET}")
        
        if is_projected:
            proj_hint = f" {Theme.DIM}(Incl. {format_currency(display_amt)} projected income){Theme.RESET}"
            cprint(f"║   {proj_hint:^46} ║", Theme.CYAN)
            disposable_cents += display_amt

        disp_color = Theme.GREEN if disposable_cents >= 0 else Theme.RED
        print(f"{Theme.CYAN}║{Theme.RESET}  » {Theme.BOLD}FREE TO SPEND:{Theme.RESET} {disp_color}{format_currency(disposable_cents):<25}{Theme.RESET} {Theme.CYAN}║{Theme.RESET}")
        cprint(f"║    {Theme.DIM}(Safe amount to use without missing bills){Theme.RESET}{Theme.CYAN}      ║", Theme.CYAN)
    else:
        cprint(f"║  {Theme.DIM}(No income sources added yet){Theme.RESET}{Theme.CYAN}                 ║", Theme.CYAN)
    cprint("╚" + "═"*48 + "╝", Theme.CYAN)

def build_financial_timeline(days_ahead: int = 30, read_only: bool = False) -> List[Dict]:
    """
    Wrapper for timeline_service logic to maintain existing public API.
    """
    return timeline_service.build_financial_timeline(days_ahead, read_only=read_only)

def calculate_safe_spend(balance_cents: int, timeline_events: List[Dict]) -> int:
    """
    Implements running balance simulation to find the minimum point.
    This represents the maximum safe spend money before next income hits.
    """
    running_balance = balance_cents
    lowest_balance = balance_cents
    
    for event in timeline_events:
        running_balance += event['amount']
        if running_balance < lowest_balance:
            lowest_balance = running_balance
            
    return lowest_balance

def calculate_daily_safe_spend(safe_spend_cents: int, days_until_payday: int) -> int:
    """Calculates daily budget based on safe spend and days until payday."""
    if safe_spend_cents <= 0:
        return 0
    if days_until_payday <= 0:
        return safe_spend_cents
    return safe_spend_cents // days_until_payday

def build_balance_forecast(balance_cents: int, timeline_events: List[Dict]) -> List[Dict]:
    """
    Chronologically simuates balance progression across future events.
    Returns the enriched sequence array with 'balance_after' metric.
    """
    forecast_rows = []
    running_balance = balance_cents
    
    for event in timeline_events:
        running_balance += event['amount']
        
        forecast_rows.append({
            "date": event['date'],
            "name": event['name'],
            "type": event['type'],
            "amount": event['amount'],
            "balance_after": running_balance
        })
        
    return forecast_rows

def calculate_forecast_summary(balance_cents: int, forecast_rows: List[Dict]) -> Dict:
    """
    Computes summary metrics for a generated forecast.
    """
    lowest_balance = balance_cents
    lowest_balance_date = None
    first_negative_date = None
    ending_balance = balance_cents
    
    for row in forecast_rows:
        cur_bal = row['balance_after']
        ending_balance = cur_bal
        
        if cur_bal < lowest_balance:
            lowest_balance = cur_bal
            lowest_balance_date = row['date']
            
        if first_negative_date is None and cur_bal < 0:
            first_negative_date = row['date']
            
    return {
        "starting_balance": balance_cents,
        "lowest_balance": lowest_balance,
        "lowest_balance_date": lowest_balance_date,
        "ending_balance": ending_balance,
        "first_negative_date": first_negative_date
    }

def generate_scenario_timeline(base_timeline: List[Dict], rng: random.Random, config: MonteCarloConfig) -> List[Dict]:
    """
    Generates a Monte Carlo scenario timeline.
    Mutates amounts safely within integer bounds. Submits bounded synthetic surprise events.
    """
    scenario = []
    
    for event in base_timeline:
        new_event = event.copy() # Shallow copy is fine since dicts are flat
        if new_event['type'] == 'income':
            # Safe integer percentage math
            variation_percent = rng.randint(config.income_variation_min, config.income_variation_max)
            # Safe integer percentage math
            delta = (new_event['amount'] * variation_percent) // 100
            new_event['amount'] += delta
            # Ensure income doesn't accidentally become negative due to some weird edge case (though bounded by 8% it shouldn't)
            # Clamping to 0 represents a missed or delayed paycheck scenario.
            new_event['amount'] = max(0, new_event['amount'])
            
        scenario.append(new_event)
        
    # Surprise expenses
    if base_timeline:
        start_date = datetime.now()
        end_date = datetime.strptime(base_timeline[-1]['date'], '%Y-%m-%d')
        days_total = (end_date - start_date).days
        
        checks = days_total // config.surprise_check_interval_days
        for i in range(checks):
            if rng.random() < config.surprise_probability:
                surprise_day = start_date + timedelta(days=i * config.surprise_check_interval_days + rng.randint(0, config.surprise_check_interval_days - 1))
                if surprise_day <= end_date:
                    surprise_amt = rng.randint(config.surprise_amount_min, config.surprise_amount_max)
                    scenario.append({
                        "date": surprise_day.strftime('%Y-%m-%d'),
                        "name": "Unexpected Expense",
                        "amount": -surprise_amt,
                        "type": "bill",
                        "priority": 1
                    })
                    
    # Re-sort using explicit priority metric
    scenario.sort(key=lambda x: (x['date'], x['priority']))
    
    return scenario

def simulate_scenario(balance_cents: int, scenario_timeline: List[Dict]) -> Dict:
    """
    Simulates a generated scenario by reusing the deterministic forecast engine logic.
    """
    forecast_rows = build_balance_forecast(balance_cents, scenario_timeline)
    return calculate_forecast_summary(balance_cents, forecast_rows)

def run_monte_carlo(balance_cents: int, base_timeline: List[Dict], config: MonteCarloConfig = None) -> Dict:
    """
    Executes multiple scenarios and aggregates risk metrics deterministicly.
    """
    if config is None:
        config = MonteCarloConfig()
        
    rng = random.Random(config.seed)
    
    ending_balances = []
    lowest_balances = []
    negative_runs = 0
    negative_dates = []
    
    for _ in range(config.runs):
        scenario = generate_scenario_timeline(base_timeline, rng, config)
        res = simulate_scenario(balance_cents, scenario)
        
        ending_balances.append(res['ending_balance'])
        lowest_balances.append(res['lowest_balance'])
        
        if res['first_negative_date']:
            negative_runs += 1
            negative_dates.append(res['first_negative_date'])
            
    # Deterministic medians and percentiles
    ending_balances.sort()
    lowest_balances.sort()
    
    def get_median(sorted_list):
        if not sorted_list: return 0
        n = len(sorted_list)
        if n % 2 == 1:
            return sorted_list[n//2]
        else:
            return (sorted_list[n//2 - 1] + sorted_list[n//2]) // 2
            
    median_ending = get_median(ending_balances)
    median_lowest = get_median(lowest_balances)
    
    tenth_idx = max(0, math.ceil(config.worst_percentile * len(ending_balances)) - 1)
    worst_10_ending = ending_balances[tenth_idx] if ending_balances else 0
    
    # Calculate most common attributes
    most_common_neg_date = None
    window_start = None
    window_end = None
    
    if negative_dates:
        counter = Counter(negative_dates)
        most_common_neg_date = counter.most_common(1)[0][0]
        window_start = most_common_neg_date
        window_end = most_common_neg_date

    prob_neg = (negative_runs * 100) / config.runs if config.runs > 0 else 0

    return {
        "runs": config.runs,
        "probability_negative": prob_neg,
        "negative_runs": negative_runs,
        "median_ending_balance": median_ending,
        "median_lowest_balance": median_lowest,
        "worst_10_percent_ending_balance": worst_10_ending,
        "most_common_first_negative_date": most_common_neg_date,
        "most_common_negative_window": {
            "start": window_start,
            "end": window_end
        }
    }

def render_monte_carlo_dashboard(days_ahead: int = 90, runs: int = 500):
    """
    Renders the 90-Day Risk Outlook UI using Monte Carlo simulations.
    """
    clear_screen()
    
    # Consistency check
    is_sync, ledger, stored = db_manager.validate_balance_consistency()
    if not is_sync:
        cprint("\n" + "!" * 50, Theme.RED)
        cprint(" [!] WARNING: BANK RECORD MISMATCH", Theme.RED + Theme.BOLD)
        cprint(" Action Required: Please 'Reconcile Account' below.", Theme.YELLOW)
        cprint("!" * 50, Theme.RED)

    balance_cents = stored
    base_timeline = build_financial_timeline(days_ahead)
    
    # Run simulation
    config = MonteCarloConfig(runs=runs)
    risk_summary = run_monte_carlo(balance_cents, base_timeline, config)
    
    # --- RENDER ---
    cprint("="*48, Theme.CYAN)
    print(f"{Theme.BOLD}{days_ahead}-DAY RISK OUTLOOK{Theme.RESET}")
    cprint("="*48, Theme.CYAN)
    print()
    
    cprint("Simulation Runs", Theme.BOLD)
    print(f"{risk_summary['runs']}")
    print()
    
    cprint("Chance of Negative Balance", Theme.BOLD)
    prob = risk_summary['probability_negative']
    prob_col = Theme.RED if prob > 0 else Theme.GREEN
    cprint(f"{prob:.0f}%", prob_col)
    print()
    
    cprint("Negative Runs", Theme.BOLD)
    cprint(f"{risk_summary['negative_runs']} / {risk_summary['runs']}", prob_col)
    print()
    
    cprint("Median Ending Balance", Theme.BOLD)
    m_end = risk_summary['median_ending_balance']
    cprint(f"{format_currency(m_end)}", Theme.GREEN if m_end >= 0 else Theme.RED)
    print()
    
    cprint("Median Lowest Balance", Theme.BOLD)
    m_low = risk_summary['median_lowest_balance']
    cprint(f"{format_currency(m_low)}", Theme.GREEN if m_low >= 0 else Theme.RED)
    print()
    
    cprint("Worst 10% Ending Balance", Theme.BOLD)
    w_end = risk_summary['worst_10_percent_ending_balance']
    cprint(f"{format_currency(w_end)}", Theme.GREEN if w_end >= 0 else Theme.RED)
    print()
    
    if risk_summary['most_common_first_negative_date']:
        cprint("Most Likely Trouble Date", Theme.BOLD)
        cprint(f"{format_date_display(risk_summary['most_common_first_negative_date'])}", Theme.RED)
        print()
    else:
        cprint("No projected negative balance across simulated scenarios.", Theme.DIM)
        print()
        
    cprint("-" * 48, Theme.DIM)
    cprint("This is a probabilistic estimate based on:", Theme.DIM)
    cprint("- income variation: +/- " + str(config.income_variation_max) + "%", Theme.DIM)
    cprint("- surprise expense chance: " + str(int(config.surprise_probability * 100)) + "% every " + str(config.surprise_check_interval_days) + " days", Theme.DIM)
    cprint("- surprise expense size: $" + str(budget_engine.from_cents(config.surprise_amount_min)) + " to $" + str(budget_engine.from_cents(config.surprise_amount_max)), Theme.DIM)
    cprint("="*48, Theme.CYAN)

def render_forecast_dashboard(days_ahead: int = 90):
    """
    Renders the 90-Day Forecast Engine UI.
    """
    clear_screen()
    
    # Consistency check
    is_sync, ledger, stored = db_manager.validate_balance_consistency()
    if not is_sync:
        cprint("\n" + "!" * 50, Theme.RED)
        cprint(" [!] WARNING: BANK RECORD MISMATCH", Theme.RED + Theme.BOLD)
        cprint(" Action Required: Please 'Reconcile Account' below.", Theme.YELLOW)
        cprint("!" * 50, Theme.RED)

    balance_cents = stored
    timeline = build_financial_timeline(days_ahead)
    forecast_rows = build_balance_forecast(balance_cents, timeline)
    summary = calculate_forecast_summary(balance_cents, forecast_rows)
    
    # --- RENDER SUMMARY ---
    cprint("="*48, Theme.CYAN)
    print(f"{Theme.BOLD}{days_ahead}-DAY FORECAST{Theme.RESET}")
    print()
    
    cprint("Starting Balance", Theme.BOLD)
    print(f"{format_currency(summary['starting_balance'])}")
    print()
    
    cprint("Projected End Balance", Theme.BOLD)
    cprint(f"{format_currency(summary['ending_balance'])}", Theme.GREEN if summary['ending_balance'] >= 0 else Theme.RED)
    print()
    
    cprint("Lowest Projected Balance", Theme.BOLD)
    low_col = Theme.GREEN if summary['lowest_balance'] >= 0 else Theme.RED
    if summary['lowest_balance_date']:
        d_disp = format_date_display(summary['lowest_balance_date'])
        cprint(f"{format_currency(summary['lowest_balance'])} on {d_disp}", low_col)
    else:
        cprint(f"{format_currency(summary['lowest_balance'])}", low_col)
    print()
    
    cprint("First Negative Date", Theme.BOLD)
    if summary['first_negative_date']:
        cprint(f"{format_date_display(summary['first_negative_date'])}", Theme.RED)
    else:
        cprint("No projected overdraft in the next 90 days", Theme.DIM)
    print()
    
    # --- RENDER WARNING ---
    if summary['first_negative_date']:
        cprint("-" * 48, Theme.DIM)
        cprint(f" ⚠ WARNING: Projected negative balance on {format_date_display(summary['first_negative_date'])}", Theme.RED + Theme.BOLD)
    
    # --- RENDER TABLE ---
    cprint("-" * 48, Theme.DIM)
    print(f"{'Date':<10} {'Event':<16} {'Amount':<11} {'Balance After'}")
    
    for row in forecast_rows:
        date_disp = datetime.strptime(row['date'], '%Y-%m-%d').strftime('%m-%d-%Y')
        amt_color = Theme.GREEN if row['type'] == 'income' else Theme.RED
        bal_color = Theme.GREEN if row['balance_after'] >= 0 else Theme.RED
        print(f"{date_disp:<10} {row['name']:<16} {amt_color}{format_currency(row['amount']):<11}{Theme.RESET} {bal_color}{format_currency(row['balance_after'])}{Theme.RESET}")
        
    cprint("="*48, Theme.CYAN)

def render_timeline_dashboard():
    """
    Renders the new Financial Timeline Dashboard.
    """
    clear_screen()
    
    # Consistency check
    is_sync, ledger, stored = db_manager.validate_balance_consistency()
    if not is_sync:
        cprint("\n" + "!" * 50, Theme.RED)
        cprint(" [!] WARNING: BANK RECORD MISMATCH", Theme.RED + Theme.BOLD)
        cprint(" Action Required: Please 'Reconcile Account' below.", Theme.YELLOW)
        cprint("!" * 50, Theme.RED)

    balance_cents = stored
    timeline = build_financial_timeline(30)
    
    # Calculate Safe Spend
    safe_spend = calculate_safe_spend(balance_cents, timeline)
    
    # Financial Timeline Construction
    # Find next event and next paycheck
    next_event = timeline[0] if timeline else None
    next_paycheck = None
    
    for event in timeline:
        if not next_paycheck and event['type'] == 'income':
            next_paycheck = event
        if next_paycheck:
            break
            
    # Days until next paycheck
    days_until_payday = 1
    if next_paycheck:
        payday_dt = datetime.strptime(next_paycheck['date'], '%Y-%m-%d').date()
        days_until_payday = max(1, (payday_dt - datetime.now().date()).days)
        
    daily_limit = calculate_daily_safe_spend(safe_spend, days_until_payday)
    
    # --- RENDER ---
    cprint("="*48, Theme.CYAN)
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
    
    for event in timeline[:10]: # Show next 10 events
        color = Theme.GREEN if event['type'] == 'income' else Theme.RED
        date_disp = datetime.strptime(event['date'], '%Y-%m-%d').strftime('%b %d')
        print(f"{date_disp:<8} {event['name']:<14} {color}{format_currency(event['amount']):>12}{Theme.RESET}")
        
    cprint("="*48, Theme.CYAN)

def run_onboarding():
    """First-time setup wizard for new users."""
    os.system('cls' if os.name == 'nt' else 'clear')
    cprint("\n" + "═"*50, Theme.CYAN)
    cprint(f" {Theme.BOLD}WELCOME TO YOUR PERSONAL BUDGET TRACKER{Theme.RESET}", Theme.CYAN)
    cprint(" " + "═"*50, Theme.CYAN)
    print("\n Real-time visibility into your finances.")
    print(" Track bills, predict paydays, and always know your")
    cprint(" 'FREE TO SPEND' amount to avoid overdrafts.", Theme.ITALIC)
    
    choice = input(f"\n Would you like a quick guided setup? (recommended) [Y/n]: ").strip().lower()
    if choice == 'n':
        db_manager.set_onboarded(True)
        return

    try:
        cprint("\n--- STEP 1: INCOME ---", Theme.CYAN)
        print(" First, let's add your primary income source (Salary, etc.)")
        name = prompt_user("Income Name", default="Salary")
        amt = prompt_user(f"Average paycheck amount for {name}", "money")
        freq = prompt_user("How often are you paid? (Weekly, Bi-weekly, Monthly)", "frequency", default="Bi-weekly")
        last = prompt_user("Date of your last paycheck (MM/DD/YYYY)", "date", default=datetime.now().strftime('%m/%d/%Y'))
        db_manager.add_income_source(name, amt, freq, last)
        cprint(f"\n Success! {name} has been added.", Theme.GREEN)

        cprint("\n--- STEP 2: YOUR FIRST BILL ---", Theme.CYAN)
        print(" Now, let's add one recurring bill (Rent, Phone, etc.)")
        bill_name = prompt_user("Bill Name", default="Rent")
        bill_amt = prompt_user(f"How much is {bill_name}?", "money")
        bill_rec = prompt_user("How often is it due?", "frequency", default="Monthly")
        
        if bill_rec == 'Monthly':
            bill_info = prompt_user("What day of the month? (1-31)", "due_day", default="1")
        else:
            bill_info = prompt_user("When is it next due? (MM/DD/YYYY)", "date", default=(datetime.now() + timedelta(days=7)).strftime('%m/%d/%Y'))
        
        db_manager.add_payment(bill_name, bill_amt, bill_rec, bill_info)
        cprint(f"\n Success! {bill_name} is now in your schedule.", Theme.GREEN)

        db_manager.set_onboarded(True)
        cprint("\n Setup complete! Transitioning to your dashboard...", Theme.CYAN)
        input(" Press Enter to continue...")
        
    except CancelInput:
        cprint("\n Setup skipped. You can add these later from the menu.", Theme.YELLOW)
        db_manager.set_onboarded(True)
        input(" Press Enter...")

def handle_mark_paid():
    try:
        clear_screen()
        payments = db_manager.get_all_payments()
        if not payments:
            print("\n(!) You don't have any bills saved.")
            return
        
        print("\n--- Select a Bill to Pay ---")
        for i, p in enumerate(payments, 1):
            print(f" {i}. {p.name} ({format_currency(-p.amount)})")
        
        idx = prompt_user("Which bill did you pay?", "int")
        if 1 <= idx <= len(payments):
            p = payments[idx-1]
            occurrence = db_manager.get_next_unpaid_occurrence(p.id)
            
            if not occurrence:
                print(f"\n[Note] No scheduled 'unpaid' records found for {p.name}.")
                if input("Log as a new manual transaction? (y/n): ").lower() != 'y':
                    return
            else:
                print(f"Marking the bill due on {format_date_display(occurrence.due_date)} as paid.")

            amt = prompt_user(f"Amount paid for {p.name}", "money", default=f"{budget_engine.from_cents(p.amount):.2f}")
            cat = prompt_user("Reporting Category", default="Bills")
            date_str = occurrence.due_date if occurrence else datetime.now().strftime('%Y-%m-%d')
            
            txn_id = db_manager.add_transaction(-amt, cat, f"Paid {p.name}", t_type='Expense', date_str=date_str)
            
            if occurrence:
                db_manager.mark_occurrence_paid(occurrence.id, txn_id)
            
            if p.recurrence == 'One-time':
                cprint(f"\n This was a one-time bill. Would you like to remove '{p.name}' from your list of bills?", Theme.CYAN)
                if input(" Delete it? (y/n): ").lower() == 'y':
                    db_manager.delete_payment(p.id)
                    cprint(" Bill removed.", Theme.DIM)
            cprint("\n Success: Payment recorded! ✅", Theme.GREEN)
            wait_for_user()
            wait_for_user()
    except CancelInput:
        print("\n(Cancelled)")

def handle_process_payday():
    try:
        process_payday_flow()
    except CancelInput:
        print("\n(Cancelled)")

def handle_add_bill():
    try:
        cprint("\n--- Add a Repeating Bill or One-Time Expense ---", Theme.CYAN)
        name = prompt_user("What is the name of this bill? (e.g., Rent, Electric)")
        amt = prompt_user(f"How much is {name}?", "money")
        rec = prompt_user("How often does this repeat? (Monthly, Weekly, One-time)", "frequency", default="Monthly")
        
        if rec == 'Monthly':
            info = prompt_user("Which day of the month is it due? (Examples: 1, 15, 31)", "due_day")
        else:
            info = prompt_user("When is it due? (Examples: MM/DD, 03/20, next, +7)", "date")
            
        db_manager.add_payment(name, amt, rec, info)
        cprint(f"\n Success: {name} has been added to your schedule! 🎉", Theme.GREEN)
        wait_for_user()
    except CancelInput:
        cprint("\n (Cancelled)", Theme.YELLOW)

def handle_manage_payments():
    try:
        manage_payments_menu()
    except CancelInput:
        print("\n(Cancelled)")

def handle_manage_income():
    while True:
        try:
            clear_screen()
            cprint("\n--- Manage Your Income Sources ---", Theme.CYAN)
            sources = db_manager.get_all_income()
            if sources:
                for i, s in enumerate(sources, 1):
                    payday_hint = f"(Next: {format_date_display(s.next_payday)})"
                    print(f" {i}. {s.name}: {format_currency(s.amount)} ({s.frequency}) {Theme.DIM}{payday_hint}{Theme.RESET}")
            else:
                cprint("(No income sources found yet.)", Theme.DIM)
            
            cprint("\n1. Add a New Income Source", Theme.CYAN)
            cprint("2. Plan Next Paycheck Hours/Amount", Theme.CYAN)
            cprint("3. Edit an Existing Source", Theme.CYAN)
            cprint("4. Remove an Existing Source", Theme.CYAN)
            cprint("5. Return to Main Menu", Theme.CYAN)
            sub = input("\nChoice: ").strip()
            
            if sub == '1':
                name = prompt_user("Income Name (e.g. Work, Rental)")
                amt = prompt_user("Standard paycheck amount", "money")
                freq = prompt_user("Frequency (Weekly, Bi-weekly, Monthly)", "frequency")
                last = prompt_user("Date of your last paycheck", "date")
                db_manager.add_income_source(name, amt, freq, last)
                cprint(f"\n Success: {name} added.", Theme.GREEN)
                wait_for_user()
            elif sub == '2':
                if not sources:
                    cprint("\n (!) Add an income source first.", Theme.YELLOW)
                    continue
                idx = prompt_user("Which paycheck are you planning for?", "int")
                if 1 <= idx <= len(sources):
                    s = sources[idx-1]
                    cprint(f"\n--- Planning for {s.name} on {format_date_display(s.next_payday)} ---", Theme.CYAN)
                    print(f" (Current default: {format_currency(s.amount)})")
                    
                    mode = input(" Do you want to enter [H]ours or a flat [A]mount? ").strip().lower()
                    if mode == 'h':
                        rate = prompt_user("Hourly Rate", "money")
                        hours = prompt_user("Estimated Hours", "int")
                        proj_cents = rate * hours
                    else:
                        proj_cents = prompt_user("Projected Amount", "money")
                    
                    db_manager.update_income_source(s.id, s.name, s.amount, s.frequency, s.last_payday, s.next_payday, proj_cents)
                    cprint(f"\n Success: Next paycheck projected at {format_currency(proj_cents)}.", Theme.GREEN)
                    wait_for_user()
            elif sub == '3':
                if not sources:
                    cprint("\n (!) No sources to edit.", Theme.YELLOW)
                    continue
                idx = prompt_user("Which item should be edited?", "int")
                if 1 <= idx <= len(sources):
                    s = sources[idx-1]
                    name = prompt_user("New Name", default=s.name)
                    amt = prompt_user("New Amount", "money", default=f"{budget_engine.from_cents(s.amount):.2f}")
                    freq = prompt_user("New Frequency", "frequency", default=s.frequency)
                    last = prompt_user("Date of your last paycheck (MM/DD/YYYY)", "date", default=format_date_display(s.last_payday))
                    
                    # Force recalculation of next payday
                    next_p = budget_engine.get_next_payday(last, freq)
                    
                    db_manager.update_income_source(s.id, name, amt, freq, last, next_p)
                    cprint(f"\n Success: {name} updated. Next payday: {format_date_display(next_p)} ✅", Theme.GREEN)
                    wait_for_user()
            elif sub == '4':
                if not sources:
                    cprint("\n (!) No sources to remove.", Theme.YELLOW)
                    continue
                idx = prompt_user("Which item should be removed?", "int")
                if 1 <= idx <= len(sources):
                    s = sources[idx-1]
                    db_manager.delete_income_source(s.id)
                    cprint(f"\n Success: {s.name} removed.", Theme.GREEN)
                    wait_for_user()
            elif sub == '5':
                break
            else:
                cprint("\n (!) Invalid choice.", Theme.YELLOW)
                wait_for_user()
        except CancelInput:
            break

def handle_reconcile():
    try:
        reconcile_flow()
    except CancelInput:
        print("\n(Cancelled)")

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

def manage_payments_menu():
    while True:
        try:
            clear_screen()
            print("\n--- Manage Payments ---")
            payments = db_manager.get_all_payments()
            if not payments:
                print("No payments found.")
                break
            for i, p in enumerate(payments, 1):
                info = f"Day {get_ordinal(p.due_day)}" if p.recurrence == 'Monthly' else format_date_display(p.due_date)
                print(f" {i}. {p.name}: {format_currency(p.amount)} ({p.recurrence} - {info})")
            
            print("\n1. Edit Payment")
            print("2. Delete Payment")
            print("3. Back")
            choice = input("\nChoice: ").strip()
            if choice == '1':
                idx = prompt_user("Enter number to edit", "int")
                if 1 <= idx <= len(payments):
                    p = payments[idx-1]
                    name = prompt_user("New Name", default=p.name)
                    amount = prompt_user("New Amount", "money", default=f"{budget_engine.from_cents(p.amount):.2f}")
                    rec = prompt_user("New Recurrence", "frequency", default=p.recurrence)
                    due = prompt_user("Due day/date", "due_day" if rec == 'Monthly' else "date", 
                                    default=str(p.due_day) if rec == 'Monthly' else p.due_date)
                    db_manager.update_payment(p.id, name, amount, rec, due)
                    cprint(" Success: Updated!", Theme.GREEN)
                    wait_for_user()
            elif choice == '2':
                idx = prompt_user("Enter number to delete", "int")
                if 1 <= idx <= len(payments):
                    p = payments[idx-1]
                    if input(f" Delete '{p.name}'? (y/n): ").lower() == 'y':
                        db_manager.delete_payment(p.id)
                        cprint(" Deleted.", Theme.DIM)
                        wait_for_user()
            elif choice == '3':
                break
            else:
                cprint("\n (!) Invalid choice.", Theme.YELLOW)
                wait_for_user()
        except CancelInput:
            break

def reconcile_flow():
    while True:
        try:
            clear_screen()
            print("\n--- Reconcile Bank Balance ---")
            ledger_bal = db_manager.get_ledger_balance()
            stored_bal = db_manager.get_stored_balance()
            print(f" Ledger Sum:    {format_currency(ledger_bal)}")
            if ledger_bal != stored_bal:
                print(f" Stored Balance: {format_currency(stored_bal)} (MISMATCH)")
            
            print("\n 1. Enter Actual Bank Balance (Create adjustment)")
            print(" 2. Sync Stored Balance to Ledger Sum")
            print(" 3. Back")
            choice = input("\n Choice: ").strip()
            
            if choice == '1':
                actual_cents = prompt_user("Enter actual CURRENT bank balance", "money")
                delta = actual_cents - ledger_bal
                if delta == 0:
                    cprint(" Ledger sum already matches bank.", Theme.GREEN)
                    wait_for_user()
                else:
                    reason = prompt_user("Reason for correction", default="Reconciliation adjustment")
                    db_manager.add_transaction(delta, "Adjustment", f"{reason} ({format_currency(delta)})", t_type='Adjustment')
                    db_manager.sync_stored_balance()
                    cprint(f" Success: Ledger corrected by {format_currency(delta)}.", Theme.GREEN)
                    wait_for_user()
            elif choice == '2':
                db_manager.sync_stored_balance()
                cprint(" Success: Stored balance synced to ledger.", Theme.GREEN)
                wait_for_user()
            elif choice == '3':
                break
            else:
                cprint("\n (!) Invalid choice.", Theme.YELLOW)
                wait_for_user()
        except CancelInput:
            break

def process_payday_flow():
    clear_screen()
    income_sources = db_manager.get_all_income()
    if not income_sources:
        print("No income sources found.")
        return
    
    print("\n--- Process Payday ---")
    for i, inc in enumerate(income_sources, 1):
        print(f" {i}. {inc.name} ({format_currency(inc.amount)}) - Next: {format_date_display(inc.next_payday)}")
    print(f" {len(income_sources) + 1}. Back")
    
    choice = prompt_user("Select source to process", "int")
    if 1 <= choice <= len(income_sources):
        inc = income_sources[choice - 1]
        payday_date = inc.next_payday
        print(f"\n Processing payday for {Theme.CYAN}{inc.name}{Theme.RESET}")
        
        # Use expected_amount as default if set
        default_amt = inc.expected_amount if inc.expected_amount is not None else inc.amount
        amt = prompt_user("Actual amount received", "money", default=f"{budget_engine.from_cents(default_amt):.2f}")
        
        if input(f" Confirm deposit of {format_currency(amt)}? (y/n): ").lower() == 'y':
            db_manager.add_transaction(amt, "Income", f"Paycheck: {inc.name}", t_type='Income', date_str=payday_date)
            new_next = budget_engine.get_next_payday(payday_date, inc.frequency)
            # Clear expected_amount after processing
            db_manager.update_income_source(inc.id, inc.name, inc.amount, inc.frequency, payday_date, new_next, expected_amount=None)
            cprint(" Paycheck recorded! 💰", Theme.GREEN)
            wait_for_user()
    elif choice == len(income_sources) + 1: return

def view_upcoming_30():
    print("\n--- Upcoming Bills Schedule (30 Days) ---")
    payments = [dict(vars(p)) for p in db_manager.get_all_payments()]
    today_str = datetime.now().strftime('%Y-%m-%d')
    end_str = (datetime.now() + timedelta(days=30)).strftime('%Y-%m-%d')
    schedule = budget_engine.get_upcoming_schedule(payments, today_str, end_str)
    if not schedule:
        print("No bills found.")
    else:
        print(f"{'Due Date':<12} {'Amount':<10} {'Recurrence':<12} {'Name'}")
        print("-" * 50)
        for item in schedule:
            d = format_date_display(item['date'])
            print(f"{d:<12} ${budget_engine.from_cents(item['amount']):<9,.2f} {item['recurrence']:<12} {item['name']}")

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
        if choice in ('1', '2'):
            days = 30 if choice == '1' else None
            data = db_manager.get_spend_by_category(days)
            print(f"\n--- Spending Breakdown ({'30 Days' if days else 'All Time'}) ---")
            if not data: print("No expenses recorded.")
            else:
                for row in data:
                    print(f" {row['category']:<20}: ${budget_engine.from_cents(abs(row['total'])):,.2f}")
        elif choice in ('3', '4'):
            days = 30 if choice == '3' else None
            summary = db_manager.get_flow_summary(days)
            print(f"\n--- Cash Flow Summary ({'30 Days' if days else 'All Time'}) ---")
            print(f" Total Inflows : {format_currency(summary['inflow'])}")
            print(f" Total Outflows: {format_currency(-summary['outflow'])}")
            print(f" Net Change    : {format_currency(summary['inflow'] - summary['outflow'])}")
        elif choice == '5':
            adjs = db_manager.get_adjustment_history()
            print("\n--- Recent Reconciliation Adjustments ---")
            if not adjs: print("No adjustments found.")
            else:
                for a in adjs:
                    print(f" {format_date_display(a.date)}: {format_currency(a.amount):<12} | {a.description}")
        elif choice == '6': break

def view_history():
    print("\n--- Recent Transactions ---")
    history = db_manager.get_transaction_history(15)
    if not history: print("No transactions.")
    else:
        print(f"{'Date':<12} {'Type':<12} {'Amount':<12} {'Description'}")
        print("-" * 55)
        for h in history:
            d = format_date_display(h.date)
            print(f"{d:<12} {h.type:<12} {format_currency(h.amount):<12} {h.description}")

def main():
    db_manager.init_db()
    
    # Check for onboarding
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
                "12. Exit Application"
            ]
            cprint("\n--- WHAT WOULD YOU LIKE TO DO? ---", Theme.CYAN + Theme.BOLD)
            for opt in options: 
                parts = opt.split("  ")
                label = parts[0]
                desc = parts[1] if len(parts) > 1 else ""
                print(f" {Theme.CYAN}{label:<28}{Theme.RESET}{Theme.DIM}{desc}{Theme.RESET}")
            
            choice = input(f"\n {Theme.BOLD}Select an action (1-12):{Theme.RESET} ").strip()
            if choice == '?':
                show_global_help()
                continue
            
            if choice == '1': handle_mark_paid()
            elif choice == '2': handle_process_payday()
            elif choice == '3': handle_add_bill()
            elif choice == '4': handle_manage_payments()
            elif choice == '5': handle_manage_income()
            elif choice == '6': handle_reconcile()
            elif choice == '7': handle_upcoming_schedule()
            elif choice == '8': handle_reporting()
            elif choice == '9': handle_view_history()
            elif choice == '10': handle_forecast()
            elif choice == '11': handle_risk_outlook()
            elif choice == '12': sys.exit(0)
            else:
                cprint(f"\n [!] Invalid choice: '{choice}'. Please enter a number between 1 and 12.", Theme.YELLOW)
                wait_for_user()
        except Exception as e:
            print(f"\n[ERROR] An unexpected error occurred: {e}")
            print("The application will attempt to continue. If this persists, please contact support.")
            input("Press Enter to return to menu...")

if __name__ == "__main__":
    try: main()
    except KeyboardInterrupt: sys.exit(0)
