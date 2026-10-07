# MC-07 — Python interactive adoption (dashboards, forecast/risk displays)

**Milestone:** migrate the remaining interactive Python surfaces onto the contract
decision layer, and clear the remaining native bugs B-01…B-04.
**Status:** Complete.
**Branch:** `campaign/python-interactive-adoption`

## What changed

- `monte_carlo_ledger/dashboards.py` now sources every financial number from the
  contract engine via `decisions`:
  - `render_forecast_dashboard` → `decisions.forecast_detail` (deterministic
    forecast + per-event running balances from the contract engine's own walk).
  - `render_monte_carlo_dashboard` → `decisions.risk` (ppm probability, trough
    P10/P50, ending P10/P50, `projected_low_point_cents`, `safe_to_spend_cents`).
  - `render_timeline_dashboard` / `show_summary` → `decisions.forecast` with an
    explicit `as_of`.
  - Labels corrected per MCD-0008: the deterministic low point is shown as
    "PROJECTED LOW POINT", never "FREE TO SPEND"; the quantile value is shown as
    "SAFE TO SPEND".
- `contract/engine.py` gained `forecast_rows` / `scenario_rows`: non-normative
  display helpers that reuse the exact `forecast` walk, so a displayed row can
  never disagree with the canonical aggregate. `result.schema.json` is unchanged.
- `decisions.forecast_detail` exposes those rows without adding financial math to
  the decision layer.
- `workflow_reporting.py` requires and threads `as_of` (`handle_forecast`,
  `handle_risk_outlook`, `handle_upcoming_schedule`, `view_upcoming_30`); no
  display path reads the wall clock. `cli.py` captures `date.today()` once at the
  menu boundary.
- `forecasting.py`, `risk.py`, and `timeline_service.py` are now clearly marked
  deprecated shims, kept only for existing importers and their regression tests.

## Native bugs B-01…B-04

| Bug | Disposition |
|---|---|
| B-01 `datetime.now()` in seeded simulation | Already fixed by MC02 (`risk.run_monte_carlo`/`generate_scenario_timeline` require explicit `as_of`). Also removed the `date.today()` default from `timeline_service.build_financial_timeline` (now required keyword). |
| B-02 floor-division percentage | Fixed in `risk.py`: uses the contract's `scale_cents_by_percent` (MCD-0007). |
| B-03 `expected_amount` dropped before window | Fixed in `timeline_service.generate_income_events`: applies to the first in-window occurrence (MCD-0017). `scenario.py` already conformed. |
| B-04 floored even median | Fixed in `risk.py`: P50 uses the contract's `nearest_rank` (MCD-0005). |

## Evidence

```
pytest            181 passed
ruff              All checks passed
pyright           1 pre-existing error only (fastapi import resolution)
conformance       contract fixtures unchanged and passing
```

## Semantic decisions made

None new. The surfaces encode MCD-0001, 0002, 0004, 0005, 0007, 0008, 0017.

## Remaining risks

- The `dashboards` risk outlook runs 500 contract simulations on demand; this is
  the same cost as the previous Monte Carlo path but now with the contract PRNG.
- The deprecated shims (`forecasting`, `risk`, `timeline_service`) remain for
  importers/tests; they should be removed in a later cleanup once no external
  importer depends on them.
- `db_manager` retains pre-existing wall-clock defaults for transaction dates and
  reporting windows (not forecast/risk paths).
