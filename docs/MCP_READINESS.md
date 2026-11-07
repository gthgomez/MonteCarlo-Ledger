# MCP Readiness — MonteCarlo-Ledger internal tool surface

**Status: ready for adapter design. No MCP server is shipped in this campaign — by design.**

This document defines the stable *internal* surface a future MCP adapter should bind to, the
result/error schemas it may rely on, and the security boundary it must enforce. Everything here
already exists and is exercised by `tests/test_mcp_adapter_contract.py` (adapter-facing contract
tests that run the real core against a synthetic seeded ledger).

## 1. Where the adapter must bind

One rule: **the adapter never computes financial conclusions itself.** Every number comes from the
canonical engine (`monte_carlo_ledger/contract/run_scenario`) through the decision operations in
`monte_carlo_ledger/decisions.py`:

| Candidate MCP operation | Existing Python surface | Notes |
|---|---|---|
| `get_financial_snapshot` | `decisions.financial_snapshot()` | balances, reconciliation, counts, freshness, `data_source` |
| `forecast_cash_flow` | `decisions.forecast(as_of, horizon_days)` | deterministic; explicit `as_of` required |
| `estimate_overdraft_risk` | `decisions.overdraft_risk(as_of, horizon_days, sim)` | flattened summary + full canonical `risk` block |
| `get_spending_buffer` | `decisions.risk(...).risk.safe_to_spend_cents` | quantile trough − reserve (MCD-0008); pass `reserve_cents` via `sim` |
| `simulate_purchase` | `decisions.simulate_purchase(amount_cents, purchase_date, as_of, ...)` | baseline vs scenario + `change` deltas, identical seed |
| `simulate_paycheck_delay` | `decisions.simulate_paycheck_delay(delay_days, as_of, ...)` | baseline vs delayed + deltas, identical seed |
| `compare_debt_payoff_strategies` | `decisions.compare_debt_strategies(liabilities, as_of, extra_monthly_payment_cents)` | canonical amortization + explicit cash-flow caveat |
| `validate_scenario` | `decisions.validate_scenario(scenario)` | fail-closed schema-then-engine verdict, no side effects |
| `get_engine_capabilities` | `decisions.engine_capabilities()` | contract version, supported versions, bounds, op list |

`compare_scenarios` exists for arbitrary what-if pairs; do not add further decision handlers
without first checking whether it is expressible with the operations above. The alternative local
HTTP binding is the FastAPI app (`monte_carlo_ledger/api.py`, loopback-only) — an adapter may call
either, but must not fork the logic.

## 2. Result contract

Every operation returns plain JSON-serialisable dicts whose financial blocks are the canonical
engine output (validated by `schemas/result.schema.json`):

- `forecast`: `minimum_balance_cents`, `minimum_balance_date`, `ending_balance_cents`,
  `first_negative_date` (nullable).
- `risk`: `negative_balance_probability_ppm`, `minimum_balance_p10/p50/p90_cents`,
  `ending_balance_p10/p50/p90_cents`, `projected_low_point_cents`, `safe_to_spend_cents`.
- `debt` (when liabilities are declared): `strategy`, `months_to_payoff`, `payoff_date`,
  `total_interest_cents`, `total_paid_cents`, `did_not_converge`, `schedule[]`.
- `ledger` (every decision op: `forecast`, `risk`, `overdraft_risk`,
  `simulate_purchase`, `simulate_paycheck_delay`, `compare_scenarios`,
  `compare_debt_strategies`): `source`, `contract_version`, `as_of`, `horizon_days`,
  `read_only`, `hypothetical`, `balance_consistent`, `ledger_balance_cents`,
  `stored_balance_cents`, `cached_balance_cents`, `bank_balance_cents` (nullable),
  `reconciled_with_bank`, `snapshot` (`transaction_count`, `income_source_count`,
  `payment_count`, `newest_transaction_date`), `model` (`basis`, `assumptions`) and,
  where applicable, `simulation` (`runs`, `seed`). This is provenance, not a financial
  input: the forecast always uses the authoritative transaction sum, and an
  unexplained cache/bank difference is surfaced so an adapter does not present it as
  trustworthy spending capacity. `financial_snapshot()` carries `source`,
  `contract_version`, `read_only` and `hypothetical` directly.

