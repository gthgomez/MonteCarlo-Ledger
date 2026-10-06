# Kotlin cross-engine baseline

Canonical results emitted by the Android Kotlin contract engine
(`ContractEmitTest`, branch `campaign/contract-1.0-conformance`, commit `8dde17f`)
against the fixture corpus pinned in the Android repo.

They let the language-neutral comparer prove, in this repository's CI, that the
Python reference produces byte-identical results to an independently-built Kotlin
implementation. These are contract data, not Kotlin source.

Refresh procedure: in the Android repo run
`./gradlew :app:testDebugUnitTest --tests "com.montecarlo.ledger.contract.ContractEmitTest"`,
then copy `app/build/contract-results/*.json` here in the same PR that re-pins the
contract revision.
