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
| `validate_scenario` | `decisions.validate_scenario(scenario)` | schema-first structured verdict, no side effects |
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

Money is **integer cents** (MCD-0007 rounding, MCD-0020 overflow-is-error), probabilities are **ppm**
(MCD-0004), quantiles use nearest-rank (MCD-0005), and time is **explicit `as_of` date-only**
(MCD-0001/0002) — the engine never reads a clock. Determinism: identical inputs (including `seed`)
yield bit-for-bit identical output; the adapter contract tests assert this.

## 3. Failure contract — fail closed

An operation either returns a canonical result or raises `monte_carlo_ledger.contract.ContractError`
with a stable machine-readable `code` (`SCHEMA_INVALID`, `MISSING_AS_OF`, `INVALID_DATE`,
`INVALID_AMOUNT`, `INVALID_HORIZON`, `INVALID_RUNS`, `MONEY_OVERFLOW`, ...). There is **no** code
path that converts a failure into a zero, a "0% risk", or a default. An adapter MUST map exceptions
to tool errors (`isError: true`) carrying `err.code` — never swallow them into a numeric result.
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
4. **Provenance.** An adapter SHOULD attach `contract_version`, the engine package version, and the
   `as_of` to every answer. "Safe to spend" answers must carry the quantile/reserve basis
   (MCD-0008) and the model-based/unverified caveat for stochastic estimates.
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

`tests/test_mcp_adapter_contract.py` (12 tests) pins, against the real core:

- capability shape + agreement with `contracts/version.json`,
- bit-for-bit reproducible forecast/risk for a fixed seed,
- `simulate_purchase` results validating against `schemas/result.schema.json`,
- unaffordable purchases produce honest negative troughs (never clamped),
- invalid dates raise typed `ContractError` (never zeros),
- `validate_scenario` schema-level and engine-level error codes,
- `financial_snapshot` balances/freshness and full-suite read-only behaviour,
- deterministic debt strategy comparison with the cash-flow caveat,
- rejection of empty liability sets,
- version-less scenarios evaluate as the latest released version (MCD-0027).

## 7. Deliberately NOT done here

- No MCP server, transport, or session handling.
- No new credentials, token flows, or remote calls.
- No write tools, sync tools, or "apply this plan" affordances.
- No orchestration layer between the adapter and `decisions.py`.
