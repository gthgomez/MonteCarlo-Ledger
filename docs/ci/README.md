# Proposed CI workflows (not yet installed)

These files are the CI gates for the merged default branch. They are kept here rather than in
`.github/workflows/` because the repository credential available to the merge campaign does **not**
carry the GitHub `workflow` OAuth scope. GitHub rejects any git push (and the contents API) that
creates or updates a file under `.github/workflows/` with:

```text
refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope
```

This is an external credential limitation, not a decision to omit CI. The workflow content is
preserved here so a maintainer can install it in one step with a credential that has the
`workflow` scope (or with the GitHub UI, which is not subject to the OAuth-app restriction).

## Install

```bash
cp docs/ci/web.yml .github/workflows/web.yml
cp docs/ci/ci.yml  .github/workflows/ci.yml
git add .github/workflows
git commit -m "ci: enable web, clean-install and three-engine gates"
```

Then confirm in the Actions tab that `Web` and the `clean-install` job run on `master` and are
required by branch protection.

## What the gates cover

`docs/ci/web.yml` (new `Web` workflow, path-filtered to `web/**`, `fixtures/**`, `schemas/**`):

- frozen-lockfile install (`pnpm install --frozen-lockfile`);
- `tsc --noEmit` type check;
- unit + contract conformance over all 38 fixtures, including the 7 invalid ones;
- production `next build`;
- Playwright browser E2E against the production build for **desktop and mobile** viewports;
- traces uploaded on failure.

`docs/ci/ci.yml` (extends the existing `CI` workflow):

- Python **3.10, 3.11 and 3.12**;
- Ruff, Pyright, full pytest (contract, MCP-ready surface, household CLI journeys,
  security/encryption);
- a `clean-install` job that installs the package **without** dev dependencies and asserts:
  - `jsonschema` is present as a runtime dependency,
  - `validate_scenario` actually checks the schema and evaluates the engine (fail-closed),
  - `jsonschema`-unrepresentable invalid input (a positive expense) is reported as
    `INVALID_AMOUNT`,
  - the CLI exits 0 for a valid forecast and 2 for invalid input, from a real install.

The existing `.github/workflows/contract-conformance.yml` already provides the fast pinned Python
comparison and the live Kotlin job. Its `ANDROID_PIN_SHA` still points at `6cadf72` (the pre-release
Android `main`). Advance it to the merged Android `main` that vendored released Contract 2.0:

```text
ANDROID_PIN_SHA: 898e74ccab45e57017b4eb9807668d227bce0e34
```

`docs/ci/contract-conformance-pin.patch` contains that exact change. It is not applied here for the
same `workflow`-scope reason as the two workflow files above. Until it is applied, the live job
still runs and passes (the 38 fixtures and the Kotlin engine are unchanged), but its recorded
provenance is older than the merged Android `main`; the report must be read accordingly.
