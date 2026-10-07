# MC-07 — Cross-Engine Qualification (design + current state)

## Current state (retained)

Ledger CI (`.github/workflows/contract-conformance.yml`) runs the Python golden corpus and then the
dumb comparer (`tools/conformance/cross_engine.py`) against a **checked-in, hash-pinned Kotlin
baseline** (`tools/conformance/kotlin-baseline/*.json`, produced by the Kotlin `ContractEmitTest`).

This is real evidence (both engines' *outputs* are compared, byte-for-byte, with no math in the
comparer), but it is not the strongest possible proof: the Kotlin side is a snapshot emitted at
pin time, not a live Kotlin execution on every Ledger run.

## Goal — live cross-engine qualification

```text
same contract snapshot
        │
   ┌────┴────┐
   │         │
Python    Kotlin
current   current
   │         │
   └────┬────┘
        │
   dumb comparer   (no financial math)
```

## Options evaluated

| Option | Complexity | Live Kotlin? | Notes |
|---|---|---|---|
| A. Scheduled cross-repo workflow (`workflow_dispatch`/`schedule`) in Ledger that checks out `MonteCarloLedger-Android` at a pinned SHA, runs `:app:testDebugUnitTest --tests '*ContractEmitTest'`, and compares | Medium | Yes | Simplest reliable live path. Needs a cross-repo token (read-only) and the Android JDK/SDK toolchain in the Ledger job. |
| B. Android publishes a conformance artifact; Ledger downloads it | Medium | Yes | Decouples toolchains; requires an artifact store/release and provenance (Android run SHA). |
| C. Release-attached conformance artifacts | Higher | Yes | Strong provenance; heavier release process. |
| D. Reusable workflow in one repo called by the other | Medium | Yes | Cleanest reuse; requires org-level workflow sharing. |

## Recommendation

**Option A** when cross-repo execution is available; otherwise **Option B** (artifact handoff).
Both satisfy the requirements:

- actual engine executions (not a frozen file),
- the same fixture corpus from the same contract snapshot,
- canonical output only,
- no financial math in the comparer (it stays `compare.deep_diff`),
- explicit engine revision provenance (pin SHA + emitting run SHA printed in the report).

## Why not implemented in MC-07

The Ledger and Android remotes have **no registered trusted remote profile** in this workspace
(`docs/agent-policy/REMOTE_PROFILES.md`), so remote mutation — including adding cross-repo CI
tokens, push, and PRs — returns `STOP_REMOTE`. Building a workflow that depends on a cross-repo
token that cannot be provisioned would be speculative infrastructure.

**Decision:** document the design and **retain the pinned-baseline mechanism** for now. When the
remotes are re-enabled, implement Option A in a follow-up CI PR and keep the pinned baseline as a
fast, offline fallback.

## Minimum artifact contract (for Option A/B)

The Kotlin emitter (`ContractEmitTest`) writes one canonical result JSON per fixture to
`build/contract-results/<scenario_id>.json` and computes no financial value. A cross-repo
qualification job needs only:

1. the contract pin (`source_commit` in `contract-pin.json`),
2. the emitter run provenance (Android commit SHA),
3. the emitted `build/contract-results/`,
4. `tools/conformance/cross_engine.py` run against live `python tools/conformance/run_python.py`
   output.
