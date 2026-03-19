# MonteCarlo-Ledger

**A personal finance CLI with a ledger-first SQLite backend and a Monte Carlo risk engine.**

Instead of tracking a cached balance, every dollar in this tool is derived from the sum of all transactions — a proper double-entry approach in a local SQLite database. Monte Carlo simulation then stress-tests your 90-day forecast across 500 scenarios to give you a P10 worst-case safe-to-spend number.

---

## What It Is

A command-line tool for personal budgeting that combines:
- **Ledger-first accounting** — your balance is always computed from your transaction history, never stored as a mutable field
- **Deterministic Monte Carlo** — 500 forward simulations with a fixed seed, so identical financial data produces identical output every time
- **Local-only design** — all data stays on your machine in `budget.db`; nothing is sent anywhere

## Why Ledger-First + Deterministic Monte Carlo

Most budgeting tools store a balance and mutate it. That approach silently drifts under concurrent writes or migration failures. A ledger approach makes every transaction an immutable fact — the balance is always a derivation, never a source of truth.

Monte Carlo adds honest uncertainty. A single 90-day projection is a guess. 500 projections with randomized income variance and surprise expenses give you a distribution — and reporting the P10 outcome tells you what to expect if things go reasonably wrong.

---

## Requirements

- Python 3.9+
- SQLite 3.25.0+ (ships with Python on most platforms)

## Quick Start

```bash
# Clone the repo
git clone https://github.com/gthgomez/MonteCarlo-Ledger.git
cd MonteCarlo-Ledger

# Install dependencies
pip install -r requirements.txt

# Run the CLI
python main.py
```

On first run, the app walks you through onboarding: set your current balance, add income sources, and add recurring payments. All data is stored locally in `budget.db`.

> **Note:** `budget.db` is created in the project directory on first run and is intentionally gitignored. It contains your personal financial data and will never be committed to the repository.

---

## Features

- **Ledger-first accounting** — balance is derived from the sum of all transactions, not a cached number
- **Deterministic 90-day forecast** — merges recurring bills and income schedules into a chronological timeline
- **Monte Carlo risk engine** — injects ±8% income variance and random surprise expenses across 500 runs, reports the P10 worst-case outcome
- **Interactive CLI** — guided onboarding and full CRUD for income sources, payments, and transactions
- **FastAPI layer** — exposes a local `GET /safe-to-spend` endpoint for programmatic access

---

## Running the API

> **Local use only.** The API has no authentication. It is designed to run on `127.0.0.1` and should never be exposed to an external network or the public internet.

```bash
python -m uvicorn api:app --reload --host 127.0.0.1 --port 8000
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/safe-to-spend` | Returns the maximum safe spend amount in cents before the next income event |

**Query parameters:**

- `days_ahead` (int, default `30`, range `1–365`) — forecast window

**Example response:**
```json
{
  "safe_spend_cents": 45200,
  "days_ahead": 30
}
```

Returns `409 Conflict` if the cached balance and the transaction ledger are out of sync — use the CLI reconciliation flow to fix.

---

## Running Tests

```bash
pytest -q
```

Or target specific suites:

```bash
pytest test_financial_logic.py test_budget_engine.py test_api.py -q
python test_int_safety.py
```

All test databases are created in-process and deleted in `tearDown`. No persistent test data is written.

---

## Monte Carlo Defaults

Simulation parameters are defined in [`monte_carlo_config.py`](./monte_carlo_config.py):

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `runs` | 500 | Number of simulated scenarios |
| `seed` | 42 | Random seed — **outputs are deterministic** given identical input data |
| `income_variation_min/max` | ±8% | Income variance per scenario |
| `surprise_probability` | 15% | Chance of a surprise expense every 14 days |
| `surprise_amount_min/max` | $20–$150 | Range of surprise expense amounts |
| `worst_percentile` | P10 | Reported worst-case outcome threshold |

Because `seed=42` is the default, two users with identical financial data will get identical simulation outputs. Override `seed` in `MonteCarloConfig` if you need non-deterministic runs.

---

## Architecture

```
main.py            — CLI shell, Monte Carlo orchestration
db_manager.py      — SQLite persistence, ledger logic, migrations
budget_engine.py   — Pure financial math (money parsing, scheduling)
timeline_service.py — Future event projection and timeline merging
api.py             — FastAPI wrapper (local use only)
domain_rules.py    — Transaction sign and integrity validation
monte_carlo_config.py — Simulation parameter dataclass
schema.sql         — Database schema and initial data
```

All monetary values are stored and processed as **integer cents**. Float arithmetic is forbidden in persistence and core math to prevent drift.

---

## Status

Working local tool. Not packaged for distribution. The API layer is local-only and has no authentication — treat it as a development convenience, not a production service.

---

## License

MIT
