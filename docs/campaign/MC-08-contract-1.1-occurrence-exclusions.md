# MC-08 — Contract 1.1: occurrence exclusions

**Goal:** resolve the highest-impact MC-07 finding (C5) — a paid or user-moved occurrence in the
*middle* of a recurrence window could not be suppressed, so the generated template occurrence was
projected together with its explicit moved event (a double count).

**Delivered:** an optional, backward-compatible `occurrence_exclusions` field in both engines, with
MCD-0024, three new golden fixtures, and cross-engine conformance.

## Version decision: 1.1, not 2.0

The MC-07 candidate registry called this "Contract 2.0". The contract's own versioning rules decide
otherwise:

- `MAJOR` — a change that alters a financial conclusion for an existing valid scenario, or
  removes/renames a schema field.
- `MINOR` — a backward-compatible clarification or addition (new optional field, new fixture).

`occurrence_exclusions` is a new **optional** field: a scenario without it is unaffected, every 1.0
fixture is byte-identical, and the canonical result echoes the scenario's declared version (so a 1.0
scenario never silently widens). That is a MINOR change: **contract 1.1** (component timeline 1.1).
The "2.0" label was a placeholder for "the next contract version"; the rules make it 1.1. Remaining
2.0 candidates (debt semantics, per-category variation, daily path percentiles, multi-account,
calibration, multi-currency) are unaffected.

## What changed

**Contract (normative):**

- `contracts/timeline.md` — new "Occurrence exclusions" section; expansion step 3 removes excluded
  occurrences *before* the expected-amount slot is decided; `occurrence_exclusions` requires a
  1.1 document by convention. New "Result contract version" section.
- `contracts/version.json` — `1.1`, timeline `1.1`.
- `schemas/scenario.schema.json` — `contract_version` enum `["1.0","1.1"]`; `occurrence_exclusions`
  definition (`[{recurrence_id, date}]`, `additionalProperties: false`).
- `schemas/result.schema.json` — `contract_version` enum `["1.0","1.1"]`.
- `semantic-decisions/MCD-0024-occurrence-exclusions.md`; `CONTRACT_CHANGELOG.md` 1.1 entry.

**Python reference (`contract/engine.py`):**

- `CONTRACT_VERSION = "1.1"`; `SUPPORTED_CONTRACT_VERSIONS = ("1.0","1.1")`.
- `_exclusions()` builds the `(recurrence_id, ISO date)` set; malformed entries are `SCHEMA_INVALID`.
- Expansion skips excluded occurrences; an exclusion does not consume `expected_amount_cents`.
- The result echoes the scenario's declared `contract_version`.

**Kotlin engine (`com.montecarlo.ledger.contract`):**

- `ContractRecurrenceExclusion`; `ContractScenario.contractVersion` + `occurrenceExclusions`.
- Parser accepts `1.0`/`1.1`, parses/validates exclusions (`occurrence_exclusion` uses
  `additionalProperties: false`).
- `ContractEngine.inWindowBaseEvents` skips excluded `(recurrence_id, date)` pairs before the
  expected-amount slot.
- `ContractRunner` echoes `scenario.contractVersion` into the result.

**Android product (`adoption/ContractScenarioBridge`):**

- Suppression now uses `occurrence_exclusions` instead of advancing the recurrence lower bound, so a
  mid-window paid/moved occurrence is removed. The recurrence keeps its original `start_date`, so the
  month anchor stays exact (MCD-0022). This is the actual C5 fix.

## Fixtures (24 → 27)

| Fixture | Protects |
|---|---|
| `boundary/mid-window-exclusion` | A middle occurrence is removed; the others remain (MCD-0024). |
| `deterministic/moved-occurrence-override` | A moved occurrence = explicit event + exclusion of the template date; three charges, not four. |
| `boundary/exclusion-first-income-expected-amount` | An excluded occurrence does not consume the `expected_amount_cents` slot (MCD-0017 + MCD-0024). |

## Evidence

All commands run on this branch (Python 3.10.1, pytest 8.4.2; JDK 17, AGP 9.2.0).

```text
python -m pytest                                  139 passed in 115.08s
python -m ruff check .                            All checks passed!
python -m pyright                                 0 errors, 0 warnings
tools/conformance/run_python.py --out build/...   frozen=0 pending=0 errors=3 (the invalid fixtures)
tools/conformance/cross_engine.py                 27 fixtures checked, 0 divergences
./gradlew :app:testDebugUnitTest                  339 tests, 0 failures, 0 errors
```

Backward compatibility: the 24 pre-existing fixtures and their pinned Kotlin baselines are
byte-identical (their declared version is `1.0`, echoed by the engine), so `checked=27,
divergences=0` includes all 24 unchanged cases.

## Provenance

- Contract snapshot consumed by Android: Ledger `90ac33f` (34 → 38 pinned files).
- Android implementation: `mc-08/...` branch.

## Remaining / follow-ups

- ~~`occurrence_exclusions` is not *enforced* to require a 1.1 document.~~ **Resolved in MC-09**: a
  `1.0` document that carries the field is now `SCHEMA_INVALID`, enforced in both engines (not via a
  JSON-Schema `if/then`, which the Kotlin test-side mini-validator does not implement). Fixture
  `invalid/exclusion-requires-1-1`.
- Pending: push/PR/merge are blocked by `STOP_REMOTE` (no trusted remote profile), and the pin
  names a commit not yet on the default branch. See `MC-07-release-readiness.md`.