Every operation derives the calculation **and** this provenance from one
`db_manager.read_ledger_view()` SQLite read transaction. A ledger edit made while a
decision is running therefore cannot make the numbers and the provenance describe
different revisions.

Money is **integer cents** (MCD-0007 rounding, MCD-0020 overflow-is-error), probabilities are **ppm**
(MCD-0004), quantiles use nearest-rank (MCD-0005), and time is **explicit `as_of` date-only**
(MCD-0001/0002) — the engine never reads a clock. Determinism: identical inputs (including `seed`)
yield bit-for-bit identical output; the adapter contract tests assert this.

## 3. Failure contract — fail closed

An operation either returns a canonical result or raises `monte_carlo_ledger.contract.ContractError`
with a stable machine-readable `code` (`SCHEMA_INVALID`, `MISSING_AS_OF`, `INVALID_DATE`,
`INVALID_AMOUNT`, `INVALID_HORIZON`, `INVALID_RUNS`, `INVALID_SEED`, `INVALID_QUANTILE`,
`INVALID_EVENT_TYPE`, `EVENT_OUT_OF_HORIZON`, `MONEY_OVERFLOW`, ...). There is **no** code
path that converts a failure into a zero, a "0% risk", or a default. An adapter MUST map exceptions
to tool errors (`isError: true`) carrying `err.code` — never swallow them into a numeric result.

`engine_capabilities().limits` declares the central execution bounds that both the
programmatic surface and the loopback HTTP API enforce: `max_horizon_days`,
`max_runs`, `max_quantile`, `max_reserve_cents`, `max_amount_cents`.

`compare_scenarios(first, second, ...)` accepts **lists of canonical event objects**,
not dictionaries and not pre-built scenario documents. Each event may contain
`date`, `amount_cents`, `type` (`income`/`expense`/`adjustment`), optional `name`,
`sequence` and `category`. Dates must fall inside the half-open window
`[as_of, as_of + horizon_days)`, signs must match the type, amounts must be exact
integer cents within the contract range, and an exact duplicate event is rejected as
ambiguous. A dictionary container is rejected with `SCHEMA_INVALID` — it is never
iterated into the event list.

`validate_scenario()` is the one operation that returns a verdict instead of raising, so its shape
is contractual:

```json
{
  "valid": false,
  "schema_checked": true,
  "schema_valid": false,
  "engine_evaluated": false,
  "errors": [{"code": "SCHEMA_INVALID", "path": "horizon_days", "message": "..."}]
}
```

`valid` is true **only** when the schema was actually checked, the document passed it, the engine
evaluated it, and no error was recorded. If the validation dependency (`jsonschema`, a required
runtime dependency) is unavailable, the verdict is `VALIDATION_UNAVAILABLE` with
`valid: false` — a skipped check is never reported as success. Schema failure short-circuits engine
evaluation (`engine_evaluated: false`); an invalid *date* or *amount* that the JSON schema cannot
express is reported by the engine stage with its typed code.

**Contract-version policy (two tiers).** Canonical public inputs — the fixture corpus, cross-engine
comparison, and anything passed to `validate_scenario()` — MUST declare `contract_version`
explicitly; omission is `SCHEMA_INVALID`. The engine itself retains a documented default for
legacy/hand-written scenarios: a missing version evaluates as the latest **released** version
(MCD-0027). An explicitly malformed version (`null`, a number, an object, an unknown string) is
always rejected — it is never silently replaced by the default.
Stale/insufficient data is surfaced, not hidden: `financial_snapshot()` exposes
`balance_consistent`, `reconciled_with_bank` and `newest_transaction_date` so the adapter can label
data freshness; simulation defaults (runs/seed/variance ranges) are declared in
`engine_capabilities()` and must be shown as model assumptions, not facts.

## 4. Security boundary (non-negotiable)

