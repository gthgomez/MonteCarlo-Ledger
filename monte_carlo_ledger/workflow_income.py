from . import budget_engine, db_manager
from .ui import (
    CancelInput,
    Theme,
    clear_screen,
    cprint,
    format_currency,
    format_date_display,
    prompt_user,
    wait_for_user,
)


def handle_process_payday():
    try:
        process_payday_flow()
    except CancelInput:
        print("\n(Cancelled)")


def handle_manage_income():
    while True:
        try:
            clear_screen()
            cprint("\n--- Manage Your Income Sources ---", Theme.CYAN)
            sources = db_manager.get_all_income()
            if sources:
                for i, source in enumerate(sources, 1):
                    payday_hint = f"(Next: {format_date_display(source.next_payday)})"
                    print(
                        f" {i}. {source.name}: {format_currency(source.amount)} "
                        f"({source.frequency}) {Theme.DIM}{payday_hint}{Theme.RESET}"
                    )
            else:
                cprint("(No income sources found yet.)", Theme.DIM)

            cprint("\n1. Add a New Income Source", Theme.CYAN)
            cprint("2. Plan Next Paycheck Hours/Amount", Theme.CYAN)
            cprint("3. Edit an Existing Source", Theme.CYAN)
            cprint("4. Remove an Existing Source", Theme.CYAN)
            cprint("5. Return to Main Menu", Theme.CYAN)
            sub = input("\nChoice: ").strip()

            if sub == "1":
                name = prompt_user("Income Name (e.g. Work, Rental)")
                amt = prompt_user("Standard paycheck amount", "money")
                freq = prompt_user("Frequency (Weekly, Bi-weekly, Monthly)", "frequency")
                last = prompt_user("Date of your last paycheck", "date")
                db_manager.add_income_source(name, amt, freq, last)
                cprint(f"\n Success: {name} added.", Theme.GREEN)
                wait_for_user()
            elif sub == "2":
                if not sources:
                    cprint("\n (!) Add an income source first.", Theme.YELLOW)
                    continue
                idx = prompt_user("Which paycheck are you planning for?", "int")
                if 1 <= idx <= len(sources):
                    source = sources[idx - 1]
                    cprint(
                        f"\n--- Planning for {source.name} on "
                        f"{format_date_display(source.next_payday)} ---",
                        Theme.CYAN,
                    )
                    print(f" (Current default: {format_currency(source.amount)})")

                    mode = input(" Do you want to enter [H]ours or a flat [A]mount? ").strip().lower()
                    if mode == "h":
                        rate = prompt_user("Hourly Rate", "money")
                        hours = prompt_user("Estimated Hours", "int")
                        proj_cents = rate * hours
                    else:
                        proj_cents = prompt_user("Projected Amount", "money")

                    db_manager.update_income_source(
                        source.id,
                        source.name,
                        source.amount,
                        source.frequency,
                        source.last_payday,
                        source.next_payday,
                        proj_cents,
                    )
                    cprint(
                        f"\n Success: Next paycheck projected at {format_currency(proj_cents)}.",
                        Theme.GREEN,
                    )
                    wait_for_user()
            elif sub == "3":
                if not sources:
                    cprint("\n (!) No sources to edit.", Theme.YELLOW)
                    continue
                idx = prompt_user("Which item should be edited?", "int")
                if 1 <= idx <= len(sources):
                    source = sources[idx - 1]
                    name = prompt_user("New Name", default=source.name)
                    amt = prompt_user(
                        "New Amount",
                        "money",
                        default=f"{budget_engine.from_cents(source.amount):.2f}",
                    )
                    freq = prompt_user("New Frequency", "frequency", default=source.frequency)
                    last = prompt_user(
                        "Date of your last paycheck (MM/DD/YYYY)",
                        "date",
                        default=format_date_display(source.last_payday),
                    )
                    next_payday = budget_engine.get_next_payday(last, freq)

                    db_manager.update_income_source(
                        source.id,
                        name,
                        amt,
                        freq,
                        last,
                        next_payday,
                    )
                    cprint(
                        f"\n Success: {name} updated. Next payday: "
                        f"{format_date_display(next_payday)} ✅",
                        Theme.GREEN,
                    )
                    wait_for_user()
            elif sub == "4":
                if not sources:
                    cprint("\n (!) No sources to remove.", Theme.YELLOW)
                    continue
                idx = prompt_user("Which item should be removed?", "int")
                if 1 <= idx <= len(sources):
                    source = sources[idx - 1]
                    db_manager.delete_income_source(source.id)
                    cprint(f"\n Success: {source.name} removed.", Theme.GREEN)
                    wait_for_user()
            elif sub == "5":
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
    for i, income in enumerate(income_sources, 1):
        print(
            f" {i}. {income.name} ({format_currency(income.amount)}) - Next: "
            f"{format_date_display(income.next_payday)}"
        )
    print(f" {len(income_sources) + 1}. Back")

    choice = prompt_user("Select source to process", "int")
    if 1 <= choice <= len(income_sources):
        income = income_sources[choice - 1]
        payday_date = income.next_payday
        print(f"\n Processing payday for {Theme.CYAN}{income.name}{Theme.RESET}")

        default_amt = income.expected_amount if income.expected_amount is not None else income.amount
        amt = prompt_user(
            "Actual amount received",
            "money",
            default=f"{budget_engine.from_cents(default_amt):.2f}",
        )

        if input(f" Confirm deposit of {format_currency(amt)}? (y/n): ").lower() == "y":
            db_manager.add_transaction(
                amt,
                "Income",
                f"Paycheck: {income.name}",
                t_type="Income",
                date_str=payday_date,
            )
            new_next = budget_engine.get_next_payday(payday_date, income.frequency)
            db_manager.update_income_source(
                income.id,
                income.name,
                income.amount,
                income.frequency,
                payday_date,
                new_next,
                expected_amount=None,
            )
            cprint(" Paycheck recorded! 💰", Theme.GREEN)
            wait_for_user()
