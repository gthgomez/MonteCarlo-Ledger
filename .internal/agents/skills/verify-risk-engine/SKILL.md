---
name: verify-risk-engine
description: Verifies forecast timeline and Monte Carlo risk behavior in the Monte Carlo Budget Simulator. Use when changing expected income handling, recurrence logic, occurrence linking, or simulation behavior.
---

# Verify Risk Engine

## Workflow

1. Read `PROJECT_CONTEXT.md`, `AGENTS.md`, and `.agents/rules/02-ledger-and-money-invariants.md`.
2. Inspect the touched forecasting files, usually `main.py`, `timeline_service.py`, `budget_engine.py`, or `db_manager.py`.
3. Run the focused verification set:
   ```powershell
   pytest .\test_refactor_verification.py .\test_financial_logic.py -q
   python .\reproduce_issues.py
   ```
4. Confirm the change does not reintroduce:
   - projection bleed
   - paid-status phantom behavior
   - occurrence-linking drift
5. Report the observed behavior and the first failing check, if any.
