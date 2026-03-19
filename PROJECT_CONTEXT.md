# Project Context: Monte Carlo Budget Simulator

High-density context for the Python-based CLI financial forecasting tool.

## Core Architecture
- **Tech Stack**: Python 3.x (Standard Library), SQLite.
- **Design Pattern**: 
    - **Separation of Concerns**: `main.py` (CLI/UI/Monte Carlo Shell), `db_manager.py` (Persistence/Ledger), `budget_engine.py` (Pure Logic/Math).
    - **Ledger-First Accounting**: The bank balance is derived from the sum of transactions. Cached balances exist in `settings` but are validated against the ledger before rendering.
    - **Integer-Cent Semantic**: All monetary values are handled as `INT` (cents). Floats are strictly forbidden in persistence and core math to prevent drift.

## Feature Map
- **[Functional] Ledger System**: Full CRUD for transactions with sign enforcement (Expenses < 0, Income > 0).
- **[Functional] Proactive Dashboard**: 30-day "Free to Spend" calculation based on the lowest projected balance point (Safe Spend).
- **[Functional] Forecast Engine**: 90-day deterministic timeline merging recurring bills and income.
- **[Functional] Risk Engine**: Monte Carlo simulation (500 runs) injecting +/- 8% income variation and random surprise expenses ($20-$150).
- **[Functional] Occurrence Linking**: Tracking specific bill instances (e.g., "March Rent") as paid/unpaid in `bill_occurrences` table.
- **[Functional] Onboarding**: Guided wizard for first-time setup.

## Active Mission
**Focus**: Stability and Edge-Case Resolution.
The "Monte Carlo Risk Engine" (Phase 8) was recently integrated. Current work revolves around architectural integrity:
- Fixing "Projection Bleed" (ensuring expected income only overrides the *next* paycheck).
- Resolving "Paid-Status Phantom" (ensuring paid instances vanish from future simulations).
- Enforcing Transaction-Occurrence linking constraints.

## Dependency Graph
1.  `main.py` -> `db_manager.py`, `budget_engine.py`
2.  `db_manager.py` -> `budget_engine.py`
3.  `test_financial_logic.py` -> `db_manager.py`, `budget_engine.py`, `main.py`

**Hot Spots**: 
- `main.build_financial_timeline`: Orchestrates the merging of income/bill schedules.
- `db_manager.add_transaction`: Critical entry point for ledger integrity.
- `budget_engine.get_upcoming_schedule`: Core recurrence calculation engine.

## Agent Instructions
- **Money Rule**: NEVER use `float` for currency. Always use `budget_engine.to_cents()` or `parse_money_input()`. All DB columns for money are `INTEGER`.
- **Ledger Rule**: If you modify balance logic, you MUST run `db_manager.validate_balance_consistency()` to ensure stored vs. ledger sync.
- **Persistence Rule**: `bill_occurrences` must be synced via `db_manager.sync_bill_occurrences()` before querying obligations.
- **Test First**: The suite in `test_financial_logic.py` is comprehensive. Any logic change must pass this suite (use `pytest` or `unittest`).
- **ANSI Theme**: Use the `Theme` class in `main.py` for all UI output.
