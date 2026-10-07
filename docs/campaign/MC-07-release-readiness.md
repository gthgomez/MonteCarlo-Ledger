# Contract Release Readiness

**Decision: Contract 1.1 remains `draft`.**

Updated after MC-08 (contract 1.1, occurrence exclusions). The product is behaviourally canonical,
the evidence drift is fixed, and the MC-07 C5 double-count is resolved — but not every release
condition is met. Marking 1.1 `released` here would assert a stability the repository cannot yet
prove.

## Condition checklist

| Required release condition | Status | Evidence / blocker |
|---|---|---|
| Metadata internally consistent | **PASS** | `contracts/version.json` `status: draft`, `created_at`/`updated_at`, `contract_version: 1.1`. |
| Provenance exact | **PASS** | `MC-06-reconciliation-report.md` §Revision provenance; MC-08 pin `90ac33f`. |
| Fixture corpus count exact | **PASS** | 27 fixtures; `fixtures/README.md`; cross-engine comparer. |
| All golden fixtures green in both engines | **PASS** | Python conformance + Kotlin `ContractConformanceTest`. |
| Zero unexplained divergences | **PASS** | `cross_engine.py`: 27 checked, 0 divergences. |
| Current Python and Android product paths known | **PASS** | `docs/campaign/MC-07-adoption-map.md`. |
| No user-visible Contract-1.x output on contradictory legacy semantics | **PASS** | Python migrated + legacy engines deleted; Android headlines/rows canonical, flag removed; C5 mid-window suppression resolved in contract 1.1 (MC-08, MCD-0024). |
| Contract pin reproducible | **BLOCKED** | The Android pin names Ledger `90ac33f`, a commit **not yet on the default branch** (§Blocker 1). |
| MCD index complete | **PASS** | MCD-0001…0024. |
| Changelog correct | **PASS** | `CONTRACT_CHANGELOG.md` (1.0, 1.1 draft). |
| Contributor guide correct | **PASS** | `docs/contract-guide.md`. |
| Release notes identify deferred 2.0 domains | **PASS** | `docs/campaign/MC-07-contract-2-candidates.md`. |

## Blockers (explicit)

1. **Pin is not yet published.** The Android contract pin references Ledger `90ac33f`, which exists
   locally but is not on `master` (no trusted remote profile is registered for these remotes, so no
   push/PR/merge is available in this environment — `STOP_REMOTE`). The pin becomes a valid,
   fetchable provenance reference once the Ledger branch is pushed and merged.
2. **Android verified by unit tests only.** `./gradlew :app:testDebugUnitTest` passes (339 tests),
   but no device/instrumented verification was performed; numeric changes are asserted by unit
   tests.
3. **Naming hazard (documentation).** Android `CashFlowWindow.safeToSpendCents` /
   `dailySafeSpendCents` are per-window deterministic figures distinct from the contract's quantile
   `safe_to_spend_cents`. They are non-normative (the Planning screen uses them) and do not feed
   headline values, but the name overlap should be resolved before release.

## What would make it releasable

1. Land the Ledger 1.1 commit on the default branch and re-pin Android to that exact merged commit;
   re-run cross-engine conformance.
2. Device-level verification of the changed Android numbers.
3. Rename/annotate the Android per-window heuristic.

Until then: `Contract 1.1 — STILL DRAFT`.
