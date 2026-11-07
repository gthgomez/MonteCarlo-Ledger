# MCD-0027 — Default contract version for version-less scenarios

- **Status:** accepted
- **Contract:** 2.0 (cross-domain)
- **Audit ref:** MC-12 campaign, Phase C ambiguity review
- **Question:** When a scenario omits `contract_version`, which version's semantics apply, and what
  should the scenario builder stamp? The Python reference engine defaulted to `1.2`
  (`contract/engine.py`), while the TypeScript port defaulted to `2.0`
  (`web/src/contract/engine.ts`): the same version-less scenario could legally evaluate under two
  different defaults on two conformant engines — a silent cross-engine divergence.
- **Options:**
  - A. Keep per-engine defaults and require every caller to declare a version explicitly.
  - B. Align all engines on the *latest released* contract version as the default, and stamp it
    into builder-produced scenarios.
  - C. Refuse version-less scenarios outright.
- **Decision:** **B.** Every engine treats a missing `contract_version` as the latest released
  version (`2.0`), and `build_scenario` stamps `2.0` explicitly. Option C was rejected: the schema
  marks `contract_version` required, but the engines deliberately tolerate its absence for
  hand-written scenarios, and hard-failing them would break existing local flows for no correctness
  gain. Option A is what caused the divergence.
- **Reason:** A version-less document cannot be interpreted as "some older version" — the oldest
  semantics would silently retire features a caller is using. Latest-released is the only choice
  that is identical across engines by construction, and it is discoverable via
  `contracts/version.json` / `engine_capabilities`. This is not a normative-output change for any
  scenario that declares its version (the entire golden corpus does); it only removes the one
  version-less input class where engines previously disagreed.
