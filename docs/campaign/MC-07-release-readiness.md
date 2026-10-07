# Contract Release Readiness

**Decision: Contract 2.0 remains `draft`, but every contract-level release condition is now met.**

Updated after MC-11 (contract 2.0, debt domain). The three previously-blocking items — the C5
double-count, the unpublished pin, and the non-canonical debt conclusions — are all resolved.
Promotion to `released` is deliberately left as the next explicit action.

## Condition checklist

| Required release condition | Status | Evidence |
|---|---|---|
| Metadata internally consistent | **PASS** | `contracts/version.json` `status: draft`, `contract_version: 2.0`, `created_at`/`updated_at`, component versions pinned. |
| Provenance exact | **PASS** | `MC-06-reconciliation-report.md` §Revision provenance; MC-11 pin `c1dea8c`. |
| Fixture corpus count exact | **PASS** | 38 fixtures; `fixtures/README.md`; cross-engine comparer. |
| All golden fixtures green in both engines | **PASS** | Python conformance + Kotlin `ContractConformanceTest`. |
| Zero unexplained divergences | **PASS** | `cross_engine.py`: 38 checked, 0 divergences; Kotlin emitter byte-identical. |
| Current product paths known | **PASS** | `docs/campaign/MC-07-adoption-map.md` + per-phase campaign docs. |
| No user-visible output on contradictory legacy semantics | **PASS** | Python migrated (legacy engines deleted); Android headlines/rows canonical, flag persisted; C5 resolved (1.1); per-category variation canonical (1.2); **debt now canonical (2.0, MC-11)**. |
| Contract pin reproducible | **PASS** | Android pins Ledger `c1dea8c`, which is on `master`. |
| MCD index complete | **PASS** | MCD-0001…0026. |
| Changelog correct | **PASS** | `CONTRACT_CHANGELOG.md` (1.0 … 2.0 draft). |
| Contributor guide correct | **PASS** | `docs/contract-guide.md`. |
| Release notes identify deferred domains | **PASS** | `docs/campaign/MC-07-contract-2-candidates.md`. |

## Remaining before a deliberate `released` promotion

1. **Device-level Android verification.** All Android evidence is unit tests
   (`:app:testDebugUnitTest`, `:app:assembleDebug`); no instrumentation/device run.
2. **Naming hazard.** Android `CashFlowWindow.safeToSpendCents` / `dailySafeSpendCents` are per-window
   deterministic figures distinct from the contract's quantile `safe_to_spend_cents`; rename or
   annotate before release.
3. **The promotion itself** (deliberate): set `status: released` + a release date in
   `contracts/version.json`, add the changelog/release note, re-pin Android to the exact released
   snapshot, and rerun conformance end-to-end.

## Deferred (not release blockers for 2.0)

Multi-account / transfers, per-day stochastic path percentiles, calibration semantics,
multi-currency, and the non-normative fan chart — see the candidate registry.

Until the promotion action: `Contract 2.0 — STILL DRAFT`.
