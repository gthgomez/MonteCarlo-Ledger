import unittest
from datetime import datetime
import budget_engine  # type: ignore[import-not-found]

class TestBudgetEngine(unittest.TestCase):

    def test_parse_money_input(self):
        # Basic parsing
        self.assertEqual(budget_engine.parse_money_input("45.99"), 4599)
        self.assertEqual(budget_engine.parse_money_input("$1,234.56"), 123456)
        
        # Rounding/Precision
        self.assertEqual(budget_engine.parse_money_input("45.9"), 4590)
        self.assertEqual(budget_engine.parse_money_input("45"), 4500)
        
        # Leading/Trailing spaces
        self.assertEqual(budget_engine.parse_money_input("  45.00  "), 4500)
        
        # Invalid formats
        with self.assertRaises(ValueError):
            budget_engine.parse_money_input("abc")
        with self.assertRaises(ValueError):
            budget_engine.parse_money_input("")

    def test_normalize_date_predictable(self):
        # The 30-day rule: if date is > 30 days ago, assume next year
        ref = datetime(2026, 3, 15)
        
        # March 10 (5 days ago) -> 2026
        self.assertEqual(budget_engine.normalize_date("03/10", relative_to=ref), "2026-03-10")
        
        # February 10 (33 days ago) -> 2027
        self.assertEqual(budget_engine.normalize_date("02/10", relative_to=ref), "2027-02-10")

    def test_optimized_schedule_weekly(self):
        # Weekly bill starts way in the past
        payments = [{
            'name': 'Gym',
            'amount': 1000,
            'recurrence': 'Weekly',
            'due_date': '2025-01-01' # Wednesday
        }]
        # Range: 2026-03-01 to 2026-03-15
        schedule = budget_engine.get_upcoming_schedule(payments, "2026-03-01", "2026-03-15")
        self.assertEqual(len(schedule), 2)
        self.assertEqual(schedule[0]['date'], "2026-03-04")
        self.assertEqual(schedule[1]['date'], "2026-03-11")

if __name__ == '__main__':
    unittest.main()
