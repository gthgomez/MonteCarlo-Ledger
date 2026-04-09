from . import db_manager
from .ui import (
    CancelInput,
    Theme,
    clear_screen,
    cprint,
    format_currency,
    prompt_user,
    wait_for_user,
)


def handle_reconcile():
    try:
        reconcile_flow()
    except CancelInput:
        print("\n(Cancelled)")


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

            if choice == "1":
                actual_cents = prompt_user("Enter actual CURRENT bank balance", "money")
                delta = actual_cents - ledger_bal
                if delta == 0:
                    cprint(" Ledger sum already matches bank.", Theme.GREEN)
                    wait_for_user()
                else:
                    reason = prompt_user("Reason for correction", default="Reconciliation adjustment")
                    db_manager.add_transaction(
                        delta,
                        "Adjustment",
                        f"{reason} ({format_currency(delta)})",
                        t_type="Adjustment",
                    )
                    db_manager.sync_stored_balance()
                    cprint(f" Success: Ledger corrected by {format_currency(delta)}.", Theme.GREEN)
                    wait_for_user()
            elif choice == "2":
                db_manager.sync_stored_balance()
                cprint(" Success: Stored balance synced to ledger.", Theme.GREEN)
                wait_for_user()
            elif choice == "3":
                break
            else:
                cprint("\n (!) Invalid choice.", Theme.YELLOW)
                wait_for_user()
        except CancelInput:
            break
