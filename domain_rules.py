from typing import Any, Optional

def validate_transaction_sign(amount_cents: int, t_type: str):
    """Enforces sign rules for transactions. Rejects zero-dollar movements."""
    if t_type == 'Income' and amount_cents <= 0:
        raise ValueError("Income transactions must have a positive amount (> 0).")
    if t_type == 'Expense' and amount_cents >= 0:
        raise ValueError("Expense transactions must have a negative amount (< 0).")

def validate_occurrence_link(occurrence: Optional[Any], transaction: Optional[Any]):
    """Enforces integrity rules when linking a transaction to a bill occurrence."""
    if not occurrence:
        raise ValueError("Occurrence not found.")
    if not transaction:
        raise ValueError("Transaction not found.")
    if transaction['type'] != 'Expense':
        raise ValueError("Transaction must be an Expense.")
    
    # Check amount matching (abs(txn.amount) == occ.expected_amount in the DB)
    # The DB field in bill_occurrences joined with payments is often 'expected_amount' or 'amount'
    # In mark_occurrence_paid, it was 'expected_amount' from p.amount
    if abs(transaction['amount']) != occurrence['expected_amount']:
        raise ValueError("Transaction amount does not match the bill amount.")

def validate_expected_amount_usage(income_source: Any, amount: int):
    """Ensures expected_amount override is valid."""
    validate_amount_positivity(amount, "Income amount")

def validate_amount_positivity(amount: int, label: str):
    """Ensures a given cent amount is positive."""
    if amount <= 0:
        raise ValueError(f"{label} must be positive.")
