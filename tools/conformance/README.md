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
