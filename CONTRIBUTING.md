# Contributing to Monte Carlo Ledger

Thanks for taking the time. This is a personal finance tool — contributions are welcome if they stay in scope.

---

## Scope

Monte Carlo Ledger is intentionally focused: a local-first CLI and API for cash-flow forecasting with a Monte Carlo risk layer. Contributions that add hosted services, authentication, or general-purpose budgeting features are out of scope.

Good fits:
- Bug fixes in forecasting, risk, or persistence logic
- Additional property-based test coverage
- Schema migration improvements
- Improvements to the CLI/API interface
- Documentation corrections

---

## Setup

### Requirements

- Python 3.10+
- SQLite 3.25.0+

### Install dev dependencies

```bash
git clone https://github.com/gthgomez/MonteCarlo-Ledger.git
cd MonteCarlo-Ledger
pip install -e .[dev]
```

---

## Quality Gates

All three must pass before opening a PR:

```bash
python -m ruff check .
python -m pyright
python -m pytest -q
```

These run automatically in CI. PRs that fail any gate will not be merged.

---

## Monetary Logic Rules

If your change touches monetary values:

- **Integer cents only.** No floats in persistence or core logic. Use `int` throughout.
- **Ledger is authoritative.** Never update a cached balance without reconciliation.
- **Deterministic before probabilistic.** The timeline must be correct before the Monte Carlo layer runs.

These are not style preferences — they are correctness invariants.

---

## Submitting a PR

1. Fork the repo and create a branch: `git checkout -b fix/your-description`
2. Make your changes
3. Run all quality gates locally
4. Open a PR with a clear title and description of what changed and why
5. Reference any related issues

---

## Reporting Bugs

Use the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md).

Include:
- Python version (`python --version`)
- SQLite version (`python -c "import sqlite3; print(sqlite3.sqlite_version)"`)
- Steps to reproduce
- Expected vs. actual behavior

Do not include your `ledger.db` file or any personal financial data in bug reports.
