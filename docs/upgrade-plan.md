# Monte Carlo Ledger Upgrade Plan

This document turns the repo audit into a concrete upgrade plan aimed at making the project read like a deliberate, high-signal systems project in a hiring review.

## Goals

- Eliminate correctness and integrity red flags.
- Improve architecture so the repo looks intentionally designed, not organically grown.
- Raise presentation quality so a reviewer can understand the value quickly.
- Add tooling that signals strong engineering habits.

## Priority Order

### 1. Persistence Integrity and Schema Safety
Status: `completed`

Why this comes first:
- It is the most serious trust issue in the repo.
- A hiring manager will penalize known data corruption risk more heavily than style or packaging issues.
- It has a contained blast radius and clear verification path.

Scope:
- Enable SQLite foreign key enforcement on every connection.
- Remove orphaned `bill_occurrences` behavior.
- Add a migration that upgrades existing databases to cascade-safe foreign keys.
- Prove the fix with targeted persistence tests.

Definition of done:
- Deleting a payment cannot leave orphaned occurrences behind.
- Existing databases migrate cleanly.
- Financial and persistence tests pass.

### 2. Package and Module Boundaries
Status: `completed`

Why:
- `main.py` is too large and mixes UI, orchestration, and core logic.
- The repo currently feels like a solid prototype rather than a shaped codebase.

Scope:
- Convert the repo into an installable package.
- Split `main.py` into focused modules such as `cli`, `core.forecast`, `core.risk`, and `core.rendering`.
- Remove `sys.path.append(...)` and `type: ignore` import workarounds.
- Add a clean CLI entry point.

Definition of done:
- No path hacks.
- Smaller, purpose-driven modules.
- Clear import graph and easier test targeting.

### 3. Professional Tooling and CI
Status: `completed`

Why:
- Strong projects advertise their quality gates.
- This is one of the fastest ways to signal professionalism to reviewers.

Scope:
- Add `pyproject.toml`.
- Add Ruff and a real type-checking command.
- Add GitHub Actions for tests, linting, and type checks.
- Standardize local dev commands.

Definition of done:
- A reviewer can see automated quality checks immediately.
- The repo can be validated with a short documented command set.

### 4. Documentation and Trust Surface
Status: `completed`

Why:
- The current repo has good ideas but undersells them.
- Doc drift weakens credibility.

Scope:
- Refresh `README.md` so it matches the current code and tests.
- Add a real `LICENSE` file.
- Replace stale claims and outdated test counts.
- Add a short architecture diagram and a “design decisions” section.

Definition of done:
- Docs match reality.
- The value proposition is clear in under two minutes.
- A recruiter or engineer can skim and understand why this project is interesting.

### 5. Standout Engineering Signals
Status: `completed`

Why:
- This is how the repo moves from “good personal project” to “memorable”.

Implemented:
- Added property-based invariant tests for money parsing and recurrence scheduling using Hypothesis.

Definition of done:
- At least one element makes a reviewer think, “this person went beyond the obvious.”

## Completed Work

- Foreign keys enforced on every SQLite connection.
- New database migration for cascade-safe `bill_occurrences` relationships.
- Package layout introduced under `monte_carlo_ledger/` with compatibility shims.
- Installable package metadata, Ruff, Pyright, and GitHub Actions CI added.
- README, architecture docs, and project guidance refreshed.
- Property-based tests added for recurrence and money parsing invariants.

## Verification Plan

- `python -m pytest -q`
- Confirm balance reconciliation behavior still passes through `db_manager.validate_balance_consistency()`

## Status

The planned upgrade track in this document has been completed.
