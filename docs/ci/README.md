# Proposed CI workflows — installation BLOCKED

These files are the CI gates for the merged default branch. They are kept here
rather than in `.github/workflows/` because the repository credential available to
this campaign does **not** carry the GitHub `workflow` OAuth scope. GitHub rejects
any git push (and the contents API) that creates or updates a file under
`.github/workflows/` with:

```text
refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope
```

This was re-tested on 2026-11-07 (`ci/test-workflow-scope`): pushing
`docs/ci/web.yml` as `.github/workflows/web.yml` was rejected with that exact error.
Installation is therefore **BLOCKED**, not PASS. The content is preserved here so a
maintainer can install it with a credential that has `workflow` scope or via the
GitHub UI.

## Install

```bash
cp docs/ci/web.yml .github/workflows/web.yml
cp docs/ci/ci.yml  .github/workflows/ci.yml
# Advance the live Kotlin pin to the qualified Android main:
git apply docs/ci/contract-conformance-pin.patch
git add .github/workflows
git commit -m "ci: enable web, clean-install and three-engine gates"
git push
```

The pin patch applies cleanly (`git apply --check` verified). It changes
`ANDROID_PIN_SHA` from `6cadf72c50ca6466f342a7263bacacf9145b28d3` (pre-release) to
`1e8ed890d9b2509f4f7095cd5e0fb944b3c8b7c0` (current `main`: released Contract 2.0 plus the
campaign-4 canonical-chart, overflow and calibration fixes).

After installation, update required checks on Ledger `master` to:
`test (3.10)`, `test (3.11)`, `test (3.12)`, `conformance`, `clean-install`, `web`.
`conformance-live` stays optional (cross-repository/heavyweight) but must be checked
manually when the pin changes.

## What the gates cover

`docs/ci/web.yml` (new `Web` workflow, path-filtered to `web/**`, `fixtures/**`, `schemas/**`):

- frozen-lockfile install (`pnpm install --frozen-lockfile`);
- `tsc --noEmit` type check;
- unit + contract conformance, including the campaign-3 sync-ancestry,
  vault-client and strict-import tests;
- production `next build`;
- Playwright browser E2E against the production build for desktop and mobile;
- traces uploaded on failure.

`docs/ci/ci.yml` (extends the existing `CI` workflow):

- Python **3.10, 3.11 and 3.12**;
- Ruff, Pyright, full pytest (contract, MCP-ready surface, snapshot restore,
  cross-client sync, household CLI journeys, security);
- a `clean-install` job that installs the package without dev dependencies and
  asserts the fail-closed validation path and CLI exit codes from a real install.

## Local evidence for the proposed commands

Executed on 2026-11-07 against the merged work:

```text
python -m pytest -o addopts="" --collect-only -q -> 353 tests collected
python -m pytest -q                              -> all pass (exit 0)
python -m ruff check .                           -> All checks passed
python -m pyright --pythonpath .venv/bin/python  -> 0 errors
cd web && pnpm test                              -> 98 tests pass
cd web && pnpm lint && pnpm build                -> clean
python tools/conformance/run_python.py           -> 38 fixtures (3 intentional errors)
cross_engine.py --strict ... --kotlin-sha 1e8ed89 -> 38 checked, 0 divergences (2026-11-07)
```

## Branch protection (current, 2026-11-07)

- Ledger `master`: `test (3.10)`, `test (3.11)`, `conformance` (enforce_admins).
- Android `main`: `Unit tests + assembleDebug`, `assembleRelease (R8/minify)`,
  `connectedDebugAndroidTest (API 34 emulator)` (enforce_admins).

`test (3.12)`, `clean-install` and `web` cannot be added until their workflows are
installed; adding a required check that never runs would block every merge.

## Android emulator loophole

The required Android check could previously report success while skipping the
emulator when `INSTRUMENTED_TESTS_ENABLED=false`. The corrected, fail-closed
workflow and evidence are in the Android repository under `docs/ci/` (same
`workflow`-scope blocker). The latest real run (`42394918343`) did execute
**39 tests, 0 failures, exit code 0**, so the check is currently meaningful — but
the latent opt-out must be removed before it can be trusted permanently.
