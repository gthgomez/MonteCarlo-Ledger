# MC-12 — Engineering campaign baseline (2026-11-09)

## Repository heads (verified this run)

| Repo | Branch | SHA |
|------|--------|-----|
| MonteCarlo-Ledger | `master` | `141b82710a6037687c39ee9cdf1944a1d56dd034` |
| MonteCarloLedger-Android | `main` | `fd8924dc9a1852066a569eba1da99d27595dfab6` |

Recent merges: Ledger PR #56 (liabilities, MCP, CI), #57 (Android pin bump); Android PR #41 (vault sync MVP).

## Issue classification (pre-fix)

| ID | Topic | Status before MC-12 PRs |
|----|--------|-------------------------|
| P0-A | Android first-time / join sync | **Reproduced** — pull blocked without overwrite UX; no create flow |
| P0-B | Snapshot fingerprint | **Reproduced** on Android; **fixed** Python/Web |
| P0-C | Lossy recurrence mapping | **Reproduced** — quarterly → monthly on export |
| P0-D | Cross-platform identities | **Partial** — string debt ids; Android `getInt` import |
| P0-E | Restore vs sync metadata atomicity | **Reproduced** — fragmented `apply()` prefs |
| P0-F | HTTPS vault URLs | **Reproduced** — comment-only policy |
| P0-G | Turso durability | **Blocked** — no staging credentials in agent |
| P2-B | MCP `init_db` on startup | **Reproduced** |
| P2-C | P10 mislabeled as p1 | **Reproduced** |

## In-progress fixes (this campaign)

Android branch `cursor/sync-p0-safety-ac55`: canonical fingerprint, sync state machine, HTTPS, fail-closed export, vault restore scope, create/join UI.

Ledger branch `cursor/campaign-p0-mcp-web-ac55`: MCP refuses missing DB, Web accepts missing `liabilities`, P10 explanation copy.

## Evidence matrix (to extend)

See section 14 of the campaign brief; Turso and full Python→Web→Android household journey remain **open** after these PRs.
