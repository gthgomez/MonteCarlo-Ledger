import unittest
import os
from unittest.mock import patch, MagicMock
from datetime import datetime

from monte_carlo_ledger import db_manager
from monte_carlo_ledger.ui import prompt_user, CancelInput
from monte_carlo_ledger import workflow_onboarding, workflow_payments


class TestPromptUser(unittest.TestCase):
    """Tests for prompt_user() validation logic."""

    # === Money validation ===

    def test_valid_money_simple(self):
        with patch('builtins.input', return_value='100.50'):
            result = prompt_user("Amount", "money")
        self.assertEqual(result, 10050)

    def test_valid_money_with_dollar_and_commas(self):
        with patch('builtins.input', return_value='$1,234.56'):
            result = prompt_user("Amount", "money")
        self.assertEqual(result, 123456)

    def test_valid_money_integer(self):
        with patch('builtins.input', return_value='500'):
            result = prompt_user("Amount", "money")
        self.assertEqual(result, 50000)

    def test_invalid_money_retries(self):
        with patch('builtins.input', side_effect=['abc', '100']):
            result = prompt_user("Amount", "money")
        self.assertEqual(result, 10000)

    def test_negative_money_retries(self):
        with patch('builtins.input', side_effect=['-50', '100']):
            result = prompt_user("Amount", "money")
        self.assertEqual(result, 10000)

    def test_zero_money_retries(self):
        with patch('builtins.input', side_effect=['0', '100']):
            result = prompt_user("Amount", "money")
        self.assertEqual(result, 10000)

    def test_money_with_default(self):
        with patch('builtins.input', return_value=''):
            result = prompt_user("Amount", "money", default="100")
        self.assertEqual(result, 10000)

    def test_money_with_default_non_empty(self):
        with patch('builtins.input', return_value='200'):
            result = prompt_user("Amount", "money", default="100")
        self.assertEqual(result, 20000)

    def test_money_whitespace_only_retries(self):
        with patch('builtins.input', side_effect=['   ', '100']):
            result = prompt_user("Amount", "money")
        self.assertEqual(result, 10000)

    # === String validation ===

    def test_string_valid(self):
        with patch('builtins.input', return_value='hello'):
            result = prompt_user("Name")
        self.assertEqual(result, 'hello')

    def test_string_empty_retries(self):
        with patch('builtins.input', side_effect=['', 'hello']):
            result = prompt_user("Name")
        self.assertEqual(result, 'hello')

    def test_string_with_default(self):
        with patch('builtins.input', return_value=''):
            result = prompt_user("Name", default="Salary")
        self.assertEqual(result, 'Salary')

    def test_string_with_default_non_empty(self):
        with patch('builtins.input', return_value='custom'):
            result = prompt_user("Name", default="Salary")
        self.assertEqual(result, 'custom')

    def test_string_whitespace_only_retries(self):
        with patch('builtins.input', side_effect=['   ', 'hello']):
            result = prompt_user("Name")
        self.assertEqual(result, 'hello')

    def test_optional_allows_empty(self):
        with patch('builtins.input', return_value=''):
            result = prompt_user("Name", validation_type="optional")
        self.assertEqual(result, '')

    # === Cancel keywords ===

    def test_cancel_q(self):
        with patch('builtins.input', return_value='q'):
            with self.assertRaises(CancelInput):
                prompt_user("Name")

    def test_cancel_quit(self):
        with patch('builtins.input', return_value='quit'):
            with self.assertRaises(CancelInput):
                prompt_user("Name")

    def test_cancel_cancel(self):
        with patch('builtins.input', return_value='cancel'):
            with self.assertRaises(CancelInput):
                prompt_user("Name")

    def test_cancel_case_insensitive(self):
        with patch('builtins.input', return_value='Q'):
            with self.assertRaises(CancelInput):
                prompt_user("Name")

    def test_cancel_after_invalid(self):
        with patch('builtins.input', side_effect=['invalid', 'q']):
            with self.assertRaises(CancelInput):
                prompt_user("Amount", "money")

    # === EOF ===

    def test_eof_raises_cancel(self):
        with patch('builtins.input', side_effect=EOFError):
            with self.assertRaises(CancelInput):
                prompt_user("Name")

    # === Help ===

    def test_help_shows_and_continues(self):
        with patch('builtins.input', side_effect=['?', 'hello']):
            result = prompt_user("Name")
        self.assertEqual(result, 'hello')

    def test_help_keyword(self):
        with patch('builtins.input', side_effect=['help', 'hello']):
            result = prompt_user("Name")
        self.assertEqual(result, 'hello')

    # === Int validation ===

    def test_int_valid(self):
        with patch('builtins.input', return_value='42'):
            result = prompt_user("Number", "int")
        self.assertEqual(result, 42)

    def test_int_invalid_retries(self):
        with patch('builtins.input', side_effect=['abc', '42']):
            result = prompt_user("Number", "int")
        self.assertEqual(result, 42)

    def test_int_negative(self):
        with patch('builtins.input', return_value='-5'):
            result = prompt_user("Number", "int")
        self.assertEqual(result, -5)

    def test_int_with_default(self):
        with patch('builtins.input', return_value=''):
            result = prompt_user("Number", "int", default="42")
        self.assertEqual(result, 42)

    # === Due day validation ===

    def test_due_day_valid(self):
        with patch('builtins.input', return_value='15'):
            result = prompt_user("Day", "due_day")
        self.assertEqual(result, 15)

    def test_due_day_too_high_retries(self):
        with patch('builtins.input', side_effect=['32', '15']):
            result = prompt_user("Day", "due_day")
        self.assertEqual(result, 15)

    def test_due_day_too_low_retries(self):
        with patch('builtins.input', side_effect=['0', '15']):
            result = prompt_user("Day", "due_day")
        self.assertEqual(result, 15)

    def test_due_day_invalid_retries(self):
        with patch('builtins.input', side_effect=['abc', '15']):
            result = prompt_user("Day", "due_day")
        self.assertEqual(result, 15)

    def test_due_day_with_default(self):
        with patch('builtins.input', return_value=''):
            result = prompt_user("Day", "due_day", default="15")
        self.assertEqual(result, 15)

    # === Date validation ===

    def test_date_valid_iso(self):
        with patch('builtins.input', return_value='2024-01-15'):
            result = prompt_user("Date", "date")
        self.assertEqual(result, '2024-01-15')

    def test_date_valid_us_format(self):
        with patch('builtins.input', return_value='01/15/2024'):
            result = prompt_user("Date", "date")
        self.assertEqual(result, '2024-01-15')

    def test_date_invalid_retries(self):
        with patch('builtins.input', side_effect=['invalid', '2024-01-15']):
            result = prompt_user("Date", "date")
        self.assertEqual(result, '2024-01-15')

    def test_date_with_default(self):
        with patch('builtins.input', return_value=''):
            result = prompt_user("Date", "date", default="2024-01-15")
        self.assertEqual(result, '2024-01-15')

    # === Frequency validation ===

    def test_frequency_valid_monthly(self):
        with patch('builtins.input', return_value='monthly'):
            result = prompt_user("Frequency", "frequency")
        self.assertEqual(result, 'Monthly')

    def test_frequency_valid_weekly(self):
        with patch('builtins.input', return_value='weekly'):
            result = prompt_user("Frequency", "frequency")
        self.assertEqual(result, 'Weekly')

    def test_frequency_valid_biweekly(self):
        with patch('builtins.input', return_value='bi-weekly'):
            result = prompt_user("Frequency", "frequency")
        self.assertEqual(result, 'Bi-weekly')

    def test_frequency_valid_one_time(self):
        with patch('builtins.input', return_value='one-time'):
            result = prompt_user("Frequency", "frequency")
        self.assertEqual(result, 'One-time')

    def test_frequency_invalid_retries(self):
        with patch('builtins.input', side_effect=['invalid', 'monthly']):
            result = prompt_user("Frequency", "frequency")
        self.assertEqual(result, 'Monthly')

    def test_frequency_with_default(self):
        with patch('builtins.input', return_value=''):
            result = prompt_user("Frequency", "frequency", default="Monthly")
        self.assertEqual(result, 'Monthly')


