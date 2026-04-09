from datetime import datetime

from . import budget_engine, db_manager
from .ui import (
    CancelInput,
    Theme,
    clear_screen,
    cprint,
    format_currency,
    format_date_display,
    get_ordinal,
    prompt_user,
    wait_for_user,
)


def handle_mark_paid():
    try:
        clear_screen()
        payments = db_manager.get_all_payments()
        if not payments:
            print("\n(!) You don't have any bills saved.")
            return

        print("\n--- Select a Bill to Pay ---")
        for i, payment in enumerate(payments, 1):
            print(f" {i}. {payment.name} ({format_currency(-payment.amount)})")

        idx = prompt_user("Which bill did you pay?", "int")
        if 1 <= idx <= len(payments):
            payment = payments[idx - 1]
            occurrence = db_manager.get_next_unpaid_occurrence(payment.id)

            if not occurrence:
                print(f"\n[Note] No scheduled 'unpaid' records found for {payment.name}.")
                if input("Log as a new manual transaction? (y/n): ").lower() != "y":
                    return
            else:
                print(f"Marking the bill due on {format_date_display(occurrence.due_date)} as paid.")

            amt = prompt_user(
                f"Amount paid for {payment.name}",
                "money",
                default=f"{budget_engine.from_cents(payment.amount):.2f}",
            )
            category = prompt_user("Reporting Category", default="Bills")
            date_str = occurrence.due_date if occurrence else datetime.now().strftime("%Y-%m-%d")

            txn_id = db_manager.add_transaction(
                -amt,
                category,
                f"Paid {payment.name}",
                t_type="Expense",
                date_str=date_str,
            )

            if occurrence:
                db_manager.mark_occurrence_paid(occurrence.id, txn_id)

            if payment.recurrence == "One-time":
                cprint(
                    f"\n This was a one-time bill. Would you like to remove '{payment.name}' "
                    "from your list of bills?",
                    Theme.CYAN,
                )
                if input(" Delete it? (y/n): ").lower() == "y":
                    db_manager.delete_payment(payment.id)
                    cprint(" Bill removed.", Theme.DIM)
            cprint("\n Success: Payment recorded! ✅", Theme.GREEN)
            wait_for_user()
            wait_for_user()
    except CancelInput:
        print("\n(Cancelled)")


def handle_add_bill():
    try:
        cprint("\n--- Add a Repeating Bill or One-Time Expense ---", Theme.CYAN)
        name = prompt_user("What is the name of this bill? (e.g., Rent, Electric)")
        amt = prompt_user(f"How much is {name}?", "money")
        recurrence = prompt_user(
            "How often does this repeat? (Monthly, Weekly, One-time)",
            "frequency",
            default="Monthly",
        )

        if recurrence == "Monthly":
            due_info = prompt_user(
                "Which day of the month is it due? (Examples: 1, 15, 31)",
                "due_day",
            )
        else:
            due_info = prompt_user(
                "When is it due? (Examples: MM/DD, 03/20, next, +7)",
                "date",
            )

        db_manager.add_payment(name, amt, recurrence, due_info)
        cprint(f"\n Success: {name} has been added to your schedule! 🎉", Theme.GREEN)
        wait_for_user()
    except CancelInput:
        cprint("\n (Cancelled)", Theme.YELLOW)


def handle_manage_payments():
    try:
        manage_payments_menu()
    except CancelInput:
        print("\n(Cancelled)")


def manage_payments_menu():
    while True:
        try:
            clear_screen()
            print("\n--- Manage Payments ---")
            payments = db_manager.get_all_payments()
            if not payments:
                print("No payments found.")
                break
            for i, payment in enumerate(payments, 1):
                if payment.recurrence == "Monthly":
                    due_day = payment.due_day if payment.due_day is not None else 1
                    info = f"Day {get_ordinal(due_day)}"
                else:
                    due_date = payment.due_date if payment.due_date is not None else "Unknown"
                    info = format_date_display(due_date)
                print(
                    f" {i}. {payment.name}: {format_currency(payment.amount)} "
                    f"({payment.recurrence} - {info})"
                )

            print("\n1. Edit Payment")
            print("2. Delete Payment")
            print("3. Back")
            choice = input("\nChoice: ").strip()
            if choice == "1":
                idx = prompt_user("Enter number to edit", "int")
                if 1 <= idx <= len(payments):
                    payment = payments[idx - 1]
                    name = prompt_user("New Name", default=payment.name)
                    amount = prompt_user(
                        "New Amount",
                        "money",
                        default=f"{budget_engine.from_cents(payment.amount):.2f}",
                    )
                    recurrence = prompt_user(
                        "New Recurrence",
                        "frequency",
                        default=payment.recurrence,
                    )
                    due_default = (
                        str(payment.due_day) if recurrence == "Monthly" else payment.due_date
                    )
                    due = prompt_user(
                        "Due day/date",
                        "due_day" if recurrence == "Monthly" else "date",
                        default=due_default,
                    )
                    db_manager.update_payment(payment.id, name, amount, recurrence, due)
                    cprint(" Success: Updated!", Theme.GREEN)
                    wait_for_user()
            elif choice == "2":
                idx = prompt_user("Enter number to delete", "int")
                if 1 <= idx <= len(payments):
                    payment = payments[idx - 1]
                    if input(f" Delete '{payment.name}'? (y/n): ").lower() == "y":
                        db_manager.delete_payment(payment.id)
                        cprint(" Deleted.", Theme.DIM)
                        wait_for_user()
            elif choice == "3":
                break
            else:
                cprint("\n (!) Invalid choice.", Theme.YELLOW)
                wait_for_user()
        except CancelInput:
            break
