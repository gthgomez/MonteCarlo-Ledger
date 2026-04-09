# Engineering Walkthrough

This walkthrough explains how the repo evolved from a useful prototype into a more
review-friendly, production-shaped project.

Each phase was completed with an audit and verification gate before moving forward.

## Phase 1: Persistence Integrity

Problem:
- The old schema allowed orphaned `bill_occurrences` records after payment deletion.
- SQLite foreign keys were declared but not actively enforced on connections.

What changed:
- Foreign keys are enabled on every database connection.
- `bill_occurrences.payment_id` now cascades on delete.
- Existing databases migrate through a v10 schema upgrade that preserves valid rows and cleans
  invalid legacy references.

Why it matters:
- The persistence layer now protects integrity directly instead of relying on query behavior to
  hide corruption.

## Phase 2: Package and Module Boundaries

Problem:
- The project looked like a growing script collection.
- `main.py` mixed UI, forecasting, risk math, and orchestration.

What changed:
- The code now lives under the `monte_carlo_ledger` package.
- Forecast logic moved into `forecasting.py`.
- Monte Carlo logic moved into `risk.py`.
- Tests and helper scripts now import the package directly.

Why it matters:
- The repo now reads like an intentional Python project instead of a gradually expanding script
  collection.

## Phase 3: Tooling and CI

Problem:
- The repo had tests, but the quality bar was not visible at a glance.
- Packaging metadata and automated gates were missing.

What changed:
- Added `pyproject.toml` with installable package metadata and a console entry point.
- Added Ruff, Pyright, and GitHub Actions CI.
- Cleaned test scripts so they behave like real tests instead of ad hoc validation scripts.

Why it matters:
- A reviewer can immediately see that correctness is automated, not assumed.

## Phase 4: Documentation Refresh

Problem:
- Docs had drifted away from the current codebase.
- The README undersold the system design.

What changed:
- Rewrote the README around product value, architecture, and quality gates.
- Added an architecture doc.
- Updated the walkthrough and repo guidance so they match the current package layout.

Why it matters:
- The repo now presents its own story instead of asking reviewers to infer it from scattered files.

## Phase 5: Property-Based Invariant Testing

Problem:
- Example-based tests were good, but recurrence and money-parsing logic still benefited from wider
  input coverage.

What changed:
- Added Hypothesis-backed property tests for money parsing round-trips.
- Added invariant tests for weekly, bi-weekly, and monthly schedule generation.

Why it matters:
- The project now demonstrates a stronger testing mindset than a typical personal finance side
  project.

## Current Verification Surface

The active verification gate is:

```bash
python -m pytest -q
python -m ruff check .
python -m pyright
```

At the time of the latest refresh, all three pass locally.
