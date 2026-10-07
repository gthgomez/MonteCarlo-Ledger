# MC-07 — Contract 1.0 Release Readiness

**Decision: Contract 1.0 remains `draft`.**

The campaign made the product behaviourally canonical (one engine per surface) and fixed the
evidence drift, but the release conditions are not all met. Marking 1.0 `released` here would
assert a stability the repository cannot yet prove.

## Condition checklist

| Required release condition | Status | Evidence / blocker |
|---|---|---|
| Metadata internally consistent | **PASS** | `contracts/version.json` is `status: draft` + `created_at` (no `released` field). |
| Provenance exact | **PASS** | `docs/campaign/MC-06-reconciliation-report.md` §Revision provenance. |
| Fixture corpus count exact | **PASS** | 24 fixtures (6+9+4+5), `fixtures/README.md`, comparer. |
| All golden fixtures green in both engines | **PASS** | Python conformance 27 cases; Kotlin `ContractConformanceTest`. |
| Zero unexplained divergences | **PASS** | `MC-06-divergence-report.md`: 24 checked, 0 divergences. |
| Current Python and Android product paths known | **PASS** | `docs/campaign/MC-07-adoption-map.md`. |
| No Contract-1.x user-visible output on contradictory legacy semantics | **PARTIAL** | Python: migrated + legacy engines deleted. Android: headlines/rows canonical, flag removed. **Blocker:** C5 mid-window occurrence suppression (§Blocker 1). |
| Contract pin reproducible | **BLOCKED** | The Android pin now names Ledger `9fd8f74`, a commit that is **not yet on the default branch** (§Blocker 2). |
| MCD index complete | **PARTIAL** | MCD-0001…0023; the C5 exclusion decision is a pending 2.0 MCD. |
| Changelog correct | **PASS** | `CONTRACT_CHANGELOG.md` (1.0 draft) accurate. |
| Contributor guide correct | **PASS** | `docs/contract-guide.md`. |
| Release notes identify deferred 2.0 domains | **PASS** | `docs/campaign/MC-07-contract-2-candidates.md`. |

## Blockers (explicit)

1. **C5 — arbitrary occurrence exclusion is unrepresentable.** A user-moved/paid occurrence in the
   *middle* of a recurrence window is still projected by the canonical scenario, so the projected
   low point can be wrong for that user. This is a real, user-visible Contract-1.x quantity with a
   known defect that requires a Contract 2.0 representational extension
   (`docs/campaign/MC-07-contract-2-candidates.md` #1). Leaving it in 1.0 as-is is acceptable only
   while 1.0 stays `draft`.
2. **Pin is not yet published.** The Android contract pin references Ledger `9fd8f74`, which exists
   locally but is not on `master` (no trusted remote profile is registered for these remotes, so no
   push/PR/merge is available in this environment — `STOP_REMOTE`). The pin becomes a valid,
   fetchable provenance reference once the Ledger branch is pushed and merged.
3. **Android verified by unit tests only.** `./gradlew :app:testDebugUnitTest` passes, but no
   device/instrumented verification was performed; numeric changes are asserted by unit tests.
4. **Naming hazard (documentation).** Android `CashFlowWindow.safeToSpendCents` is a per-window
   deterministic lowest balance, distinct from the contract's quantile `safe_to_spend_cents`. It is
   non-normative and does not feed headline values, but the name overlap should be resolved before
   release to avoid future confusion.

## What would make it releasable

1. Resolve or version C5 (implement the exclusion mechanism via an MCD + fixture, or formally
   scope it out of the release with product sign-off).
2. Land the Ledger contract-metadata commit on the default branch and re-pin Android to that exact
   merged commit; re-run cross-engine conformance.
3. Device-level verification of the changed Android numbers.
4. Rename/annotate the Android per-window heuristic.

Until then: `Contract 1.0 — STILL DRAFT`.
