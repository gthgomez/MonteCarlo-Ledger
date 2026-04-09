from typing import Dict, List


def calculate_safe_spend(balance_cents: int, timeline_events: List[Dict]) -> int:
    """
    Implements running balance simulation to find the minimum point.
    This represents the maximum safe-spend money before the next income hits.
    """
    running_balance = balance_cents
    lowest_balance = balance_cents

    for event in timeline_events:
        running_balance += event["amount"]
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
    Chronologically simulates balance progression across future events.
    Returns the enriched sequence array with a `balance_after` metric.
    """
    forecast_rows = []
    running_balance = balance_cents

    for event in timeline_events:
        running_balance += event["amount"]
        forecast_rows.append(
            {
                "date": event["date"],
                "name": event["name"],
                "type": event["type"],
                "amount": event["amount"],
                "balance_after": running_balance,
            }
        )

    return forecast_rows


def calculate_forecast_summary(balance_cents: int, forecast_rows: List[Dict]) -> Dict:
    """Computes summary metrics for a generated forecast."""
    lowest_balance = balance_cents
    lowest_balance_date = None
    first_negative_date = None
    ending_balance = balance_cents

    for row in forecast_rows:
        cur_bal = row["balance_after"]
        ending_balance = cur_bal

        if cur_bal < lowest_balance:
            lowest_balance = cur_bal
            lowest_balance_date = row["date"]

        if first_negative_date is None and cur_bal < 0:
            first_negative_date = row["date"]

    return {
        "starting_balance": balance_cents,
        "lowest_balance": lowest_balance,
        "lowest_balance_date": lowest_balance_date,
        "ending_balance": ending_balance,
        "first_negative_date": first_negative_date,
    }
