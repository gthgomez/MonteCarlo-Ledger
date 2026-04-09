---
name: validate-ledger-integrity
description: Validates ledger, transaction-sign, and balance-reconciliation behavior in the Monte Carlo Budget Simulator. Use when changing persistence, balances, transaction flows, or money parsing.
---

# Validate Ledger Integrity

## Workflow

1. Read `PROJECT_CONTEXT.md`, `AGENTS.md`, and `.agents/rules/02-ledger-and-money-invariants.md`.
2. Inspect the touched files in `db_manager.py`, `budget_engine.py`, `main.py`, or `schema.sql`.
3. Run the narrowest relevant checks:
   ```powershell
   pytest .\test_financial_logic.py -q
   pytest .\test_budget_engine.py .\test_api.py -q
   python .\test_int_safety.py
   ```
4. If balance logic changed, explicitly verify reconciliation behavior through `db_manager.validate_balance_consistency()`.
5. Report the first failing test or a clean validation summary.
