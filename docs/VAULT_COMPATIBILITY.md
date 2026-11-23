# Vault snapshot compatibility

The vault snapshot version describes stored records. The calculation contract remains 2.0. The forecast adapters translate stored relationships into cash events before calling the calculation engine.

| Snapshot | Python | Web | Android |
| --- | --- | --- | --- |
| 2.0 | Reads legacy ledgers | Reads legacy ledgers | Reads supported legacy ledgers |
| 2.1 | Reads and writes debts without payment links or inactive state | Reads and writes debts without payment links or inactive state | Reads and writes supported active debts |
| 2.2 | Reads and writes bill links and inactive debts | Reads and writes bill links and inactive debts | Supports Room payment links and inactive debts in the supported vault subset |

Older clients must reject 2.2 before replacing their local records. Retain a backup and upgrade every client that needs to open a 2.2 ledger. Android uses its native encrypted backup for inactive bills, account-linked debts, and debts with statement closing dates. Vault snapshots do not include Android-specific account data, goals, assets, or rules.

## What follows the ledger

| Data | Shared vault and Web JSON ledger backup | How to preserve the rest |
| --- | --- | --- |
| Recorded cash entries, income schedules, supported bills and their dated occurrences and settlements | Included. Links between records belong to the same snapshot. | Keep a separate local ledger backup before a restore or an upgrade. |
| Supported debts and minimums | Included; payment links and inactive debt state require 2.2 readers. | Keep the originating client's backup if it stores additional debt fields. |
| Web budget targets, forecast settings (including reserve, window, and risk assumptions), theme | Not included. They stay in that browser profile; pulling into a fresh profile does not recover them. | Keep a separate record of the settings you want to reproduce. Different inputs can yield different forecasts from identical ledger data. |
| Android-only accounts, assets, goals, and rules; inactive bills, account-linked debts, and statement closing dates | Not included in the portable snapshot. Use Android's native encrypted backup, not a vault pull, to preserve this data. | Retain the native backup and qualify its restore on the intended Android build. |

The Web export is **unencrypted JSON**. Treat it as sensitive and keep it offline or in a protected
location. A vault copy is encrypted before upload, but the server handles vault identifiers,
authentication and revision metadata. Clearing browser storage does not remove a server-side vault
snapshot. Neither kind of copy is a record-by-record merge.

If the browser has a ledger you want to keep, close **Sync** and use **Export** in the header first.
Record the vault ID and passphrase in a safe place outside this browser; losing browser data
can also remove the saved ID. To recover, open **Sync → Encrypted vault** and pull with both, or use
**Sync → Local JSON Backup** to import an exported ledger. Closing Sync while a restore is pending
discards that restore. Web Sync and ledger replacement require cross-tab locking; use a
current browser on HTTPS or loopback. Close older versions of the app in other tabs before
synchronizing. If another tab changes the saved ledger, the old tab withholds forecasts and
keeps its open drafts. Copy any drafts before reloading to review the current saved ledger.
If storage fails during restore and the previous data cannot be verified, some or all of the
change may have persisted. The warning remains after closing Sync. Export the previous ledger
and copy any drafts before explicitly reloading to inspect what is saved. Until then, forecasts,
ledger writes, and Sync are paused in that tab. In a browser without Web Locks, ordinary edits
still work locally, but only one tab should edit the ledger.

Unsaved form drafts are not included in exports or vault snapshots. A successful replacement
clears the open drafts in that tab; matching IDs do not transfer drafts to the new ledger.
If a save failed, the app asks before replacing the ledger. Cancel and keep a copy of the
draft if you need it. A failed or declined replacement does not clear the open draft.

After restoring, check the recorded balance, the next required payment and any bill-to-debt links.
Re-enter browser-only settings under **Budget** and **Advanced**; they can differ from the settings
used when the ledger was last viewed. If validation fails or you see a conflict, retain the local
copy and resolve the mismatch before pushing anything back.

## Payment links

A debt's optional `linked_payment_id` references a payment in the **same** snapshot, using the same identifier namespace as bill occurrences. A payment may be linked to one debt. A missing link means the debt is independent. A missing `is_active` means the debt is active. These fields require 2.2. Exporters may keep using 2.1 when the ledger has only active, unlinked debts.

Restore replaces a ledger; it does not combine rows from separate snapshots. Clients validate link references before replacement and translate incoming identifiers using the same mapping for payments and their references. Python stores imported canonical IDs separately from SQLite row IDs. Android maps opaque canonical values to Room keys and retains the canonical values in its local database. A link belongs to a single snapshot and carries no meaning in another vault.

## Cash forecasts

The linked payment covers a debt minimum only for the matching schedule slot. A moved occurrence is matched using its original date, and its cash event uses the revised date. A linked bill below the minimum leaves a debt shortfall. A posted settlement covers only the amount recorded for that slot. The forecast starts from the entered outstanding debt balance and does not apply a recorded settlement to it a second time.

Persisted overdue unpaid occurrences count at the start of the plan. A forecast refresh does not invent past recurring payments. The scheduled bill represents the entered cash commitment. Keep that schedule up to date after payoff or when a lender changes its automatic debit. Deleting a linked bill removes the relationship and leaves any active outstanding debt in the forecast. Archived debts are retained in storage.

On Web, a one-time bill with a past due date and no saved occurrence needs review before
the app offers spending or risk guidance. The payment may already be in **Money**. In **Bills**,
link an eligible recorded expense for the full amount without debiting your balance again.
If the full payment is already reflected in your starting or reconciled cash, you can mark
that past bill paid without a new transaction. Only record a new expense if neither **Money**
nor the current cash balance reflects that payment. If you recorded it in parts, check the
entries rather than adding the full expense again. If it is still unpaid, move the bill to
the date you expect to pay. An upcoming one-time bill outside the chosen window is not included
in its estimates; extend the window under **Advanced** to plan for it.

## Verification limits

The shared synthetic identity fixture is `testdata/household/vault-payment-identity.json`. Python restores it into SQLite, Web validates and forecasts the exported snapshot, and the Android Room test reads a byte-identical copy. The independent oracle expects 70,000 cents after one linked payment and 20,000 cents after two separate obligations, with a 10,000-cent reserve. Device journeys and broader household parity need their own evidence.

## Release and recovery

Vault 2.2 changes the encrypted client payload, which remains opaque to the vault server. A rollout needs readers for 2.2 before relying on writers that can create it. Check the Android and Python clients that are in use, plus the Web preview, using synthetic data. Keep a pre-upgrade recovery copy.

The [production baseline commit](https://github.com/gthgomez/MonteCarlo-Ledger/commit/e18e2f97f11cf6aac36d462fd4c0c149bb73bae8) predates vault 2.2. If production needs a rollback before 2.2 has been used, promote the last verified production deployment or revert the production merge. Once 2.2 snapshots exist, use a rollback build that retains the 2.2 reader. Keep the encrypted vault and local copies intact. An older client may reject a 2.2 ledger, so an application rollback does not downgrade financial data.
