from datetime import datetime
from typing import Optional

from . import budget_engine, db_manager
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


def reconcile_flow(as_of: Optional[str] = None):
    as_of = budget_engine.normalize_date(
        as_of or datetime.now().strftime("%Y-%m-%d")
    )
    while True:
        try:
            clear_screen()
            print("\n--- Reconcile Bank Balance ---")
            ledger_bal = db_manager.get_ledger_balance()
            current_bal = db_manager.get_ledger_balance_through(as_of)
            stored_bal = db_manager.get_stored_balance()
            print(f" Ledger Sum:    {format_currency(ledger_bal)} (all dates)")
            print(f" Current Cash:  {format_currency(current_bal)} (through {as_of})")
            if ledger_bal != stored_bal:
                print(f" Stored Balance: {format_currency(stored_bal)} (MISMATCH)")

            print("\n 1. Enter Actual Bank Balance (Create adjustment)")
            print(" 2. Sync Stored Balance to Ledger Sum")
            print(" 3. Back")
            choice = input("\n Choice: ").strip()

            if choice == "1":
                actual_cents = prompt_user("Enter actual CURRENT bank balance", "money")
                # Re-read: the rendered figure may be stale by the time input returns.
                latest_bal = db_manager.get_ledger_balance_through(as_of)
                if actual_cents == latest_bal:
                    cprint(" Current cash already matches bank.", Theme.GREEN)
                    wait_for_user()
                else:
                    reason = prompt_user("Reason for correction", default="Reconciliation adjustment")
                    applied = db_manager.reconcile_cash_balance(actual_cents, as_of, reason)
                    if applied == 0:
                        # The transaction re-read the basis; a concurrent update won.
                        cprint(" Current cash already matches bank.", Theme.GREEN)
                    else:
                        cprint(
                            f" Success: Current cash corrected by {format_currency(applied)}.",
                            Theme.GREEN,
                        )
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