class TestRunOnboarding(unittest.TestCase):
    """Tests for run_onboarding() workflow."""

    def setUp(self):
        self.test_db = 'test_ledger_onboarding.db'
        db_manager.DB_PATH = self.test_db
        if os.path.exists(self.test_db):
            os.remove(self.test_db)
        db_manager.init_db()

    def tearDown(self):
        if os.path.exists(self.test_db):
            os.remove(self.test_db)

    def test_skip_path(self):
        """User chooses 'n' to skip setup."""
        with patch('monte_carlo_ledger.workflow_onboarding.clear_screen'):
            with patch('builtins.input', return_value='n'):
                with patch('monte_carlo_ledger.db_manager.set_onboarded') as mock_set:
                    workflow_onboarding.run_onboarding()
                    mock_set.assert_called_once_with(True)

    def test_full_setup_path(self):
        """User completes the full setup wizard."""
        inputs = [
            'y',      # Start setup
            '',       # Income Name (default "Salary")
            '2000',   # Paycheck amount
            '',       # Frequency (default "Bi-weekly")
            '',       # Last paycheck date (default)
            '',       # Bill Name (default "Rent")
            '1500',   # Bill amount
            '',       # Recurrence (default "Monthly")
            '',       # Due day (default "1")
            '',       # wait_for_user
        ]
        with patch('monte_carlo_ledger.workflow_onboarding.clear_screen'):
            with patch('builtins.input', side_effect=inputs):
                with patch('monte_carlo_ledger.db_manager.add_income_source') as mock_add_income:
                    with patch('monte_carlo_ledger.db_manager.add_payment') as mock_add_payment:
                        with patch('monte_carlo_ledger.db_manager.set_onboarded') as mock_set:
                            workflow_onboarding.run_onboarding()
                            mock_add_income.assert_called_once()
                            mock_add_payment.assert_called_once()
                            mock_set.assert_called_once_with(True)

    def test_cancel_during_setup(self):
        """User cancels during setup."""
        inputs = [
            'y',      # Start setup
            'q',      # Cancel at Income Name
            '',       # wait_for_user after cancel
        ]
        with patch('monte_carlo_ledger.workflow_onboarding.clear_screen'):
            with patch('builtins.input', side_effect=inputs):
                with patch('monte_carlo_ledger.db_manager.set_onboarded') as mock_set:
                    workflow_onboarding.run_onboarding()
                    mock_set.assert_called_once_with(True)


