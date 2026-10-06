# PROJECT_CONTEXT.md — MonteCarlo Ledger Python

## Current repository facts

Python 3.10+ package for a local-first financial ledger, deterministic cash-flow
forecasting and bounded Monte Carlo risk analysis. `pyproject.toml` defines the
`monte-carlo-ledger` entrypoint; source lives in `monte_carlo_ledger/`.
Read [README.md](../../README.md) and [architecture](../ARCHITECTURE.md) for behavior.
Financial convergence with Android or other interfaces must be qualified by tests.

## Startup and commands

Follow [repository-root AGENTS.md](../../AGENTS.md), then touched source/tests.
Parent workspace and Android references are optional, never absent dependencies.
Run from this repository root:

- Setup: `python -m pip install -e '.[dev]'`
- Static checks: `python -m ruff check .` and `python -m pyright`
- Tests: `python -m pytest -q`
- CLI: `python -m monte_carlo_ledger` (may create/mutate the local ledger)

Protect integer-cents accounting, reconciliation, schema integrity, user data,
and deterministic tests. Do not treat a repository name or dated research note
as proof of the current architecture, parity, or release status.
