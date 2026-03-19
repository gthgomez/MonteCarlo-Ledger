# AGENTS.md - Monte Carlo Budget Sim

Purpose: fast startup and safe execution in the Monte Carlo Budget Simulator.

## Read Order

1. `PROJECT_CONTEXT.md`
2. This file
3. Relevant files in `.agents/rules/`
4. Relevant files in `.agents/skills/`

## What This Repo Is

A Python CLI and FastAPI budget forecasting tool with a ledger-first SQLite backend and a Monte Carlo risk engine.

## Repo Layout

- `.agents/rules/` — accounting and persistence invariants
- `.agents/skills/` — reusable workflows for ledger validation and risk-engine verification

## High-Risk Zones

- `db_manager.py`
- `budget_engine.py`
- `timeline_service.py`
- `main.py`
- `api.py`
- `schema.sql`
- `budget.db` (runtime only — gitignored)

## Non-Negotiables

- Never use `float` for persisted or core monetary values.
- Preserve ledger-first accounting and balance reconciliation.
- Keep transaction sign enforcement intact.
- Sync `bill_occurrences` before querying future obligations.
- Treat timeline merges and Monte Carlo risk logic as correctness-critical.

## Quick Commands

CLI and API:
```powershell
python .\main.py
python -m uvicorn api:app --reload --host 127.0.0.1
```

Tests:
```powershell
pytest -q
pytest .\test_financial_logic.py -q
pytest .\test_budget_engine.py .\test_api.py .\test_refactor_verification.py -q
python .\test_int_safety.py
```

## How To Work Here

- Read `.agents/rules/02-ledger-and-money-invariants.md` before touching balance, transaction, or timeline logic.
- Read `.agents/rules/03-execution-and-verification.md` for plan-vs-act and evidence expectations.
- Read `.agents/rules/04-context-loading-and-contract-safety.md` before changing persistence, API, or forecasting contracts.
- Use the ledger validation skill for any change that touches persistence or money flow.
- Prefer the narrowest possible logic change and verify with tests immediately.
