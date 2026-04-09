# Changelog

All notable changes to Monte Carlo Ledger are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

---

## [0.3.0] — 2026-04-09

### Changed
- Removed legacy root compatibility surface (`workflows.py` root shim) — callers now import directly from domain modules
- Cleaned internal workspace artifacts from public export

### Internal
- Repository polish pass: README context sections, architecture diagram link, project layout table

---

## [0.2.0] — 2026-03-20

### Added
- `dashboards.py` — read-only dashboard rendering separated from workflow logic
- `workflow_reporting.py` — reporting and schedule views isolated as a workflow module
- `docs/upgrade-plan.md` — forward-looking engineering decisions
- GitHub Actions CI: ruff + pyright + pytest gates on every push

### Changed
- `workflows.py` promoted to a stable facade over `workflow_*.py` domain modules
- Foreign-key enforcement added to all payment/bill linkage operations in `db_manager.py`
- `domain_rules.py` now validates accounting invariants and orphan prevention explicitly

### Fixed
- Orphaned bill occurrences after payment deletion — FK enforcement now prevents this at the schema level

---

## [0.1.0] — 2026-03-19

### Added
- Initial public release
- `monte_carlo_ledger/` package: CLI, local FastAPI surface, forecasting, risk, timeline, persistence
- Ledger-first SQLite core with integer-cent monetary arithmetic
- Deterministic 90-day cash-flow timeline before Monte Carlo simulation
- `docs/ARCHITECTURE.md` and `docs/engineering-walkthrough.md`
- MIT license
- `pyrightconfig.json`, `ruff` configuration in `pyproject.toml`
- Property-based tests via Hypothesis for money parsing and recurrence logic

---

[Unreleased]: https://github.com/gthgomez/MonteCarlo-Ledger/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/gthgomez/MonteCarlo-Ledger/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/gthgomez/MonteCarlo-Ledger/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/gthgomez/MonteCarlo-Ledger/releases/tag/v0.1.0
