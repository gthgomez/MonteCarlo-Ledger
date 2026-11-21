# Vault snapshot compatibility

The vault snapshot version describes stored records. The calculation contract remains 2.0. The forecast adapters translate stored relationships into cash events before calling the calculation engine.

| Snapshot | Python | Web | Android |
| --- | --- | --- | --- |
| 2.0 | Reads legacy ledgers | Reads legacy ledgers | Reads supported legacy ledgers |
| 2.1 | Reads and writes debts without payment links or inactive state | Reads and writes debts without payment links or inactive state | Reads and writes supported active debts |
| 2.2 | Reads and writes bill links and inactive debts | Reads and writes bill links and inactive debts | Supports Room payment links and inactive debts in the supported vault subset |

Older clients must reject 2.2 before replacing their local records. Retain a backup and upgrade every client that needs to open a 2.2 ledger. Android uses its native encrypted backup for inactive bills, account-linked debts, and debts with statement closing dates. Vault snapshots do not include Android-specific account data, goals, assets, or rules.

## Payment links

A debt's optional `linked_payment_id` references a payment in the **same** snapshot, using the same identifier namespace as bill occurrences. A payment may be linked to one debt. A missing link means the debt is independent. A missing `is_active` means the debt is active. These fields require 2.2. Exporters may keep using 2.1 when the ledger has only active, unlinked debts.

Restore replaces a ledger transactionally. It does not combine rows from separate snapshots. Clients validate link references before replacement and translate incoming identifiers using the same mapping for payments and their references. Python stores imported payment IDs separately from SQLite row IDs. Android maps opaque canonical values to Room keys and retains the canonical values in its local database. A link belongs to a single snapshot and carries no meaning in another vault.

## Cash forecasts

The linked payment covers a debt minimum only for the matching schedule slot. A moved occurrence is matched using its original date, and its cash event uses the revised date. A linked bill below the minimum leaves a debt shortfall. A posted settlement covers only the amount recorded for that slot. The forecast starts from the entered outstanding debt balance and does not apply a recorded settlement to it a second time.

Persisted overdue unpaid occurrences count at the start of the plan. A forecast refresh does not invent past recurring payments. The scheduled bill represents the entered cash commitment. Keep that schedule up to date after payoff or when a lender changes its automatic debit. Deleting a linked bill removes the relationship and leaves any active outstanding debt in the forecast. Archived debts are retained in storage.

## Verification limits

The shared synthetic identity fixture is `testdata/household/vault-payment-identity.json`. Python restores it into SQLite, Web validates and forecasts the exported snapshot, and the Android Room test reads a byte-identical copy. The independent oracle expects 70,000 cents after one linked payment and 20,000 cents after two separate obligations, with a 10,000-cent reserve. Device journeys and broader household parity need their own evidence.

## Release and recovery

Vault 2.2 changes the encrypted client payload, which remains opaque to the vault server. A rollout needs readers for 2.2 before relying on writers that can create it. Check the Android and Python clients that are in use, plus the Web preview, using synthetic data. Keep a pre-upgrade recovery copy.

The [production baseline commit](https://github.com/gthgomez/MonteCarlo-Ledger/commit/e18e2f97f11cf6aac36d462fd4c0c149bb73bae8) predates vault 2.2. If production needs a rollback before 2.2 has been used, promote the last verified production deployment or revert the production merge. Once 2.2 snapshots exist, use a rollback build that retains the 2.2 reader. Keep the encrypted vault and local copies intact. An older client may reject a 2.2 ledger, so an application rollback does not downgrade financial data.
