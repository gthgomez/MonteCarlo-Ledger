from datetime import datetime, timedelta

from . import db_manager
from .ui import CancelInput, Theme, clear_screen, cprint, prompt_user, wait_for_user


def run_onboarding():
    """First-time setup wizard for new users."""
    clear_screen()
    cprint("\n" + "═" * 50, Theme.CYAN)
    cprint(f" {Theme.BOLD}WELCOME TO YOUR MONTE CARLO LEDGER{Theme.RESET}", Theme.CYAN)
    cprint(" " + "═" * 50, Theme.CYAN)
    print("\n Real-time visibility into your finances.")
    print(" Track bills, predict paydays, and always know your")
    cprint(" 'FREE TO SPEND' amount to avoid overdrafts.", Theme.ITALIC)

    choice = input("\n Would you like a quick guided setup? (recommended) [Y/n]: ").strip().lower()
    if choice == "n":
        db_manager.set_onboarded(True)
        return

    try:
        cprint("\n--- STEP 1: INCOME ---", Theme.CYAN)
        print(" First, let's add your primary income source (Salary, etc.)")
        name = prompt_user("Income Name", default="Salary")
        amt = prompt_user(f"Average paycheck amount for {name}", "money")
        freq = prompt_user(
            "How often are you paid? (Weekly, Bi-weekly, Monthly)",
            "frequency",
            default="Bi-weekly",
        )
        last = prompt_user(
            "Date of your last paycheck (MM/DD/YYYY)",
            "date",
            default=datetime.now().strftime("%m/%d/%Y"),
        )
        db_manager.add_income_source(name, amt, freq, last)
        cprint(f"\n Success! {name} has been added.", Theme.GREEN)

        cprint("\n--- STEP 2: YOUR FIRST BILL ---", Theme.CYAN)
        print(" Now, let's add one recurring bill (Rent, Phone, etc.)")
        bill_name = prompt_user("Bill Name", default="Rent")
        bill_amt = prompt_user(f"Amount for {bill_name}", "money")
        bill_rec = prompt_user(
            "Recurrence (Monthly, Weekly, One-time)",
            "frequency",
            default="Monthly",
        )
        if bill_rec == "Monthly":
            bill_info = prompt_user("Day due (1-31)", "due_day", default="1")
        else:
            bill_info = prompt_user(
                "Date due (MM/DD/YYYY)",
                "date",
                default=(datetime.now() + timedelta(days=7)).strftime("%m/%d/%Y"),
            )

        db_manager.add_payment(bill_name, bill_amt, bill_rec, bill_info)
        cprint(f"\n Success! {bill_name} is now in your schedule.", Theme.GREEN)

        db_manager.set_onboarded(True)
        cprint("\n Setup complete! Transitioning to your dashboard...", Theme.CYAN)
        wait_for_user()
    except CancelInput:
        db_manager.set_onboarded(True)
        cprint("\n Setup skipped. You can add these later from the menu.", Theme.YELLOW)
        wait_for_user()
