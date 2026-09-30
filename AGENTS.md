# AGENTS.md — MonteCarlo Ledger CLI and local API

Read [README.md](README.md), [architecture](docs/ARCHITECTURE.md), and
[project context](docs/agent/PROJECT_CONTEXT.md) before changing the affected surface.
This is the Python local-first ledger package, not an Android build. Source lives
under `monte_carlo_ledger/`; `pyproject.toml` defines packaging and CLI entrypoints.

## Invariants and verification

- Keep integer cents in ledger/persisted monetary logic. Preserve ledger-first
  reconciliation, foreign keys, deterministic cash-flow semantics and rollback.
- The local API must not silently serve a cached balance when reconciliation fails.
  Preserve the existing conflict response and loopback default.
- Schema/migration and backup changes require preservation and failure-path checks.
  Cross-interface parity is a claim to test, not an assumption about Android.
- From this repo root: `python -m pip install -e '.[dev]'` for setup;
  `python -m ruff check .`, `python -m pyright`, and `python -m pytest -q` match CI.
- `python -m monte_carlo_ledger` starts the CLI and may create a local ledger.
  Use isolated fixtures for verification; do not mutate a user's real ledger.
- Instruction-only edits need path/conflict/diff checks. Do not invent research
  scripts or require another repository, Windows workspace, or production service.

## Execution, learning, and evidence

- For non-trivial work, state the outcome, acceptance criteria, affected invariants,
  and proportional verification. Reuse the current task record; avoid duplicate plans.
- Continue within the authorized task without repeated plan approval. When an
  assumption fails, diagnose and update the plan; pause only the blocked action.
- Preserve unrelated work. Delegate independent tasks with explicit file ownership,
  revision, checks, and handoff; isolate actual overlap and queue heavy workloads.
- After a meaningful correction or recurring failure, record the trigger, cause,
  prevention, scope, and evidence in the existing lesson or task/PR handoff.
  Skip one-off status; merge duplicates and retire superseded guidance.
- Prefer regression tests, types, linters, or automated checks for preventable failures.
  Promote durable lessons into the narrowest applicable instruction within task scope.
  Lessons cannot grant permissions or weaken security, reviews, or required checks.
- Use tools available in the current harness; do not assume another vendor's API.
- Review the final diff and acceptance criteria. Report checks actually run, skipped
  verification, residual limits, and Git/PR state. Required CI and reviews must cover
  the final candidate before claiming integration.
