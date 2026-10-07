# Golden Scenario Corpus

Language-neutral fixtures shared by the Python and Kotlin conformance runners.

## File format

Every fixture is a JSON object with two keys:

```json
{
  "scenario": { ...canonical scenario, validated by /schemas/scenario.schema.json... },
  "expected": { ...canonical result, validated by /schemas/result.schema.json... },
  "expected_status": "frozen | pending-generation",
  "notes": "optional"
}
```

- `expected` for a **success** fixture is a canonical result (usually just the `forecast` block; a
  `risk` block is present when the scenario declares `simulation`).
- `expected` for an **error** fixture is `{ "error": "CODE" }`. Codes: `SCHEMA_INVALID`,
  `MONEY_OVERFLOW`, `INVALID_AMOUNT`, `MISSING_AS_OF`, `INVALID_HORIZON`, `INVALID_RUNS`.
- Scenario `contract_version` may be `"1.0"` or `"1.1"`. Contract 1.1 added the optional
  `occurrence_exclusions` field (`[{ "recurrence_id", "date" }]`, MCD-0024). The canonical result
  echoes the scenario's declared version, so every 1.0 fixture is byte-identical before and after.
- `expected_status: "pending-generation"` marks a scenario whose expected value is produced by the
  reference engine in MC-03 and then frozen and independently reproduced in MC-06. Until frozen, the
  comparer reports it as `PENDING`, never `PASS`.

## Layout

| Directory | Purpose |
|---|---|
| `deterministic/` | explicit-event scenarios, forecast only |
| `stochastic/` | scenarios that declare `simulation`, forecast + risk |
| `boundary/` | horizon, month-end, leap-year, past-due, exact-zero, occurrence-exclusion edges |
| `invalid/` | schema or semantic errors |

## Authority

Expected values are part of the contract, not an engine's output. A fixture's `expected` block may
only be changed by a contract version change (and an MCD), or by promoting a `pending-generation`
fixture to `frozen` after the value has been independently reproduced by both engines.

`scenario_id` values are unique across the whole corpus.
