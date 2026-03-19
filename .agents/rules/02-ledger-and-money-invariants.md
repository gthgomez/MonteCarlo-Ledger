# Montecarlo Budget Sim Ledger And Money Invariants

Read this rule before changing monetary logic, persistence, or timeline generation.

## Protected Invariants

1. Money values are integer cents in storage and core math.
2. Ledger balance is the source of truth; stored balance must reconcile against it.
3. Transaction sign enforcement stays strict.
4. `bill_occurrences` must be synchronized before obligation queries.
5. Timeline and risk-engine logic must not leak paid or one-time overrides into later periods.
6. Prefer existing helpers such as `budget_engine.to_cents()` and `parse_money_input()` over ad hoc conversions.

## High-Risk Paths

- `budget_engine.py`
- `db_manager.py`
- `main.py`
- `timeline_service.py`
- `schema.sql`

## Verification

- Run targeted financial tests after any accounting change.
- Use `db_manager.validate_balance_consistency()` when balance logic moves.
- Do not claim a financial fix without a passing test or direct reconciliation check.
- If recurring schedule logic changed, mention the projection and paid-occurrence impact explicitly.
