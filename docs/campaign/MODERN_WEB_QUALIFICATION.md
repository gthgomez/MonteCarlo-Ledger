# Modern workspace qualification

## Candidate and production boundary

- Production deployment `8023842802` succeeded at `f3367b7d98ca016bc81cb45c11556fd18e9259ac` on `master`. The public URL rendered the existing sample workspace in an isolated Chromium context.
- The redesign is stacked on draft [#68](https://github.com/gthgomez/MonteCarlo-Ledger/pull/68) at `f9b671aaad86bb87925abf0f190400c571135456`. That draft provides current purchase recording, reconciliation, settings and vault recovery. The older deployment is the production reference; the exact #68 head is the local before/after baseline.
- [#61](https://github.com/gthgomez/MonteCarlo-Ledger/pull/61) is closed without merge. Its debt case is covered by later work and rechecked through the browser. [#62](https://github.com/gthgomez/MonteCarlo-Ledger/pull/62) and [#64](https://github.com/gthgomez/MonteCarlo-Ledger/pull/64) merged. GitHub listed `v0.1.0` as a pre-release.
- Vercel publishes previews for feature branches and a production deployment for commits on `master`. Integrating a branch into `master` requires production-promotion authorization. Use the stacked draft preview for synthetic qualification.

## Finding → root cause → change → evidence

| Finding and root cause | Implementation | Verification and status |
| --- | --- | --- |
| Cash, Safe-to-Spend, and forecast lows had equal weight; mobile navigation occupied multiple sticky rows. | An inset workspace groups destinations on desktop. The phone dock exposes daily destinations and quick entry, with a compact utility header. Home leads with the engine's modeled spending result and shows confirmed cash, expected payday, and the dated low separately. | Chromium screenshot matrix, route reflow, keyboard command/focus, and existing household journey. |
| Activity was difficult to scan and correct. | Date-first, paged activity with local search, sorting and filters. A native dialog presents corrections beside the ledger on desktop and as a sheet on phones. The command menu can look up matching activity. | Transaction correction/deletion, pending write, invalid value, viewport and storage retry specs. |
| The timeline showed equal gaps between events; estimates could outrank the actual schedule. A reserve gap could be called an overdraft. | The chart uses elapsed dates and steps on posted events; every visible view has an agenda alternative. What-if snapshots stay in the Plan pane and respect the current guidance gate. Reserve shortfalls have separate copy. | Browser touch/keyboard chart selection and the `$190` low below a `$300` reserve with no deterministic overdraft. |
| The Home/Bills split matched planned outflows by display values, and a second minimum projection could throw outside engine error handling. | The Web adapter carries runtime event provenance and returns minimum details through the guarded evaluation. | Adapter oracle for identical rows and overflow; real browser `$500` opening cash minus a `$300` debt minimum gives `$200`. |
| A payday delay could move a future refund; recording an actual paycheck could double-count or consume the wrong date. | The scenario selects scheduled income only. Receipt entry identifies the exact schedule and scheduled date, then posts actual income and advances the schedule in one stored ledger write. | Independent $250 low/$650 ending refund-delay oracle; late receipt picks the original date, leaves the next payday intact, fails and retries without duplicate cash. |
| A moved linked bill could leave part of the minimum on the wrong date or outside the calculation. | Python and TypeScript keep the original slot for ownership and apply cash on the moved date, including moves across the forecast window. Month fallback uses the earliest original slot for the same payment ID only after exact lookup fails. | Independent covered/shortfall, brought-forward and carried-over oracles in both surfaces. |
| An unrecorded recurring bill could disappear after its due day. | Newly saved monthly bills have a known first due date. For anchored schedules, the earliest past slot without an outcome stays in Bills for explicit resolution and withholds modeled spending guidance; no historical debit is invented. | Browser rollover, no-new-expense resolution, reload, and exact saved occurrence identity. Legacy monthly templates without a first date cannot establish historical slots. |
| Python could commit a debit before its payment link failed, or export a snapshot its validator would reject. | One SQLite transaction for posting and linking. Incompatible linked template edits are rejected. Existing snapshot validation gates local export and vault publication. | Forced post-insert failure rolls back cash and link; lower-than-full settlement fails without mutation; invalid snapshots fail before vault access. |
| Recovery, dark mode, and setup affordances were hard to find on phones. | Progressive setup groups, confirmed writes, compact vault form, system/light/dark appearance, privacy curtain, install manifest and component reference at `/design`. | Browser validation and recovery, dark/light screenshots, focus checks, and served manifest/icons. |

Design references: [Linear](https://linear.app/now/behind-the-latest-design-refresh) for recessed chrome;
[Mercury](https://mercury.com/blog/updated-transactions-page) and [Copilot](https://www.copilot.money/)
for numeric hierarchy and activity; [Monarch](https://www.monarch.com/), [Rocket Money](https://www.rocketmoney.com/)
and [YNAB](https://www.ynab.com/) for navigation and plain-language commitments;
[Simplifi](https://www.quicken.com/features/projected-cashflow/), [PocketSmith](https://www.pocketsmith.com/features/budgets-and-planning/)
and [PocketGuard](https://pocketguard.com/) for spending decisions; [Vercel](https://vercel.com/design/guidelines),
[Apple](https://developer.apple.com/design/human-interface-guidelines/materials), [shadcn/ui](https://ui.shadcn.com/blocks/dashboard),
and [MDN](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API) for controls, surfaces, and motion.
Only public pages and help content were examined.

## Scope and rollback

- The Web ledger still has a single manual cash pool. It does not model transfers between accounts, bank aggregation, or statement deduplication. JSON restore replaces a validated snapshot; it is not a merge.
- Bill occurrences in the shared format are paid/unpaid. The engine can represent a linked amount smaller than a debt minimum and forecast the shortfall, but the Web editor does not accept arbitrary partial bill settlements. Confirm the actual lender balance separately. Payday receipts consume a selected schedule occurrence; deleting an income transaction does not reconstruct that occurrence.
- Screen-reader/device certification, hosted vault recovery with real credentials, and field performance are outside a local synthetic browser pass. The Android app has its own account model and native workflows; compare engine fixture conformance separately from product behavior.
- Before promotion, closing the stacked PR or redeploying its predecessor affects only preview code. If later promoted, use the last verified production deployment at `f3367b7` as the Vercel rollback point and revert the promoted Git changes through the normal PR workflow. Neither operation rewinds a user's browser or SQLite ledger. Preserve a verified JSON/vault backup before any intentional data replacement.
