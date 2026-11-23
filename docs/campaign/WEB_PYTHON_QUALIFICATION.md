# MonteCarlo qualification: Web and Python

## Outcome and scope

Qualify a reproducible **Web/Python release candidate**, not a production deployment or a
cross-platform release. A first-time user should be able to enter a household, understand what
would change before spending, and recover the supported ledger in a fresh client. A number users
cannot explain, or data they can lose without a warning, is a release defect.

- Starting revisions: Ledger `e7699ad` (Web and Python, including #63); Android `833ce2a`
  (including #47 and #48). Reuse the existing household, timing, and payment-identity fixtures.
  Test the final candidate, not just these starting revisions or the old development worktrees.
  This campaign qualifies the shipped design. A future onboarding or assessment redesign needs a
  fresh journey on its own revision; it cannot inherit these passes for changed screens.
- Android work is **documentation only**. Do not run Android builds, unit tests, emulators, or
  phones in this campaign. No sign-off on Android behavior, store data safety, or distribution.
- Use synthetic households, disposable SQLite files, and fresh browser contexts on loopback.
  Do not access existing user ledgers, credentials, or live vaults. Hosted staging is a separate
  approval and an additional gate for hosted-sync claims. No deploy, publishing, or release signing.
- Keep integer cents, explicit dates, stable record identity, validated restore before replacement,
  and existing auth/revision checks. Forecast math lives in the existing engine, never in a
  component. Snapshot 2.2 and Calculation Contract 2.0 are distinct.

## Work packages in dependency order

| Gate | Deliverable | Acceptance |
| --- | --- | --- |
| W0 — Baseline | Clean task branches, frozen Web lockfile, Python dev environment, matching Playwright Chromium | Record both source revisions, tool versions, locale/timezone, and backend type. Don't substitute a cached browser for final evidence. Check required suites on the candidate. |
| W1 — Household | One uninterrupted fresh-browser journey through normal controls, plus fixture-level Python/Web comparison | Hand-derive the posted cash, dated events, first low, ending cash, reserve-adjusted spending, and the effect of a hypothetical decision. Do not compute expected amounts with either app. Require cents/dates to match; a comparison must not post a transaction. |
| W2 — Recovery | Real browser → vault HTTP routes → real Python sync/SQLite → fresh browser on a disposable backend | Match supported fields and payment/occurrence links, not just record counts. Verify the Python change appears exactly once; repeat pull and reject an invalid restore without replacing good data. A memory-backend pass proves neither disk durability nor hosted recovery. |
| W3 — Disclosure | Android policy correction and a data-placement matrix; Web settings disclose the relevant limits before a restore | Audit source and manifest. State what is local, what optional sync sends, what is not included, and why a local erase is not a remote delete. Do not promise support for Android-only data or Web-only preferences. |
| W4 — Beginner UX and uncertainty | Clarify the first useful result and its assumptions; focused keyboard, small-screen and offline checks; scripted novice study | Withhold unsupported conclusions rather than show reassuring placeholder numbers. Explain cash now vs. spendable cash, what could change, and where to fix a missing input. Simulated probabilities are conditional model estimates. |
| W5 — Debt decision | In the debt planner, show how a proposed **one-time** extra payment on a chosen date affects the same cash forecast | Compare current plan with a hypothetical outflow using the existing engine and assumptions; test reserve and shortfall cases and date boundaries. No ledger write, no deduction from both a bill and the extra payment, no implicit change to later lender bills or required minimums. Keep monthly payoff strategy distinct until dated lender behavior can be modeled and verified. |
| W6 — Candidate and handoff | Rehearsed local recovery, cross-client evidence, and explicit release gates | Record command results, scenario/fixture identity, artifact/revision tested, and pass/fail/not-run reasons. A data loss, misleading result, or material disclosure defect blocks sign-off; distinct explicitly deferred gates never count as passes. |

### Household and model checks

1. Start empty with a fixed date and timezone. Enter opening cash, a recurring or dated paycheck,
   a rent/bill commitment, and a debt minimum; start with a linked payment case. Include a
   same-looking-but-independent payment case in the fixture tests so an equality heuristic
   cannot hide double counting. Document the event date, signed cents, running cash, and reason.
2. Use zero variance for the hand oracle, a planned reserve, and an obligation before a delayed
   paycheck. Assert direction **and** cents/dates at the important transitions. Verify that
   recorded balance does not include a future receipt and that a moved bill follows its new date,
   retains its original slot, and stops forecasting that slot when paid. Reopen the browser to
   verify edits and assumptions persisted; use a new context to prove recovery separately.
3. Exercise modeled uncertainty separately with a fixed seed, exact inputs, and model ranges.
   Compare Web and Python only with the same scenario, seed, settings, and supported fields.
   Include boundary cases: opening cash already short, no eligible paycheck, zero/below-reserve
   headroom, month-end/leap-year recurrence, partial settlement, an unresolved one-time overdue bill,
   and a bill on the first excluded day. For an overdue bill, verify that both linking a recorded
   expense and marking a payment already reflected in starting cash leave cash unchanged. Record
   an expense exactly once only when the paid amount is not yet reflected in the ledger.
   Check that a fixed dated extra debt payment stays fixed and compares the same draws of
   other bills and surprises. This Web what-if is not a new serialized contract option.
   A reproducible seed or synthetic backtest checks implementation, not calibration.
4. For future historical validation, freeze a consented, de-identified corpus and evaluate
   predictions from past cutoffs against later complete observations. Record coverage, sample
   size, missing data, and performance against a simple baseline, broken down by 30-, 60-, and
   90-day horizons. Set cutoffs and inclusion rules before looking at outcomes; never use a
   transaction beyond the cutoff to tune that prediction. Compare the observed rate of low-balance
   events with the model's probability ranges (including sample counts and uncertainty), and
   report a probability score such as Brier loss against a prior-observed-frequency baseline.
   No empirical probability claim without that evidence; keep synthetic histories separate.
5. Finish the initial setup with cash only, record an expense and an independent debt, then add
   a schedule from Home. Verify the original rows and cash through reload. Repeat after importing
   a ledger without schedules. Adding a bill or income must not start a new ledger.

### Recovery rehearsal and release handling

- Start an isolated local release build with a test vault backend and a new vault ID. Before trying
  any restore, keep a separate validated local copy; plaintext exports are sensitive and must not
  be shared. For automated checks use only synthetic one-time credentials, never a personal vault.
- Push a known Web ledger; in disposable Python SQLite pull it, compare stable identifiers and
  references, make a known edit, and push a new revision. From a second clean browser session
  restore it, compare opening/forecast results and reference/occurrence counts, then reload and
  re-pull. Check wrong passphrase, invalid/unsupported snapshot or write failure, and a revision
  conflict. A failed pull must leave the prior local state unchanged; a conflict must not silently
  overwrite another client's update. Preserve good local data before resolving a conflict. Also hold
  a Web pull while another tab saves an edit, and verify that the older pull cannot commit over it.
  In a fresh Web profile, confirm a successful push keeps the selected vault ID after reload
  and tell users to keep the ID and passphrase independently of the browser.
- Test local persistence independently of sync: current tab with network off, online reload without
  vault access, and opening offline after a prior visit. Report each independently; a loaded tab
  working offline is not proof that an offline cold start works. In the loaded tab check the
  cash date and fresh form defaults across local midnight. A date the user chose or submitted in
  a valid draft must not change while a save is pending or after it fails; a retry uses that date
  unless the user changes it. A validation error before a write must not pin an untouched date.
  Hold a ledger save and verify the page warns before leaving and prevents a second submission.
  Check that a recurring bill's move or payment draft remains accessible even after its slot
  leaves the current schedule, without creating a saved occurrence or forecast expense. A failed
  draft stays in the open section, not in the saved ledger. Verify that
  cancelling a section switch preserves the values, switching debt editors preserves each
  debt's own draft, and intentionally discarding one draft does not clear another's warning.
  Keep a copy before deliberately discarding drafts or reloading. Do not claim first-ever offline
  load for a hosted browser app.
- When a validated backup replaces the ledger, existing form drafts must not carry across to the
  new ledger, even when payment or debt IDs match. Declining to discard a failed draft or failing
  to save the replacement must leave the draft and the old saved ledger intact.
- With a failed draft open, trigger a real calculation error with a different valid ledger edit
  or a settings error in another tab. No forecast or cached substitute should be shown. Verify
  the edit that did save, the other draft's recoverable values, and recovery from the error
  without replacing either.
- If hosted staging is authorized later, record the exact preview build, isolated database and
  synthetic-only fixture scope (no secrets in the record). Repeat Web ↔ Python, including restart
  and conflict handling. Stop if staging identity or isolation cannot be established. Separately
  rehearse the full device round trip once Android is resumed. Keep a compatible 2.2 reader in the
  rollback plan; rolling back app code does not downgrade saved vault data. See
  [vault compatibility](../VAULT_COMPATIBILITY.md).

### Unaided beginner study (prepared here; requires participants)

Invite people who have not used the app. Give each the same fake household and four goal prompts:
record starting money and a bill, decide whether to spend a given amount, explain what the reserve
and a late payday would do, recover in a fresh browser. Do not name screens or give hints. Ask
participants to explain `money available now` vs. the cautious amount and what is or is not synced.
Record time to first useful plan, unaided completion, mistaken interpretations, and recovery
failures. Use the product targets (median ≤5 minutes to first useful plan and ≥90% unaided core
completion) as targets, not findings; report sample size and do not extrapolate from a small pilot.

## Evidence and release decisions

Run Python Ruff, Pyright, and pytest; Web type check, unit tests, production build and desktop/mobile
Playwright; compare the supported contract corpus on Python and Web. Keep hosted CI, production
identity, live staging, real people, representative calibration, and Android acceptance as separate
evidence columns. Retain local rerun commands and non-secret artifacts; do not treat historical CI,
a revision number, or an HTTP 200 as acceptance evidence. Re-run the affected lanes after fixes and
ask for a fresh independent review of the changed behavior.

### Reproduce the local gate

Run from a disposable checkout without any environment configuration files, live database or vault
configuration, or existing ledger. Use the Node and pnpm versions selected by the Web CI.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -e '.[dev]'
pnpm --dir web install --frozen-lockfile
pnpm --dir web exec playwright install chromium

.venv/bin/python -m ruff check .
.venv/bin/python -m pyright
pnpm --dir web lint
pnpm --dir web test
.venv/bin/python -m pytest -q
MC_QUALIFICATION_PYTHON="$PWD/.venv/bin/python" pnpm --dir web test:e2e
```

The recovery proof requires the explicit Python interpreter. Do not count an ordinary browser run
that skips the integration as qualification. The browser test server uses a process-local vault
backend. Keep the actual hosted deployment and environment in a separate record; a Vercel status
for the baseline is not evidence that a new candidate is deployed or that live recovery works.

The **local candidate gate** can pass without authorizing deployment. An **everyday-use Web release**
needs evidence for each claim it makes, including real novice comprehension and hosted recovery if
hosted sync is promoted. A **cross-platform release** additionally needs exact-build Android
install/onboarding, restore and upgrade, offline and accessibility checks on a phone, supported
parity, and separately authorized signing/distribution. The Android in-app Privacy dialog still
contradicts the network permission; correct and validate it before that release. Do not infer any
of those passes from a repository policy fix.