class TestManagePaymentsMenu(unittest.TestCase):
    """Tests for manage_payments_menu() workflow."""

    def setUp(self):
        self.test_db = 'test_ledger_payments.db'
        db_manager.DB_PATH = self.test_db
        if os.path.exists(self.test_db):
            os.remove(self.test_db)
        db_manager.init_db()

    def tearDown(self):
        if os.path.exists(self.test_db):
            os.remove(self.test_db)

    def _make_payment(self, name="Rent", amount=150000, recurrence="Monthly", due_day=1, due_date=None):
        """Helper to create a mock Payment object."""
        from monte_carlo_ledger.db_manager import Payment
        return Payment(
            id=1,
            name=name,
            amount=amount,
            recurrence=recurrence,
            due_day=due_day,
            due_date=due_date,
        )

    def test_empty_list(self):
        """No payments shows message and returns."""
        with patch('monte_carlo_ledger.workflow_payments.clear_screen'):
            with patch('monte_carlo_ledger.db_manager.get_all_payments', return_value=[]):
                with patch('builtins.input') as mock_input:
                    workflow_payments.manage_payments_menu()
                    mock_input.assert_not_called()

    def test_invalid_choice(self):
        """Invalid menu choice shows error and continues."""
        payment = self._make_payment()
        inputs = ['invalid', '', '3']  # invalid choice, wait_for_user, then back
        with patch('monte_carlo_ledger.workflow_payments.clear_screen'):
            with patch('monte_carlo_ledger.db_manager.get_all_payments', return_value=[payment]):
                with patch('builtins.input', side_effect=inputs):
                    workflow_payments.manage_payments_menu()

    def test_cancel_during_edit(self):
        """Canceling during edit breaks the loop."""
        payment = self._make_payment()
        inputs = ['1', 'q']  # Choose edit, then cancel
        with patch('monte_carlo_ledger.workflow_payments.clear_screen'):
            with patch('monte_carlo_ledger.db_manager.get_all_payments', return_value=[payment]):
                with patch('builtins.input', side_effect=inputs):
                    workflow_payments.manage_payments_menu()

    def test_cancel_during_delete(self):
        """Canceling during delete breaks the loop."""
        payment = self._make_payment()
        inputs = ['2', 'q']  # Choose delete, then cancel
        with patch('monte_carlo_ledger.workflow_payments.clear_screen'):
            with patch('monte_carlo_ledger.db_manager.get_all_payments', return_value=[payment]):
                with patch('builtins.input', side_effect=inputs):
                    workflow_payments.manage_payments_menu()

    def test_back_choice(self):
        """Choosing '3' breaks the loop."""
        payment = self._make_payment()
        inputs = ['3']  # Back
        with patch('monte_carlo_ledger.workflow_payments.clear_screen'):
            with patch('monte_carlo_ledger.db_manager.get_all_payments', return_value=[payment]):
                with patch('builtins.input', side_effect=inputs):
                    workflow_payments.manage_payments_menu()

    def test_edit_payment(self):
        """Editing a payment calls update_payment."""
        payment = self._make_payment()
        inputs = [
            '1',      # Choose edit
            '1',      # Select payment 1
            '',       # New Name (default)
            '',       # New Amount (default)
            '',       # New Recurrence (default)
            '',       # Due day/date (default)
            '',       # wait_for_user
            '3',      # Back
        ]
        with patch('monte_carlo_ledger.workflow_payments.clear_screen'):
            with patch('monte_carlo_ledger.db_manager.get_all_payments', return_value=[payment]):
                with patch('builtins.input', side_effect=inputs):
                    with patch('monte_carlo_ledger.db_manager.update_payment') as mock_update:
                        workflow_payments.manage_payments_menu()
                        mock_update.assert_called_once()

    def test_delete_payment(self):
        """Deleting a payment calls delete_payment."""
        payment = self._make_payment()
        inputs = [
            '2',      # Choose delete
            '1',      # Select payment 1
            'y',      # Confirm delete
            '',       # wait_for_user
            '3',      # Back
        ]
        with patch('monte_carlo_ledger.workflow_payments.clear_screen'):
            with patch('monte_carlo_ledger.db_manager.get_all_payments', return_value=[payment]):
                with patch('builtins.input', side_effect=inputs):
                    with patch('monte_carlo_ledger.db_manager.delete_payment') as mock_delete:
                        workflow_payments.manage_payments_menu()
                        mock_delete.assert_called_once_with(payment.id)

    def test_handle_manage_payments_catches_cancel(self):
        """handle_manage_payments catches CancelInput."""
        with patch('monte_carlo_ledger.workflow_payments.manage_payments_menu') as mock_menu:
            mock_menu.side_effect = CancelInput()
            # Should not raise
            workflow_payments.handle_manage_payments()


if __name__ == '__main__':
    unittest.main()
