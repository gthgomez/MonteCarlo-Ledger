# Conformance tooling

The comparer is deliberately dumb. It parses JSON, schema-validates, normalizes nothing financial,
compares the actual engine result to the fixture's `expected`, and prints a diff.

```text
engine (Python)  ─┐
                  ├─► canonical result JSON ─┐
engine (Kotlin)  ─┘                         ├─► compare.py ─► PASS / FAIL / PENDING
fixture expected ───────────────────────────┘
```

## Rules

1. `compare.py` must never compute a financial value. Only parse / validate / compare / diff.
2. Engines emit their canonical result through their own native runner (pytest / JUnit) as JSON.
   Those runners are engine-specific and live in each repository (MC-03 / MC-06).
3. A `pending-generation` fixture reports `PENDING`, never `PASS`. It is promoted to frozen only
   after both engines independently reproduce the value.

## Usage

```bash
python tools/conformance/compare.py \
  --fixture fixtures/deterministic/no-dip.json \
  --actual python=/tmp/no-dip.python.json \
  --actual kotlin=/tmp/no-dip.kotlin.json
```

`--json` emits a machine-readable report for CI.

## `cross_engine.py`

`cross_engine.py` is the corpus-level wrapper: it runs `compare.deep_diff` for every frozen fixture
against both engines' results, against each other, and against the fixture `expected`. It is equally
dumb — no financial value is computed — and it additionally reports *provenance* (the Android
emitting commit and the contract-pin `source_commit`), which never feeds the comparison.

Rules for provenance and exit codes:

1. Provenance is never invented. If `--contract-pin` is supplied but cannot be read, is not JSON, is
   not an object, or has no non-empty `source_commit`, the tool exits `2` with a clear message — it
   never prints `unavailable` next to a passing comparison.
2. `--contract-sha` overrides `--contract-pin`.
3. `--strict` requires provenance to be supplied (`--kotlin-sha` plus `--contract-sha` or a readable
   `--contract-pin`); the live CI job uses it.
4. Adding provenance arguments never changes the verdict: exit `0` (all match) / `1` (divergence) is
   determined by the comparison alone.
5. Corpus skew — a scenario id emitted by one engine and not the other — is reported as a warning and
   listed in the report, but is *not* tolerated: it already fails as `MISSING`.
