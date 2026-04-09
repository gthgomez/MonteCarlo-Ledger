# Project Context: Monte Carlo Budget Simulator

High-density context for the packaged Python CLI financial forecasting tool.

## Core Architecture
- **Tech Stack**: Python 3.10+, FastAPI, SQLite, Ruff, Pyright, Pytest.
- **Design Pattern**: 
    - **Package Layout**: `monte_carlo_ledger/cli.py` (CLI/UI), `monte_carlo_ledger/db_manager.py` (Persistence/Ledger), `monte_carlo_ledger/budget_engine.py` (Pure Logic/Math), `monte_carlo_ledger/forecasting.py` (deterministic forecast), `monte_carlo_ledger/risk.py` (Monte Carlo).
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
**Focus**: Production-shaped polish.
The current repo focus is no longer just feature integration; it is now about making the project
read like a deliberate systems project:
- persistence integrity and cascade-safe schema behavior
- package boundaries and compatibility shims
- automated quality gates and CI
- clear documentation and reviewability

## Dependency Graph
1. `monte_carlo_ledger/cli.py` -> `forecasting.py`, `risk.py`, `timeline_service.py`, `db_manager.py`
2. `monte_carlo_ledger/timeline_service.py` -> `db_manager.py`, `budget_engine.py`, `domain_rules.py`
3. `monte_carlo_ledger/db_manager.py` -> `budget_engine.py`, `domain_rules.py`
4. Legacy root wrappers forward imports to the package for compatibility.

**Hot Spots**: 
- `monte_carlo_ledger/timeline_service.py`: Merges income and bill schedules.
- `monte_carlo_ledger/db_manager.py:add_transaction`: Critical entry point for ledger integrity.
- `monte_carlo_ledger/budget_engine.py:get_upcoming_schedule`: Core recurrence calculation engine.
- `monte_carlo_ledger/risk.py`: Deterministic-to-probabilistic bridge.

## Agent Instructions
- **Money Rule**: NEVER use `float` for currency in persistence or core logic. All DB columns for money are `INTEGER`.
- **Ledger Rule**: If you modify balance logic, run `db_manager.validate_balance_consistency()` and the full test suite.
- **Persistence Rule**: `bill_occurrences` must be synced via `db_manager.sync_bill_occurrences()` before querying obligations.
- **Quality Gate**: Treat `python -m pytest -q`, `python -m ruff check .`, and `python -m pyright` as the minimum completion bar.
- **CLI Theme**: Use the `Theme` class in `monte_carlo_ledger/cli.py` for terminal output.
