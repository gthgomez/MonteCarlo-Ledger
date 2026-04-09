# Architecture

This document is the shortest path from "interesting idea" to "I understand how this repo is
organized."

## System Shape

```text
monte_carlo_ledger/
├── cli.py              Composition root and CLI entrypoint
├── api.py              Local FastAPI surface
├── ui.py               Terminal formatting and input primitives
├── dashboards.py       Read-only dashboard rendering
├── workflows.py        Stable facade for interactive workflows
├── workflow_onboarding.py First-run setup flow
├── workflow_payments.py   Bill management and payment flows
├── workflow_income.py     Income source and payday flows
├── workflow_account.py    Reconciliation and account correction flows
├── workflow_reporting.py  Read-only reporting and schedule views
├── forecasting.py      Deterministic balance forecast math
├── risk.py             Monte Carlo scenario generation and aggregation
├── timeline_service.py Timeline assembly from income + bill schedules
├── db_manager.py       SQLite persistence, migrations, reconciliation
├── budget_engine.py    Date normalization and recurrence helpers
├── domain_rules.py     Accounting and linkage invariants
├── monte_carlo_config.py
└── schema.sql
```

## Data Flow

1. The CLI entrypoint delegates to `dashboards.py` and the `workflows.py` facade.
2. The workflow facade routes interactive commands into domain-specific modules:
   - onboarding
   - payments
   - income
   - account reconciliation
   - reporting
3. `timeline_service.py` builds a chronological event stream from:
   - recurring payments
   - unpaid bill occurrences
   - projected income events
4. `forecasting.py` simulates the running balance over that event stream.
5. `risk.py` perturbs the deterministic timeline with bounded income variance and surprise expenses.
6. `db_manager.py` remains the authority for persistence, migrations, and balance reconciliation.

## Reading Order

If you are reviewing the repo for the first time, this is the most useful order:

1. `README.md` for product intent and engineering posture.
2. `monte_carlo_ledger/cli.py` for the main application surface.
3. `monte_carlo_ledger/timeline_service.py` for timeline assembly.
4. `monte_carlo_ledger/forecasting.py` for deterministic balance projection.
5. `monte_carlo_ledger/risk.py` for the probabilistic overlay.
6. `monte_carlo_ledger/db_manager.py` for persistence integrity and migrations.

## Design Decisions

### Ledger-first accounting

The canonical account balance is the sum of all transactions. The cached balance in `settings`
exists for convenience and rendering speed, but every critical surface can reconcile against the
ledger.

### Integer cents everywhere

All stored and core monetary values are integers. This avoids drift and makes equality,
reconciliation, and regression testing much more trustworthy.

### SQLite with explicit migrations

SQLite keeps the project local-first and easy to run, while versioned migrations let the schema
evolve safely. Recent hardening work added enforced foreign keys and cascade-safe bill occurrence
relationships.

### Deterministic baseline, probabilistic overlay

The deterministic timeline answers “what happens if the schedule is exactly right?”
The Monte Carlo layer answers “how fragile is that answer under bounded uncertainty?”

## Quality Gates

- `python -m pytest -q`
- `python -m ruff check .`
- `python -m pyright`

These are also codified in GitHub Actions under `.github/workflows/ci.yml`.
