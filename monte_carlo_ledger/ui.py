import os
from datetime import datetime
from typing import Any, Optional

from . import budget_engine


class Theme:
    CYAN = "\033[96m"
    GREEN = "\033[92m"
    YELLOW = "\033[93m"
    RED = "\033[91m"
    DIM = "\033[90m"
    BOLD = "\033[1m"
    ITALIC = "\033[3m"
    RESET = "\033[0m"


class CancelInput(Exception):
    """Raised when the user wants to cancel an input flow."""


def cprint(msg: str, color: str = "", end: str = "\n"):
    """Prints colored text safely."""
    print(f"{color}{msg}{Theme.RESET}", end=end)


def clear_screen():
    """Clears the terminal screen based on OS."""
    os.system("cls" if os.name == "nt" else "clear")


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
        return datetime.strptime(date_str, "%Y-%m-%d").strftime("%m-%d-%Y")
    except (ValueError, TypeError):
        return str(date_str)


def get_ordinal(n: int) -> str:
    """Returns the ordinal suffix (1st, 2nd, 3rd...)."""
    if 11 <= (n % 100) <= 13:
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def prompt_user(
    msg: str, validation_type: str = "string", default: Optional[str] = None
) -> Any:
    """Helper for robust input validation with deterministic cent parsing."""
    while True:
        hint = f"{Theme.DIM}['q' to cancel, '?' for help]{Theme.RESET}"
        default_hint = ""
        if default is not None:
            default_hint = f" {Theme.YELLOW}[default: {default}]{Theme.RESET}"

        prompt_text = f" {Theme.CYAN}»{Theme.RESET} {msg}{default_hint} {hint}: "

        try:
            val = input(prompt_text).strip()
        except EOFError as exc:
            raise CancelInput() from exc

        if val.lower() in ("?", "help"):
            show_global_help()
            continue

        if val.lower() in ("q", "quit", "cancel"):
            raise CancelInput()

        if not val and default is not None:
            val = str(default)

        if not val and validation_type != "optional":
            cprint(" (!) This field cannot be empty.", Theme.YELLOW)
            continue

        if validation_type == "money":
            try:
                clean_val = val.replace("$", "").replace(",", "").strip()
                cents = budget_engine.parse_money_input(clean_val)
                if cents < 0:
                    cprint(" (!) Amount must be non-negative.", Theme.YELLOW)
                    continue
                if cents == 0:
                    cprint(" (!) Amount cannot be zero.", Theme.YELLOW)
                    continue
                return cents
            except ValueError as exc:
                cprint(f" (!) Invalid amount: {exc}", Theme.RED)
        elif validation_type == "int":
            try:
                return int(val)
            except ValueError:
                cprint(" (!) Please enter a whole number.", Theme.YELLOW)
        elif validation_type == "due_day":
            try:
                day = int(val)
                if 1 <= day <= 31:
                    return day
                cprint(" (!) Day must be between 1 and 31.", Theme.YELLOW)
            except ValueError:
                cprint(" (!) Invalid day.", Theme.YELLOW)
        elif validation_type == "date":
            try:
                return budget_engine.normalize_date(val)
            except ValueError as exc:
                cprint(f" (!) Invalid date format: {exc}", Theme.RED)
        elif validation_type == "frequency":
            try:
                return budget_engine.normalize_frequency(val)
            except ValueError as exc:
                cprint(f" (!) {exc}", Theme.RED)
        else:
            return val
