from datetime import datetime, timedelta
import re
from typing import List, Dict, Optional, Any
from decimal import Decimal, ROUND_HALF_UP

def get_today() -> datetime:
    """Returns the current date at midnight for comparison. Can be patched in tests."""
    return datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)

def to_cents(dollars: float) -> int:
    """Safely converts dollars to integer cents. Handles rounding to avoid float drift (e.g. 0.1+0.2)."""
    return int(round(dollars * 100))

def from_cents(cents: int) -> float:
    """Converts integer cents back to dollars."""
    return float(cents) / 100.0

def parse_money_input(text: str) -> int:
    """
    Deterministically parses money input strings to integer cents without float intermediation.
    Supports formats like "$1,234.56", "1234.56", "1234", "1234.5".
    """
    # Remove currency symbols and commas
    clean_text = re.sub(r'[$,]', '', text.strip())
    if not clean_text:
        raise ValueError("Amount cannot be empty.")
    
    try:
        # Use Decimal for high-precision intermediate parsing
        d = Decimal(clean_text)
        # Round to 2 decimal places and convert to cents
        cents = (d * Decimal('100')).quantize(Decimal('1'), rounding=ROUND_HALF_UP)
        return int(cents)
    except Exception:
        raise ValueError(f"Invalid money format: '{text}'. Use e.g. 12.34 or $12.34")

def add_months(source_date: datetime, months: int) -> datetime:
    """
    Safely adds months to a date, snapping to the last day of the month if necessary.
    E.g., Jan 31 + 1 month -> Feb 28 (or 29).
    """
    month = source_date.month - 1 + months
    year = source_date.year + month // 12
    month = month % 12 + 1
    
    # Days in each month for the target year
    days_in_months = [31, 
                      29 if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0) else 28,
                      31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
    
    day = min(source_date.day, days_in_months[month - 1])
    return datetime(year, month, day)

def normalize_date(date_str: str, relative_to: Optional[datetime] = None) -> str:
    """
    Normalizes various date formats to YYYY-MM-DD.
    Supports: YYYY-MM-DD, MM/DD, MM-DD, MM DD, MMDD, 'next', '+1'.
    
    Inference Rule:
    - If year is missing (e.g., 05/20):
      - If the resulting date is > 30 days in the past compared to relative_to, 
        assume it belongs to NEXT year.
    """
    date_str = date_str.lower().strip()
    ref_date = relative_to if relative_to else get_today()

    if date_str in ('next', '+1'):
        return add_months(ref_date, 1).strftime('%Y-%m-%d')

    # Remove non-digit separators and try to get parts
    digits_only = re.sub(r'[^0-9]', ' ', date_str).split()
    
    if not digits_only:
        raise ValueError("Invalid date format. Use MM/DD or YYYY-MM-DD.")

    # Handle MMDD (4 digits)
    if len(digits_only) == 1 and len(digits_only[0]) == 4:
        month = int(digits_only[0][:2])  # type: ignore[index]
        day = int(digits_only[0][2:])    # type: ignore[index]
        year = ref_date.year
    elif len(digits_only) == 2:
        # MM DD
        month = int(digits_only[0])
        day = int(digits_only[1])
        year = ref_date.year
    elif len(digits_only) == 3:
        # MM DD YYYY or YYYY MM DD
        if len(digits_only[0]) == 4:
            year = int(digits_only[0])
            month = int(digits_only[1])
            day = int(digits_only[2])
        else:
            month = int(digits_only[0])
            day = int(digits_only[1])
            year = int(digits_only[2])
            if year < 100: year += 2000
    else:
        raise ValueError("Invalid date format. Use MM/DD or YYYY-MM-DD.")

    try:
        candidate = datetime(year, month, day)
        # If the date is more than 30 days ago and was a partial date, assume next year
        if len(digits_only) < 3 and candidate < ref_date - timedelta(days=30):
            candidate = candidate.replace(year=year + 1)
        return candidate.strftime('%Y-%m-%d')
    except ValueError:
        raise ValueError(f"Invalid date: {month}/{day}")

def normalize_frequency(freq_str: str) -> str:
    """Normalizes frequency inputs to standard DB values."""
    f = freq_str.lower().strip()
    if 'bi' in f: return 'Bi-weekly'
    if 'week' in f: return 'Weekly'
    if 'month' in f: return 'Monthly'
    if 'one' in f: return 'One-time'
    raise ValueError("Invalid frequency. Use Weekly, Bi-weekly, Monthly, or One-time.")

def get_next_payday(last_payday_str: str, frequency: str) -> str:
    """Calculates the next payday string based on last payday and frequency."""
    try:
        last_payday = datetime.strptime(last_payday_str, '%Y-%m-%d')
    except ValueError:
        return last_payday_str

    if frequency == 'Weekly':
        next_date = last_payday + timedelta(weeks=1)
    elif frequency == 'Bi-weekly':
        next_date = last_payday + timedelta(weeks=2)
    elif frequency == 'Monthly':
        next_date = add_months(last_payday, 1)
    else:
        return last_payday_str

    return next_date.strftime('%Y-%m-%d')

def get_upcoming_schedule(payments: List[Dict], start_date_str: str, end_date_str: str) -> List[Dict]:
    """
    Returns a list of all payment occurrences between start_date (inclusive) and end_date (exclusive).
    Sorted by date.
    """
    start_date = datetime.strptime(start_date_str, '%Y-%m-%d')
    end_date = datetime.strptime(end_date_str, '%Y-%m-%d')
    schedule = []

    for pay in payments:
        amount = pay['amount']
        recurrence = pay['recurrence']
        name = pay['name']
        payment_id = pay.get('id')

        if recurrence == 'One-time':
            due = datetime.strptime(pay['due_date'], '%Y-%m-%d')
            if start_date <= due <= end_date:
                occurrence = {'date': pay['due_date'], 'name': name, 'amount': amount, 'recurrence': recurrence, 'payment_id': payment_id}
                schedule.append(occurrence)
        
        elif recurrence in ('Weekly', 'Bi-weekly'):
            due = datetime.strptime(pay['due_date'], '%Y-%m-%d')
            step = 7 if recurrence == 'Weekly' else 14
            
            # Optimization: If due is way before start_date, jump forward
            if due < start_date:
                days_diff = (start_date - due).days
                jumps = days_diff // step
                due += timedelta(days=jumps * step)
                if due < start_date:
                    due += timedelta(days=step)
            
            while due <= end_date:
                occurrence = {'date': due.strftime('%Y-%m-%d'), 'name': name, 'amount': amount, 'recurrence': recurrence, 'payment_id': payment_id}
                schedule.append(occurrence)
                due += timedelta(days=step)

        elif recurrence == 'Monthly':
            due_day = pay['due_day']
            current_month_start = start_date.replace(day=1)
            while current_month_start <= end_date:
                year = current_month_start.year
                month = current_month_start.month
                last_day = [31, 29 if year % 4 == 0 and (year % 100 != 0 or year % 400 == 0) else 28,
                            31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
                actual_day = min(due_day, last_day)
                due = datetime(year, month, actual_day)
                if start_date <= due <= end_date:
                    occurrence = {'date': due.strftime('%Y-%m-%d'), 'name': name, 'amount': amount, 'recurrence': recurrence, 'payment_id': payment_id}
                    schedule.append(occurrence)
                current_month_start = add_months(current_month_start, 1)

    schedule.sort(key=lambda x: x['date'])
    return schedule
