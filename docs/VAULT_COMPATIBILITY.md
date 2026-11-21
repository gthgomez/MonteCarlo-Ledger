# Vault snapshot compatibility

The vault snapshot version describes stored records. The calculation contract remains 2.0. The forecast adapters translate stored relationships into cash events before calling the calculation engine.

| Snapshot | Python | Web | Android |
| --- | --- | --- | --- |
| 2.0 | Reads legacy ledgers | Reads legacy ledgers | Reads supported legacy ledgers |
| 2.1 | Reads and writes debts without payment links or inactive state | Reads and writes debts without payment links or inactive state | Reads and writes supported active debts |
| 2.2 | Reads and writes bill links and inactive debts | Reads and writes bill links and inactive debts | Supports Room payment links and inactive debts in the supported vault subset |

Older clients must reject 2.2 before replacing their local records. Retain a backup and upgrade every client that needs to open a 2.2 ledger. Account-linked Android debts still require a native encrypted backup. Vault snapshots do not include Android-specific account data, goals, assets, or rules.

## Payment links

A debt's optional `linked_payment_id` references a payment in the **same** snapshot, using the same identifier namespace as bill occurrences. A payment may be linked to one debt. A missing link means the debt is independent. A missing `is_active` means the debt is active. These fields require 2.2. Exporters may keep using 2.1 when the ledger has only active, unlinked debts.

Restore replaces a ledger transactionally. It does not combine rows from separate snapshots. Clients validate link references before replacement and translate incoming identifiers using the same mapping for payments and their references. Python stores imported payment IDs separately from SQLite row IDs. Android's Room-backed identifiers have a narrower supported range and some snapshot IDs are still platform-specific.

## Cash forecasts

The linked payment covers a debt minimum only for the matching schedule slot. A moved occurrence is matched using its original date, and its cash event uses the revised date. A linked bill below the minimum leaves a debt shortfall. A posted settlement covers only the amount recorded for that slot. The forecast starts from the entered outstanding debt balance and does not apply a recorded settlement to it a second time.

The scheduled bill represents the entered cash commitment. Keep that schedule up to date after payoff or when a lender changes its automatic debit. Deleting a linked bill removes the relationship and leaves any active outstanding debt in the forecast. Archived debts are retained in storage.

## Verification limits

The Python/Web identity regression uses a synthetic household and an independent integer-cent oracle. Calculation-engine conformance by itself does not demonstrate Room restore, native forecast, or device parity.
