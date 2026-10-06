# MC-07 — Legacy Retirement Record

**Scope:** Python (`MonteCarlo-Ledger`). Android is recorded in
`MonteCarloLedger-Android/docs/contract-adoption.md` and
`docs/campaign/MC-07-adoption-map.md`.

The Python CLI/API were already canonical after MC-04/05. The interactive terminal was the last
user-visible surface still running the duplicate engines. This record states exactly what was
migrated, deleted, kept, and deferred, with the evidence.

## Dispositions

| Legacy item | Disposition | Replacement / rationale |
|---|---|---|
| `forecasting.calculate_safe_spend` | **DELETED** | `contract.forecast(...)["minimum_balance_cents"]` (projected low point, MCD-0008/0009). |
| `forecasting.build_balance_forecast` | **DELETED** | `contract.event_rows(scenario)` (canonical ordered events + `checked_add`). |
| `forecasting.calculate_forecast_summary` | **DELETED** | `contract.forecast` block (`minimum_balance_*`, `ending_balance_cents`, `first_negative_date`). |
| `forecasting.calculate_daily_safe_spend` | **REPLACED** | `dashboard_view.daily_pacing_cents` — **KEEP_NON_NORMATIVE** (see below). |
| `risk.run_monte_carlo` (Mersenne Twister, **inclusive** horizon, floor median, floor percentage) | **DELETED** | `decisions.risk` / `contract` risk block (SplitMix64, half-open horizon, nearest-rank, ppm — MCD-0002/0005/0006/0004). |
| `risk.generate_scenario_timeline` | **DELETED** | canonical `contract` simulation; the legacy inclusive-horizon generator contradicted MCD-0002. |
| `risk.simulate_scenario` | **DELETED** | `contract.forecast` over `ordered_events`. |
| `monte_carlo_config.MonteCarloConfig` (`MAX_RUNS`, validation) | **DELETED** | contract `simulation` block validation (`INVALID_RUNS`, defaults in `SIMULATION_DEFAULTS`). |
| `timeline_service.generate_income_events` | **DELETED** | `scenario._income_events` (the single DB→canonical bridge; MCD-0016/0017/0022). |
| `timeline_service.get_unpaid_bill_events` (30-day past-due lookback) | **DELETED** | `scenario._bill_events*`; overdue is excluded from the window (MCD-0014). |
| `timeline_service.merge_and_sort_events` | **DELETED** | canonical ordering in `contract._ordered` (`date, sequence, order` — MCD-0003/0021). |
| `timeline_service.build_financial_timeline` (defaulted to `date.today()`) | **DELETED** | `dashboard_view.build(as_of, ...)` — explicit `as_of`, no clock (MCD-0001). |
| `dashboards.show_summary` | **DELETED** | Dead code (only re-exported, never called); it read `datetime.now()` and mixed obligations with balance. |
| `dashboards.render_*` | **MIGRATED** | Render from `dashboard_view` (canonical) with an explicit `as_of`. |
| Daily pacing (`dashboard_view.daily_pacing_cents`) | **KEEP_NON_NORMATIVE** | See below. |
| Reporting aggregates (`db_manager.get_spend_by_category`, `get_flow_summary`, `get_adjustment_history`) | **KEEP_NON_NORMATIVE** | Bookkeeping over posted rows; not a projection and not in Contract 1.x. |
| Upcoming-30 schedule listing (`budget_engine.get_upcoming_schedule`) | **KEEP_NON_NORMATIVE** | A schedule listing, not a financial conclusion. |

## KEEP_NON_NORMATIVE: daily pacing

Contract 1.x defines no daily-pacing concept, so this calculation is retained but classified
outside the contract:

- **Why it is outside Contract 1.x:** there is no contract equation for "per-day spend guidance";
  the contract models money over a horizon, not a daily velocity.
- **Why it is safe not to conform:** it is derived from the canonical projected low point
  (`daily_pacing_cents(low_point, days)`) so it cannot contradict the canonical number rendered
  beside it, and it returns 0 when the low point is non-positive.
- **UI language:** the terminal labels it "DAILY PACING (guidance, not a contract value)". It is
  never labelled "safe to spend".

## Clock cleanup

The interactive surfaces no longer read the wall clock for financial placement:

- `cli.py` captures `as_of = date.today()` once at the boundary and passes it down (unchanged
  design; now the only clock use on the interactive path).
- `dashboards.py` and `dashboard_view.py` are clock-free (verified by AST scan in
  `tests/test_dashboard_view.py`).
- The `datetime.now()` calls in `show_summary` and `render_timeline_dashboard` are gone.

## Deletion accounting

- Legacy finance modules deleted: **4** (`forecasting.py`, `risk.py`, `monte_carlo_config.py`,
  `timeline_service.py`).
- Duplicate public functions deleted: **7** (`calculate_safe_spend`, `build_balance_forecast`,
  `calculate_forecast_summary`, `run_monte_carlo`, `generate_scenario_timeline`,
  `simulate_scenario`, `build_financial_timeline`).
- Legacy-only test modules deleted: **2** (`test_risk_clock_contract.py`,
  `test_risk_config_contract.py`).
- New canonical modules: **1** (`dashboard_view.py`) plus `contract.event_rows` /
  `contract.ordered_events`.

## Evidence

Run on this branch (Python 3.10.1, pytest 8.4.2):

```
python -m pytest
-> 131 passed in 131.46s
```

The count fell from the pre-MC-07 **165 passed** because the two deleted legacy-engine test modules
(`test_risk_clock_contract.py` 9, `test_risk_config_contract.py` 20) and the legacy Monte Carlo
tests asserted the superseded semantics. Their coverage is replaced by:

- `tests/test_contract_conformance.py` (27) — canonical engine over the golden corpus.
- `tests/test_dashboard_view.py` (new) — canonical interactive view, legacy removal, clock-free core.
- `tests/test_financial_logic.py` — rewritten financial classes now assert canonical results.
- `tests/test_refactor_verification.py` — canonical end-to-end (DB → scenario → contract → API).

`ruff` and `pyright` are declared dev dependencies but are not installed in this environment; the
runnable verification is `pytest`.
