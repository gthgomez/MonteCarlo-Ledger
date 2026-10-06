# How to change a financial semantic safely

This guide is for any contributor — human or agent — changing what MonteCarlo's numbers mean.

## The one rule

> Normative financial semantics live in `/contracts` and `/fixtures` **before** any implementation
> depends on them as canonical.

Ideas, bugs, and better behavior may be discovered in either engine. A change becomes canonical only
after it is written into the contract (or a new version) and captured in the golden corpus. No engine
is the source of truth.

## The flow

```text
Python OR Kotlin exposes a semantic issue
        ↓
write/choose a semantic decision (MCD)
        ↓
update /contracts (and version.json if MAJOR/MINOR)
        ↓
add or update a /fixtures scenario with its expected result
        ↓
both implementations conform
        ↓
CI proves it
```

## Step by step

1. **Reproduce with a fixture.** Add a scenario that demonstrates the issue. If the expected result
   is disputed, mark it `expected_status: "pending-generation"` until decided.
2. **Classify.** `AGREE` / `PYTHON_ONLY` / `KOTLIN_ONLY` / `AMBIGUOUS` / `LIKELY_BUG` /
   `SEMANTIC_DECISION_REQUIRED` (see MC-00). Do not assume the engine you like is right.
3. **Write an MCD** (`/semantic-decisions/MCD-####-*.md`) using the template in
   `semantic-decisions/README.md`. State the question, options, decision, and reason.
4. **Update the contract.** Edit the relevant `contracts/*.md`. If the change alters a financial
   conclusion for an existing valid scenario, bump MAJOR in `contracts/version.json`; otherwise MINOR.
   Add a `CONTRACT_CHANGELOG.md` entry.
5. **Freeze the fixture.** Set `expected` and `expected_status: "frozen"`. Expected values are
   contract data, not "whatever the engine printed".
6. **Conform both engines.** Python (reference for integration) and Kotlin both pass. If Kotlin's
   existing behavior is better, the contract adopts it and Python changes — not the reverse by
   default.
7. **Prove it in CI.** Each repo runs its native conformance runner over the shared corpus; the dumb
   comparer reports divergence.

## What NOT to put in the contract

- Implementation structure (function names, call order).
- Floats for money, probabilities, or percentages.
- Implicit current time, unseeded randomness, or hidden timezone conversion.
- Fields that only one implementation's database has.
- Vague terminology ("safe", "worst case") without an equation.

## Definition of done for a semantic change

- [ ] MCD written and linked.
- [ ] Contract document updated and versioned.
- [ ] Changelog entry added.
- [ ] Fixture(s) added or updated and frozen.
- [ ] Python passes the corpus.
- [ ] Kotlin passes the corpus.
- [ ] No unexplained cross-engine difference remains.

## Distribution and pinning

Android consumes a **pinned** contract revision, never mutable `main` (see the distribution note in
the campaign; mechanism chosen in MC-06). A contract bump is an explicit dependency update in the
consumer, so an engine can never silently drift onto new semantics.
