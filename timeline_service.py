from datetime import datetime, timedelta
from typing import List, Dict
import db_manager
import budget_engine
import domain_rules

def get_unpaid_bill_events(start_date: str, end_date: str, read_only: bool = False) -> List[Dict]:
    """Retrieves upcoming bill occurrences and filters out paid bills (includes 30-day lookback for past-due)."""
    # Look back 30 days to catch unpaid past-due bills in the timeline
    lookback_date = (datetime.strptime(start_date, '%Y-%m-%d') - timedelta(days=30)).strftime('%Y-%m-%d')
    
    if read_only:
        # In-memory projection: Diff expected schedule with paid occurrences in DB
        payments = db_manager.get_all_payments()
        pmt_dicts = [dict(vars(p)) for p in payments]
        # Use lookback_date here to catch missed bills in the generated schedule
        schedule = budget_engine.get_upcoming_schedule(pmt_dicts, lookback_date, end_date)
        
        # Get all paid occurrences in this window (also using lookback)
        with db_manager.get_db_connection() as conn:
            paid = conn.execute("SELECT payment_id, due_date FROM bill_occurrences WHERE paid = 1 AND due_date >= ? AND due_date <= ?", (lookback_date, end_date)).fetchall()
            paid_set = {(r['payment_id'], r['due_date']) for r in paid}
        
        events = []
        pmt_map = {p.id: p for p in payments}
        for item in schedule:
            if (item['payment_id'], item['date']) not in paid_set:
                p = pmt_map[item['payment_id']]
                events.append({
                    "date": item['date'],
                    "name": p.name,
                    "amount": -p.amount,
                    "type": "bill",
                    "priority": 1
                })
        return events
    else:
        db_manager.sync_bill_occurrences(start_date, end_date)
        unpaid_bills = db_manager.get_unpaid_occurrences(start_date, end_date)
        
        events = []
        for item in unpaid_bills:
            events.append({
                "date": item.due_date,
                "name": item.name,
                "amount": -item.amount,  # Bills are negative
                "type": "bill",
                "priority": 1
            })
        return events

def generate_income_events(start_date: str, end_date: str) -> List[Dict]:
    """Retrieves income schedules and predicts income dates within the window."""
    income_sources = db_manager.get_all_income()
    events = []
    
    start_dt = datetime.strptime(start_date, '%Y-%m-%d').date()
    end_dt = datetime.strptime(end_date, '%Y-%m-%d').date()
    
    for inc in income_sources:
        current_payday = datetime.strptime(inc.next_payday, '%Y-%m-%d').date()
        
        is_first_payday = True
        while current_payday <= end_dt:
            # Handle is_first_payday: it's the VERY FIRST payday the generator encounters for this source,
            # even if it's before start_date (i.e., we skip it in the visible window).
            if current_payday >= start_dt:
                if is_first_payday and inc.expected_amount is not None:
                    domain_rules.validate_expected_amount_usage(inc, inc.expected_amount)
                    amount = inc.expected_amount
                else:
                    amount = inc.amount
                
                events.append({
                    "date": current_payday.strftime('%Y-%m-%d'),
                    "name": inc.name,
                    "amount": amount,  # Income is positive
                    "type": "income",
                    "priority": 0
                })
            
            # expected_amount only affects the literal first occurrence calculated
            is_first_payday = False

            # Jump to the next payday
            next_payday_str = budget_engine.get_next_payday(current_payday.strftime('%Y-%m-%d'), inc.frequency)
            next_payday = datetime.strptime(next_payday_str, '%Y-%m-%d').date()
            
            if next_payday <= current_payday:
                break
                
            current_payday = next_payday
            
    return events

def merge_and_sort_events(bill_events: List[Dict], income_events: List[Dict]) -> List[Dict]:
    """Combines and sorts events chronologically (income before bills on same day)."""
    timeline = bill_events + income_events
    timeline.sort(key=lambda x: (x['date'], x['priority']))
    return timeline

def build_financial_timeline(days_ahead: int = 30, read_only: bool = False) -> List[Dict]:
    """Orchestrates the retrieval, prediction, and merging of financial events."""
    today = datetime.now()
    start_date = today.strftime('%Y-%m-%d')
    end_date = (today + timedelta(days=days_ahead)).strftime('%Y-%m-%d')
    
    bill_events = get_unpaid_bill_events(start_date, end_date, read_only=read_only)
    income_events = generate_income_events(start_date, end_date)
    
    return merge_and_sort_events(bill_events, income_events)