1. **Read-only + hypothetical.** No MCP operation writes the ledger, initiates sync, or mutates
   settings. `engine_capabilities().writes == {"allowed": False}` is contractual. Ledger writes,
   sync triggers and any "commit this plan" flow are **out of scope** and require a future explicit
   permission design with transaction controls — do not improvise them in the adapter.
2. **Loopback only.** If the adapter uses the HTTP binding, the API binds `127.0.0.1` and a runtime
   middleware refuses non-loopback clients. Never expose it as a network service; never tunnel it.
3. **Least data.** Results contain balances/risks, not transaction narratives. The adapter MUST NOT
   log full results by default, MUST redact financial fields from any LLM-visible trace the user
   has not explicitly requested, and MUST NOT send ledger content to remote services.
4. **Provenance.** Every decision result already carries the `ledger` block described in §2
   (`contract_version`, explicit `as_of`, authority/cache balances, reconciliation, snapshot
   counts, simulation seed/runs and the model basis). An adapter MUST forward it rather than
   summarising results down to a bare number. "Safe to spend" answers must carry the
   quantile/reserve basis (MCD-0008) and the model-based/unverified caveat for stochastic
   estimates.
5. **No secrets.** The adapter never needs the vault passphrase; do not wire sync credentials into
   any LLM-reachable tool.

## 5. Minimal adapter sketch (illustrative only — not shipped)

```python
from monte_carlo_ledger import decisions
from monte_carlo_ledger.contract import ContractError

TOOLS = {
    "estimate_overdraft_risk": lambda args: decisions.overdraft_risk(
        as_of=args["as_of"],                      # required, ISO date; no clock reads
        horizon_days=args.get("horizon_days", 90),
        sim={"seed": args.get("seed", 42), "runs": args.get("runs", 500),
             "reserve_cents": args.get("reserve_cents", 0)},
    ),
    # ... one thin lambda per operation; no financial logic here
}

def handle(name, args):
    if name not in TOOLS:
        return {"isError": True, "code": "UNKNOWN_TOOL"}
    try:
        return {"result": TOOLS[name](args)}
    except ContractError as err:
        return {"isError": True, "code": err.code, "message": str(err)}
```

## 6. Adapter-facing evidence

`tests/test_mcp_adapter_contract.py` (29 tests) pins, against the real core:

- capability shape + agreement with `contracts/version.json`,
- bit-for-bit reproducible forecast/risk for a fixed seed,
- `simulate_purchase` results validating against `schemas/result.schema.json`,
- unaffordable purchases produce honest negative troughs (never clamped),
- invalid dates raise typed `ContractError` (never zeros),
- `validate_scenario` schema-level and engine-level error codes, including date, amount and
  overflow cases,
- a missing validation dependency yields `VALIDATION_UNAVAILABLE`, never `valid: true`,
- contract-version boundaries: omission, `null`, numbers, unknown strings, 1.0–1.2, 2.0,
- `financial_snapshot` balances/freshness, bounded queries (no full-ledger materialization), and
  full-suite read-only behaviour,
- deterministic debt strategy comparison with the cash-flow caveat,
- rejection of empty liability sets and of negative extra payments (never clamped).

`tests/test_decision_contract.py` additionally pins the campaign-3 additions:

- complete `ledger` provenance on **every** operation (including `overdraft_risk`,
  `compare_scenarios` and `compare_debt_strategies`),
- exactly one `read_ledger_view` per operation, and a concurrent write after the view
  cannot change either the numbers or the provenance,
- typed `compare_scenarios` input (dictionary container, dates, window, signs, overflow,
  unknown fields, exact duplicates),
- central bounds for runs/seed/quantile/reserve/horizon/amount.

`tests/test_api_limits.py` proves the loopback HTTP boundary enforces the same bounds
(including the previously unbounded `/v1/safe-to-spend` runs) and that accepted
requests do not mutate the ledger.

## 7. Deliberately NOT done here

- No MCP server, transport, or session handling.
- No new credentials, token flows, or remote calls.
- No write tools, sync tools, or "apply this plan" affordances.
- No orchestration layer between the adapter and `decisions.py`.

## 8. Qualification evidence — campaign 2 (2026-11-07)

