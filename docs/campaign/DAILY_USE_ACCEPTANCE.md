# Daily-use acceptance

Starting default-branch heads fetched on 2026-11-25: Ledger
`f3367b7d98ca016bc81cb45c11556fd18e9259ac` (`master`); Android
`a0b70b40f1b39aea05eb92a50c265fb88a55592e` (`main`). Use synthetic plans in fresh
profiles, disposable SQLite files and loopback test servers. Keep individual
checks bound to the revision or locally changed files actually exercised.

| ID | Acceptance and why it matters | Platform / owner | State and evidence |
| --- | --- | --- | --- |
| FIN-01 | $500 opening cash and one $300 explicitly linked bill on the 15th against a debt minimum on the 20th leave $200. Unlinked identical records leave −$100. Compare date, outflow, balance and shortfall. | Android ledger adapter/dashboard; first dependency | Passing for Android `6e9aa952ba02367adeb35dd1f9f410bc4cfc9e38`: [API 34 emulator](https://github.com/gthgomez/MonteCarloLedger-Android/actions/runs/45763661539) rendered both outcomes and verified a $40 hypothesis leaves the actual ledger unchanged. Baseline `a0b70b4` failed the dashboard oracle: expected 20,000 cents, observed −10,000. |
| FIN-02 | A paid amount already in cash is not replayed. Partial payment leaves the genuine shortfall; moved bills retain their original obligation period and their new cash date; inactive rows do not hide independent debt. | Android/Python/Web adapters; depends on FIN-01 | Android `6e9aa95`: [unit gate](https://github.com/gthgomez/MonteCarloLedger-Android/actions/runs/45763661424) includes whole-cent, leap-month, moved, reserve and linked correction controls. Later schedule-template edits and legacy paid-without-transaction records still require cross-platform semantic qualification. |
| PAR-01 | Exact Android and Ledger candidates reproduce the supported contract fixtures. Adapter and displayed-result tests are separate from engine conformance. | Cross-repository CI + app qualification; depends on FIN-01 | Historical reference `7216e8d41994b63918c676c173cc306407ef04a9` alone cannot qualify either current Android candidate. |
| USE-01 | Start empty, enter cash and obligations, see a dated assessment, preview a purchase without writing it, record it exactly once, and see the changed answer after reload. | Web/Python/Android flows; depends on FIN-01 | Untested on current candidates. Existing Web household procedure: [W1](WEB_PYTHON_QUALIFICATION.md#household-and-model-checks). |
| USE-02 | Settle a bill, record income, correct and reconcile cash, then close and reopen without losing saved records or double-booking events. | App persistence + presentation | CLI baseline posted −$840 when reconciling $500 current cash and an $800 future receipt to $460. Candidate installed CLI posts −$40 once, retains the future receipt, and forecasts $460 low / $1,260 ending after reopen (Python 3.11, real SQLite). Web and Android journeys have separate acceptance. |
| USE-03 | Qualify normal entry, overview and recovery with keyboard and representative small, tablet and desktop layouts; separately check Android touch/font scaling and actual accessibility tools. | Web and Android UI | Untested. |
| REC-01 | Restore matching schedules, links, reserve and assumptions, or disclose/withhold incompatible guidance. Test stale revisions, interrupted writes, failed restore, restart and continuation. | Web/CLI/Android vault and backup | Browser baseline reproduced the gate disappearing after reload. Candidate writes a browser review guard and checks the encrypted profile's ledger revision. See [W2](WEB_PYTHON_QUALIFICATION.md#recovery-rehearsal-and-release-handling). |
| MODEL-01 | Forecast evaluation uses information present at each historical cutoff and measures daily minima and cash shortfalls where complete daily history exists. Show sample size and distinguish model results from observed rates. | Android backtest; shared evidence standard | Synthetic one-month cutoff/shortfall controls pass in the Android unit gate. Representative real history, account-complete 90-day replay and real-world predictive validity are unqualified. |
| REL-01 | Independently qualify installed Python, built Web and exact Android emulator candidates, with hosted recovery and distribution recorded separately. | Release integration; depends on the relevant gates above | Android `6e9aa95`: 44 tests on API 34 CI emulator and unsigned [release compile](https://github.com/gthgomez/MonteCarloLedger-Android/actions/runs/45763661353). Android Lab later admitted a managed AVD but it timed out booting; cleanup completed. Web `master` is linked to GitHub Production; Android `main` can trigger signing. No production merge is required for local qualification. |

## Financial vocabulary

- **Recorded cash now** is eligible posted cash through the assessment date.
  Future receipts and available credit are separate. A transfer between two
  eligible cash accounts does not change total cash.
- **Obligations** are unpaid required outflows. A linked scheduled payment and
  its liability minimum may represent the same obligation; amounts, names and
  similar dates alone do not prove a match.
- **Projected cash** is a dated balance conditional on entered activity. The
  low point is the smallest balance in the window; the ending balance can be
  higher even when cash runs short in the middle.
- **Reserve** is cash the user intends to keep. **Spending headroom** is the
  applicable low-point estimate after protecting that reserve; it is neither
  available credit nor the ending balance.
- **Forecast uncertainty** is conditional on the model's inputs. A seeded
  simulation can be reproducible without accurately estimating real-world odds.

## Reruns

- Ledger: follow the [local qualification procedure](WEB_PYTHON_QUALIFICATION.md#reproduce-the-local-gate).
- Use an empty, absolute local file path in `MC_QUALIFICATION_VAULT_FILE` to
  exercise the production libSQL storage path with `pnpm exec playwright test
  e2e/qualification-recovery.spec.ts e2e/portable-settings.spec.ts --workers 1`.
  Set `MC_QUALIFICATION_PYTHON` to the installed candidate interpreter. The
  defaults use memory. Neither path uses a hosted database or credentials.
- Android dashboard adapter: `./gradlew :app:testDebugUnitTest --tests '*ContractAdoptionDashboardTest' --no-daemon`.
  This verifies the ViewModel's financial presentation inputs, not device rendering.
- Android runtime: plan through `android-lab plan --project . --suite instrumentation`
  or use the repository's API 34 emulator CI. Preserve the exact device report.
- Exact engine/adapter check: choose the Ledger candidate ref in **Contract
  conformance**, dispatch `target=candidate-sha` with the full `android_sha`, and
  check the two observed SHAs and the strict comparison in the run report. A
  normal PR run may use the historical pin; its report cannot qualify a new
  Android candidate. The manual lane runs the Kotlin bridge and dashboard tests
  alongside the emitter, but it does not launch an app.
- To reproduce the exact comparison locally, emit fresh Python results with
  `python tools/conformance/run_python.py --out build/python-results`. From a
  clean exact Android candidate run `./gradlew :app:testDebugUnitTest --tests
  '*ContractEmitTest' --tests '*ContractScenarioBridgeTest' --tests
  '*ContractAdoptionDashboardTest' --no-daemon`. In the Ledger checkout,
  run `python tools/conformance/cross_engine.py --fixtures fixtures --python-dir
  build/python-results --kotlin-dir <android>/app/build/contract-results
  --kotlin-sha <full-android-sha> --contract-pin
  <android>/app/src/test/resources/contract/contract-pin.json --strict`.

## Engine-to-application map

“Exposed” below means the application calls the indicated owner. It is not a
claim that every scenario has been exercised on a current build.

| Decision | Calculation authority and required data | Application surface, limits and evidence |
| --- | --- | --- |
| What cash can I use now, and when will it run low? | Contract 2.0 dated cash flow; ledger adapter chooses eligible opening cash and dated obligations. | Python CLI/API and Web expose deterministic low/ending, Android Forecast/Analysis map the engine summary. Python installed CLI/API proves dated cash reconciliation. Android rejects ambiguous confirmed balances that might include future cash. |
| How much room do I have after a reserve? | Modeled low-point rank minus reserve with configured horizon, dates and ranges. | Web Home/Advanced, Python CLI/API options. Android engine accepts a reserve; the dashboard's standard path supplies zero. No parity claim for adjustable reserves. |
| Do upcoming bills or debts leave a shortfall? | Stable bill/occurrence/transaction and debt IDs, dated recurrence, forecast adapter. | Bills/Home (Web), interactive bills and CLI/API forecast (Python), Dashboard/Bills/Forecast (Android). Hand oracles cover linked and independent debt; special schedule types and settlement semantics still need separate qualification. |
| Can I buy this? What if payday is late? | Canonical scenario and a hypothetical dated edit, not a ledger write. | Web Plan and Android Forecast, Python command/API. Web hands a same-day purchase to record review; Android compares in the app. The hypothetical can disagree with later actual records if inputs or assumptions change. |
| What if a bill changes or a surprise arrives? | Web Plan bill-amount scenario; stochastic surprise-rate and magnitude inputs to the forecast engine. | Web Plan and Advanced, Python risk/CLI options, Android forecast risk inputs. Modeled probabilities are conditional. There is no verified empirical accuracy or three-platform dedicated unexpected-expense action. |
| How should I pay off debt? | Contract 2.0 amortization with balances, APR, minimums, chosen strategy and extra payment. | Web Plan and Android debt-payoff comparison expose snowball and avalanche; Python has technical engine interfaces. Monthly amortization is separate from the timing of an actual extra cash payment. |
| Am I on track for the spending target? | Posted expense totals by period/category, plus planned commitments where separately shown. | Web Budget and Android category tracker; planning and forecast state differ across platforms. Browser budget targets are only paired through Web's companion vault profile. |
| How well did earlier forecasts match actual cash? | Android historical calibration and offline month-end/trough backtest. | Android shows provenance; the backtest is technical and synthetic. No evidence for calibrated 90-day real-world shortfall odds. |
| What belongs in my spendable accounts? | Eligible-cash classification at the adapter, never available credit. | Android has account routing; the shared ledger snapshot and Web/Python cannot represent all Android account semantics. Internal-transfer qualification and portable account semantics remain blockers. |

Actual Budget's [reconciliation workflow](https://actualbudget.org/docs/accounts/reconciliation/)
shows the cleared amount and difference before committing a correction. The
applicable behavior here is to show the dated cash basis separately from the
ledger total (Python) and preserve the balance adjustment preview (Web).
MonteCarlo does not infer a bank-cleared state or lock transactions on that basis.
