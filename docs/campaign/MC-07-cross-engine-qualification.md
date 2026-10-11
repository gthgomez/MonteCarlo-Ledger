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

## Implementation status (WS7)

Option A is now implemented in `.github/workflows/contract-conformance.yml` as a second, path-gated
job `conformance-live`, beside the retained pinned-baseline job:

- `live-scope` gates the heavyweight job to changes touching `fixtures/`, `schemas/`, `contracts/`,
  `tools/conformance/`, `monte_carlo_ledger/contract/`, or this workflow (or a manual
  `workflow_dispatch`). It also resolves the cross-repo access precondition and exports it as the
  `ready` output, because a job-level `if` cannot read a step output of the job it gates.
- `conformance-live` is gated at the **job** level
  (`needs.live-scope.outputs.conformance == 'true' && needs.live-scope.outputs.ready == 'true'`).
  When the precondition fails, the job is reported **skipped**, not successful: a missing
  credential can no longer leave a green check that carries no evidence. The job also carries
  `timeout-minutes: 45` and a per-ref `concurrency` group with `cancel-in-progress: false`, and the
  cross-repo `ANDROID_REPO_TOKEN` is scoped to the single Android checkout step (never exported into
  the Gradle/Python steps).
- `conformance-live` checks out `gthgomez/MonteCarloLedger-Android` at the pinned `ANDROID_PIN_SHA`
  (workflow-level `env`), runs `:app:testDebugUnitTest --tests
  com.montecarlo.ledger.contract.ContractEmitTest --no-daemon` under JDK 17, and feeds the fresh
  `app/build/contract-results/` to the comparer as `--kotlin-dir`.
- `cross_engine.py` prints engine provenance (the Android emitting commit and the contract pin
  `source_commit`) in its report; provenance never feeds the comparison. Provenance is also never
  invented: passing `--contract-pin` that is unreadable, malformed, or carries no `source_commit`
  exits `2` with a clear message instead of reporting `unavailable` beside a green comparison, and
  the live job adds `--strict` so a passing report can never lack engine/contract revisions.
- The Android repo is **public**, so no cross-repo token is required; visibility is read from the
  repository variable `ANDROID_REPO_IS_PRIVATE` (default `"false"`) rather than hardcoded. If it ever
  becomes private without an `ANDROID_REPO_TOKEN` secret, `conformance-live` is **skipped** (with an
  annotation saying the run holds no live evidence) rather than reporting success.
- Coverage: `tests/test_cross_engine.py` pins provenance sourcing, the clear-error exits, the
  `--contract-sha` precedence, and that adding provenance arguments never changes the verdict.

## Cross-repo corpus coupling (operational caveat)

The live job compares **two independent corpora**: this repo's `fixtures/` and the fixtures vendored
in the pinned Android commit. They are synchronised by hand, so a fixture added here without an
Android bump is `MISSING` from the Kotlin results, and `MISSING` is a hard failure — deliberately,
because a missing scenario is absence of evidence, not agreement. `cross_engine.py` therefore reports
a **corpus skew** section (and a `::warning::`-style stderr warning) naming the scenario ids only one
engine emitted, while still failing the run.

The coupling is a **two-step bump**, landed as one coordinated pair of changes:

1. vendor the new/renamed fixtures in `MonteCarloLedger-Android`, push, take the new `main` SHA;
2. set `ANDROID_PIN_SHA` in this workflow to that SHA **and** re-pin the vendored contract snapshot
   `app/src/test/resources/contract/contract-pin.json` at the same Android commit.

Until both halves land, expect a deliberate red `conformance-live` plus the corpus-skew warning.
Comparing only the intersection of `scenario_id`s was considered and rejected: it would silently drop
missing scenarios and turn absence of evidence into green.

## Why not implemented in MC-07 (superseded by WS7)

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