Executed against the merged default branches, not against PR descriptions.

### Adapter inputs are now correct

- **Monthly income anchoring (MCD-0022).** `scenario.py` delegates to the canonical
  `contract.recurrence_dates()` expander with an explicit `anchor_day` taken from
  `last_payday`. A Jan 31 schedule now projects Feb 28 → **Mar 31** (previously Mar 28),
  leap years project Feb 29 → Mar 31, and a deliberately moved next payday becomes the
  new anchor. `tests/test_income_anchoring.py` (12 tests) pins this, including invalid
  dates/frequencies and non-positive income.
- **Web adapter parity.** The TypeScript builder uses the same anchor rule and applies
  `income.expected_amount` to the first projected paycheck; the timeline renders
  `timelineRows()` from the contract engine instead of re-sorting and re-accumulating.
- **Android** already used `day_of_month` and `expectedAmountCents` in
  `ContractScenarioBridge`; the widget and dashboard share one simulation configuration
  and an end-to-end parity test.

### Read-only includes derived state

`forecast`, `overdraft_risk`/`risk`, `safe_to_spend`, `simulate_purchase`,
`simulate_paycheck_delay`, `compare_scenarios` and `compare_debt_strategies` all build
with `read_only=True`. Tests assert that **transactions and bill_occurrences** are
unchanged after every operation, including failures.

### Snapshot / restore compatibility (not an MCP operation)

- Snapshot format **2.1** adds `incomes[].expected_amount`; 2.0 snapshots still restore
  (override `null`).
- Every field is validated before any row is written; non-integer identifiers are
  remapped deterministically; duplicate ids and dangling references are rejected
  during validation, before the transaction starts. A missing collection or balance is
  an incomplete snapshot, never an empty ledger. Unknown row fields are refused rather
  than silently discarded (`tests/test_snapshot_restore_strict.py`).
- Restore is a single SQLite transaction; a rejected or interrupted restore leaves the
  previous ledger intact. The recovery copy uses SQLite's online backup API.
- **Python cannot persist liabilities.** A snapshot containing them is rejected with a
  compatibility error instead of silently dropping debt. Use the Android/Web client for
  ledgers with debt.
- `tests/test_snapshot_fidelity.py` compares the *persisted database* before/after a real
  export → restore (11 tests), which detects fields omitted from both sides.

### Qualification commands

```bash
# Python reference + adapter surface
python -m pytest -o addopts="" -q
python -m ruff check .
python -m pyright

# Clean installation without developer extras
python -m venv .clean && .clean/bin/pip install . 
MC_LEDGER_DB=/tmp/clean.db .clean/bin/python -m monte_carlo_ledger forecast --as-of 2026-11-09 --json

# Web
cd web && pnpm install --frozen-lockfile && pnpm lint && pnpm test
NODE_ENV=production pnpm build && NODE_ENV=production pnpm exec playwright test

# Android
./gradlew :app:testDebugUnitTest :app:assembleDebug :app:assembleRelease
./gradlew :app:connectedDebugAndroidTest   # emulator; CI runs this on API 34

# Three-engine conformance (from the Ledger repo)
python tools/conformance/run_python.py --out /tmp/py
python tools/conformance/cross_engine.py --strict \
  --python-dir /tmp/py --kotlin-dir /tmp/kotlin --fixtures fixtures \
  --contract-pin ../MonteCarloLedger-Android/app/src/test/resources/contract/contract-pin.json
```

### Remaining limitations (adapter must not paper over)

- Cloud sync was exercised against the real Next.js vault routes with an explicit
  test-only store and against the real Python client (create → push → second client
  join → pull → wrong passphrase → stale revision). It has **not** been executed against
  a live Turso/libSQL database; treat that external gate as BLOCKED until it is.
- The TypeScript binding fails closed (`MONEY_OVERFLOW`) when a result exceeds
  `Number.MAX_SAFE_INTEGER`; Python's int64 is exact. Canonical fixture values are far
  inside this bound.
- The local HTTP API's loopback guard cannot distinguish a same-host reverse proxy.
  Prefer in-process operation calls for a local MCP adapter.
