# Contract Release Readiness

**Decision: Contract 2.0 is `released` (2026-11-07). Every contract-level release condition is met.**

Promoted after the merge campaign, with fresh three-engine execution on the merged default
branches (Python reference, Kotlin `6418cd2`, TypeScript): 38/38 fixtures agreed, 0 divergences,
and six deliberate divergences were injected in an isolated copy and all were detected.

Updated after MC-11 (contract 2.0, debt domain). The three previously-blocking items — the C5
double-count, the unpublished pin, and the non-canonical debt conclusions — are all resolved.
Promotion to `released` was executed on 2026-11-07 after the merge campaign re-verified it
end-to-end.

## Condition checklist

| Required release condition | Status | Evidence |
|---|---|---|
| Metadata internally consistent | **PASS** | `contracts/version.json` `status: released`, `contract_version: 2.0`, `released_at: 2026-11-07`, component versions pinned. |
| Provenance exact | **PASS** | Python/Kotlin/TypeScript executed fresh at the merged revisions; Kotlin `6418cd2`, re-pinned Ledger release commit recorded in the Android pin. |
| Fixture corpus count exact | **PASS** | 38 fixtures; `fixtures/README.md`; cross-engine comparer. |
| All golden fixtures green in both engines | **PASS** | Python conformance + Kotlin `ContractConformanceTest`. |
| Zero unexplained divergences | **PASS** | `cross_engine.py`: 38 checked, 0 divergences; Kotlin emitter byte-identical. |
| Current product paths known | **PASS** | `docs/campaign/MC-07-adoption-map.md` + per-phase campaign docs. |
| No user-visible output on contradictory legacy semantics | **PASS** | Python migrated (legacy engines deleted); Android headlines/rows canonical, flag persisted; C5 resolved (1.1); per-category variation canonical (1.2); **debt now canonical (2.0, MC-11)**. |
| Contract pin reproducible | **PASS** | Android vendored snapshot re-pinned to the exact promoting Ledger commit on `master`. |
| MCD index complete | **PASS** | MCD-0001…0027. |
| Changelog correct | **PASS** | `CONTRACT_CHANGELOG.md` (1.0 … 2.0 released). |
| Contributor guide correct | **PASS** | `docs/contract-guide.md`. |
| Release notes identify deferred domains | **PASS** | `docs/campaign/MC-07-contract-2-candidates.md`. |

## Promotion record (2026-11-07)

1. **Promotion executed.** `contracts/version.json` is `released` (`released_at: 2026-11-07`), the
   changelog entry is marked released, the Android vendored snapshot is re-pinned to this commit,
   and fresh three-engine conformance was rerun (38/38, 0 divergences).
2. **Negative controls.** Six deliberately injected divergences (percentile rounding, probability
   scale, recurrence anchoring, debt interest rounding, version rejection, invalid-expense
   acceptance) were each detected by the comparer; the mutations were confined to an isolated copy
   and never touched the released sources.
3. **Android app-binary verification — NOT RUN.** No emulator or physical device is available in
   this environment, so instrumented tests (`:app:connectedDebugAndroidTest`) were not executed.
   JVM unit tests, `assembleDebug` and `assembleRelease` (unsigned) were executed.

## Deferred (not release blockers for 2.0)

Multi-account / transfers, per-day stochastic path percentiles, calibration semantics,
multi-currency, and the non-normative fan chart — see the candidate registry.

Promotion record: `contracts/version.json` is `released` with `released_at: 2026-11-07`; the
Android vendored snapshot is re-pinned to the promoting Ledger commit and the conformance
workflow's `ANDROID_PIN_SHA` is advanced to the merged Android `main`.

**Boundary:** the remaining items above concern the Android *application* (device verification,
naming). They do not block the contract release, and this repository does not claim a verified
Play Store release. Android app-binary verification is reported separately as NOT RUN.
