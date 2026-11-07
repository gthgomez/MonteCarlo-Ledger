# Changelog

All notable changes to Monte Carlo Ledger are documented here.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [Unreleased]

### Added
- MCP-ready read-only decision surface (`financial_snapshot`, `forecast`, `overdraft_risk`,
  `simulate_purchase`, `simulate_paycheck_delay`, `compare_debt_strategies`, `validate_scenario`,
  `engine_capabilities`) with typed failures, fail-closed validation, assumptions and provenance.
- Synthetic-household CLI journeys executed in subprocesses, plus desktop/mobile browser E2E
  journeys against a production build.
- Property/metamorphic contract tests (trough monotonicity, seed replay, order independence,
  zero-interest debt, exclusions, overflow).

### Changed
- **Contract 2.0 released** (2026-11-07) after fresh three-engine conformance: 38/38 fixtures,
  0 divergences; six injected divergences were all detected.
- One contract-version policy across Python, Kotlin and TypeScript: a version-less scenario means
  the latest released version; canonical inputs must declare a version; malformed explicit values
  are rejected everywhere.
- Decision/MCP operations are read-only end to end (no bill-occurrence side effects).
- Widget and dashboard share one canonical simulation configuration (same runs, seed, calibration).

### Fixed
- `validate_scenario` could report `valid: true` without running schema validation; it now fails
  closed and reports which stages ran.
- Schemas ship inside the distribution, so runtime validation works in a real install.
- The `overdraft` CLI command exited 2 on success.
- Ledger restore is transactional and snapshot-version checked; rejected or interrupted restores
  preserve the existing ledger exactly.
- Web no longer claims a positive P10 floor means "without risking negative balance".
- Android no longer silently defaults a malformed `contract_version`; product scenarios stamp the
  released version.

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
- `docs/archive/upgrade-plan-2026-04-09.md` — archived upgrade plan with forward-looking engineering decisions from the 0.2.0 cycle
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
