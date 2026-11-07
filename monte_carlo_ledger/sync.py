"""End-to-End Encrypted Cloud Vault Sync for MonteCarlo-Ledger.

Provides zero-knowledge backup and bidirectional sync between local SQLite (`ledger.db`)
and the Turso-backed edge vault API. Plaintext financial records never leave the local machine.

Credential policy: the vault passphrase is never accepted as a command-line argument
(shell history / process listing would leak it) and is never persisted. Supply it via
the MC_LEDGER_SYNC_PASSPHRASE environment variable or the hidden interactive prompt.
"""

from __future__ import annotations

import base64
import getpass
import hashlib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone
from typing import Any, Dict, Optional, Tuple

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from . import db_manager

SYNC_CONFIG_FILE = ".ledger-sync.json"
DEFAULT_SERVER_URL = "https://montecarlo-ledger.vercel.app"
PASSPHRASE_ENV = "MC_LEDGER_SYNC_PASSPHRASE"


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _warn_stored_passphrase() -> None:
    print(
        "warning: .ledger-sync.json contains a plaintext passphrase (deprecated and "
        "insecure); run `monte-carlo-ledger sync lock` to remove it from disk. "
        "Push/pull will prompt for the passphrase after that.",
        file=sys.stderr,
    )


def resolve_passphrase(
    supplied: Optional[str] = None, confirm: bool = False, prompt: str = "Vault passphrase: "
) -> str:
    """Resolve the vault passphrase without ever accepting it from argv.

    Order: explicit argument (programmatic callers) -> MC_LEDGER_SYNC_PASSPHRASE
    environment variable -> hidden interactive prompt (with confirmation when
    creating a new vault).
    """
    if supplied:
        return supplied
    env_passphrase = os.environ.get(PASSPHRASE_ENV)
    if env_passphrase:
        return env_passphrase
    passphrase = getpass.getpass(prompt)
    if confirm:
        repeated = getpass.getpass("Repeat vault passphrase: ")
        if passphrase != repeated:
            raise ValueError("Passphrases do not match.")
    if not passphrase:
        raise ValueError("Passphrase must not be empty.")
    return passphrase


def derive_keys(passphrase: str, salt: bytes) -> Tuple[str, bytes]:
    """Derive auth_token (base64) and 32-byte AESGCM key via PBKDF2-HMAC-SHA256."""
    derived = hashlib.pbkdf2_hmac("sha256", passphrase.encode("utf-8"), salt, 100000, 64)
    auth_token = base64.b64encode(derived[:32]).decode("ascii")
    enc_key = derived[32:64]
    return auth_token, enc_key


def encrypt_payload(data: Dict[str, Any], enc_key: bytes) -> Tuple[str, str]:
    """Encrypt payload dict to (ciphertext_b64, nonce_b64) using AES-256-GCM."""
    nonce = os.urandom(12)
    aesgcm = AESGCM(enc_key)
    plaintext = json.dumps(data, sort_keys=True).encode("utf-8")
    ciphertext = aesgcm.encrypt(nonce, plaintext, None)
    return (
        base64.b64encode(ciphertext).decode("ascii"),
        base64.b64encode(nonce).decode("ascii"),
    )


def decrypt_payload(ciphertext_b64: str, nonce_b64: str, enc_key: bytes) -> Dict[str, Any]:
    """Decrypt (ciphertext_b64, nonce_b64) using AES-256-GCM."""
    ciphertext = base64.b64decode(ciphertext_b64)
    nonce = base64.b64decode(nonce_b64)
    aesgcm = AESGCM(enc_key)
    plaintext = aesgcm.decrypt(nonce, ciphertext, None)
    return json.loads(plaintext.decode("utf-8"))


def export_ledger_snapshot() -> Dict[str, Any]:
    """Export local ledger state as a canonical snapshot dictionary."""
    is_sync, ledger_balance, stored_balance = db_manager.validate_balance_consistency()
    if not is_sync:
        raise ValueError(
            f"Cannot export desynchronized ledger. Stored: {stored_balance}, Ledger: {ledger_balance}. Reconcile first."
        )

    incomes = [
        {
            "id": inc.id,
            "name": inc.name,
            "amount_cents": inc.amount,
            "frequency": inc.frequency,
            "last_payday": inc.last_payday,
            "next_payday": inc.next_payday,
            "expected_amount": inc.expected_amount,
        }
        for inc in db_manager.get_all_income()
    ]

    payments = [
        {
            "id": pmt.id,
            "name": pmt.name,
            "amount_cents": pmt.amount,
            "due_day": pmt.due_day,
            "recurrence": pmt.recurrence,
            "due_date": pmt.due_date,
            "is_auto_withdraw": bool(pmt.is_auto_withdraw),
        }
        for pmt in db_manager.get_all_payments()
    ]

    with db_manager.get_db_connection() as conn:
        tx_rows = conn.execute("SELECT id, amount, category, type, date, description FROM transactions ORDER BY id").fetchall()
        transactions = [
            {
                "id": r["id"],
                "amount_cents": r["amount"],
                "category": r["category"],
                "type": r["type"],
                "date": r["date"],
                "description": r["description"],
            }
            for r in tx_rows
        ]

        occ_rows = conn.execute("SELECT id, payment_id, due_date, paid, transaction_id FROM bill_occurrences ORDER BY id").fetchall()
        occurrences = [
            {
                "id": r["id"],
                "payment_id": r["payment_id"],
                "due_date": r["due_date"],
                "paid": bool(r["paid"]),
                "transaction_id": r["transaction_id"],
            }
            for r in occ_rows
        ]

    return {
        "version": SNAPSHOT_VERSION,
        "updated_at": _utc_now_iso(),
        "current_balance_cents": ledger_balance,
        "incomes": incomes,
        "payments": payments,
        "transactions": transactions,
        "bill_occurrences": occurrences,
        "liabilities": [],
    }


SNAPSHOT_VERSION = "2.1"
# 2.0 snapshots predate incomes[].expected_amount; they restore with a null override.
SUPPORTED_SNAPSHOT_VERSIONS = ("2.0", "2.1")
_SNAPSHOT_FIELDS = frozenset(
    {
        "version",
        "updated_at",
        "current_balance_cents",
        "incomes",
        "payments",
        "transactions",
        "bill_occurrences",
        "liabilities",
    }
)


def _require_str(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value:
        raise ValueError(f"Snapshot {field} must be a non-empty string, got {value!r}")
    return value


def _require_int(value: Any, field: str, *, allow_none: bool = False, minimum: Optional[int] = None) -> Optional[int]:
    if value is None and allow_none:
        return None
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError(f"Snapshot {field} must be an integer, got {value!r}")
    if minimum is not None and value < minimum:
        raise ValueError(f"Snapshot {field} must be >= {minimum}, got {value}")
    return value


def _require_date(value: Any, field: str, *, allow_none: bool = False) -> Optional[str]:
    if value is None and allow_none:
        return None
    if not isinstance(value, str):
        raise ValueError(f"Snapshot {field} must be an ISO date string, got {value!r}")
    try:
        date.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(f"Snapshot {field} is not a valid date: {value!r}") from exc
    return value


def _require_rows(snapshot: Dict[str, Any], key: str) -> list:
    value = snapshot.get(key, [])
    if not isinstance(value, list) or any(not isinstance(row, dict) for row in value):
        raise ValueError(f"Snapshot {key} must be a list of objects")
    return value


def _id_map(rows: list, collection: str) -> Dict[str, int]:
    """Preserve integer ids; give every other id a fresh deterministic integer.

    Web/Android snapshots may use string ids. Remapping lets Python restore such
    data without mutating the original identifier scheme or colliding with the
    integer primary keys.
    """
    explicit = [
        row["id"]
        for row in rows
        if isinstance(row.get("id"), int) and not isinstance(row.get("id"), bool)
    ]
    nxt = (max(explicit) if explicit else 0) + 1
    mapping: Dict[str, int] = {}
    for row in rows:
        if "id" not in row or row["id"] is None:
            raise ValueError(f"Snapshot {collection} row is missing its id")
        old = row["id"]
        if isinstance(old, int) and not isinstance(old, bool):
            mapping[str(old)] = old
        else:
            mapping[str(old)] = nxt
            nxt += 1
    return mapping


def _ref(mapping: Dict[str, int], value: Any, field: str) -> int:
    key = str(value)
    if key not in mapping:
        raise ValueError(f"Snapshot {field} references unknown id {value!r}")
    return mapping[key]


def _sqlite_backup(db_path: str, backup_path: str) -> None:
    """Consistent online backup using SQLite's backup API (WAL-safe)."""
    import sqlite3

    with db_manager.get_db_connection() as source:
        destination = sqlite3.connect(backup_path)
        try:
            source.backup(destination)
        finally:
            destination.close()


_SNAPSHOT_INCOME_FREQUENCIES = frozenset({"Weekly", "Bi-weekly", "Monthly", "One-time"})
_SNAPSHOT_PAYMENT_RECURRENCES = frozenset({"Monthly", "One-time", "Weekly", "Bi-weekly"})
_SNAPSHOT_TRANSACTION_TYPES = frozenset({"Income", "Expense", "Adjustment"})


def restore_ledger_snapshot(snapshot: Dict[str, Any]) -> None:
    """Atomically restore a ledger snapshot into the local database.

    The whole replacement runs in one SQLite transaction and the snapshot's internal
    consistency (declared balance == sum of its transactions) is checked *before*
    commit. A rejected or interrupted restore therefore leaves the pre-existing ledger
    exactly as it was. Every field is validated before any row is written, non-integer
    identifiers are remapped deterministically, and data the Python ledger cannot
    represent (liabilities) is rejected instead of being silently discarded.
    """
    if not isinstance(snapshot, dict):
        raise ValueError("Snapshot must be an object")

    unknown = set(snapshot) - _SNAPSHOT_FIELDS
    if unknown:
        raise ValueError(
            f"Snapshot contains unsupported fields: {sorted(unknown)}; "
            "refusing to discard data the Python ledger cannot represent"
        )

    version = snapshot.get("version")
    if version not in SUPPORTED_SNAPSHOT_VERSIONS:
        raise ValueError(
            f"Unsupported snapshot version: {version!r}; supported: {SUPPORTED_SNAPSHOT_VERSIONS}"
        )

    liabilities = _require_rows(snapshot, "liabilities")
    if liabilities:
        raise ValueError(
            f"Snapshot contains {len(liabilities)} liabilit"
            f"{'y' if len(liabilities) == 1 else 'ies'}, which the Python ledger "
            "cannot persist. Restore it with the Android or Web client instead of "
            "silently dropping debt records."
        )

    declared_balance = _require_int(
        snapshot.get("current_balance_cents", 0), "current_balance_cents"
    )

    incomes = _require_rows(snapshot, "incomes")
    payments = _require_rows(snapshot, "payments")
    transactions = _require_rows(snapshot, "transactions")
    occurrences = _require_rows(snapshot, "bill_occurrences")

    # Validate everything before opening the write transaction, so a malformed
    # snapshot never even starts replacing the ledger.
    for inc in incomes:
        _require_str(inc.get("name"), "incomes.name")
        _require_int(inc.get("amount_cents"), "incomes.amount_cents", minimum=1)
        _require_int(inc.get("expected_amount"), "incomes.expected_amount", allow_none=True, minimum=1)
        if inc.get("frequency") not in _SNAPSHOT_INCOME_FREQUENCIES:
            raise ValueError(f"Snapshot incomes.frequency is unsupported: {inc.get('frequency')!r}")
        _require_date(inc.get("last_payday"), "incomes.last_payday")
        _require_date(inc.get("next_payday"), "incomes.next_payday")

    for pmt in payments:
        _require_str(pmt.get("name"), "payments.name")
        _require_int(pmt.get("amount_cents"), "payments.amount_cents", minimum=1)
        if pmt.get("recurrence") not in _SNAPSHOT_PAYMENT_RECURRENCES:
            raise ValueError(f"Snapshot payments.recurrence is unsupported: {pmt.get('recurrence')!r}")
        due_day = _require_int(pmt.get("due_day"), "payments.due_day", allow_none=True)
        if due_day is not None and not 1 <= due_day <= 31:
            raise ValueError(f"Snapshot payments.due_day must be 1..31, got {due_day}")
        _require_date(pmt.get("due_date"), "payments.due_date", allow_none=True)

    for tx in transactions:
        _require_int(tx.get("amount_cents"), "transactions.amount_cents")
        if tx.get("type", "Expense") not in _SNAPSHOT_TRANSACTION_TYPES:
            raise ValueError(f"Snapshot transactions.type is unsupported: {tx.get('type')!r}")
        _require_date(tx.get("date"), "transactions.date")

    for occ in occurrences:
        _require_date(occ.get("due_date"), "bill_occurrences.due_date")

    declared_sum = sum(tx["amount_cents"] for tx in transactions)
    if declared_sum != declared_balance:
        raise ValueError(
            f"Snapshot is internally inconsistent: transactions sum to {declared_sum}, "
            f"declared balance is {declared_balance}"
        )

    income_ids = _id_map(incomes, "incomes")
    payment_ids = _id_map(payments, "payments")
    transaction_ids = _id_map(transactions, "transactions")
    occurrence_ids = _id_map(occurrences, "bill_occurrences")

    # A consistent snapshot is kept as a last-resort recovery aid for tooling. The
    # transaction below is what guarantees atomicity.
    db_path = db_manager.DB_PATH
    backup_path = f"{db_path}.bak"
    if os.path.exists(db_path):
        _sqlite_backup(db_path, backup_path)

    with db_manager.get_db_connection() as conn:
        with conn:  # one transaction: commit on success, roll back on any error
            conn.execute("DELETE FROM bill_occurrences")
            conn.execute("DELETE FROM transactions")
            conn.execute("DELETE FROM payments")
            conn.execute("DELETE FROM income")

            for inc in incomes:
                conn.execute(
                    "INSERT INTO income (id, name, amount, frequency, last_payday, next_payday, expected_amount) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        income_ids[str(inc["id"])],
                        inc["name"],
                        inc["amount_cents"],
                        inc["frequency"],
                        inc["last_payday"],
                        inc["next_payday"],
                        inc.get("expected_amount"),
                    ),
                )

            for pmt in payments:
                conn.execute(
                    "INSERT INTO payments (id, name, amount, due_day, recurrence, due_date, is_auto_withdraw) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (
                        payment_ids[str(pmt["id"])],
                        pmt["name"],
                        pmt["amount_cents"],
                        pmt.get("due_day"),
                        pmt["recurrence"],
                        pmt.get("due_date"),
                        1 if pmt.get("is_auto_withdraw", True) else 0,
                    ),
                )

            for tx in transactions:
                conn.execute(
                    "INSERT INTO transactions (id, amount, category, type, date, description) "
                    "VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        transaction_ids[str(tx["id"])],
                        tx["amount_cents"],
                        tx.get("category"),
                        tx.get("type", "Expense"),
                        tx["date"],
                        tx.get("description"),
                    ),
                )

            for occ in occurrences:
                conn.execute(
                    "INSERT INTO bill_occurrences (id, payment_id, due_date, paid, transaction_id) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (
                        occurrence_ids[str(occ["id"])],
                        _ref(payment_ids, occ.get("payment_id"), "bill_occurrences.payment_id"),
                        occ["due_date"],
                        1 if occ.get("paid") else 0,
                        None
                        if occ.get("transaction_id") is None
                        else _ref(transaction_ids, occ.get("transaction_id"), "bill_occurrences.transaction_id"),
                    ),
                )

            ledger_sum = conn.execute(
                "SELECT COALESCE(SUM(amount), 0) FROM transactions"
            ).fetchone()[0]
            if int(ledger_sum) != declared_balance:
                raise ValueError(
                    f"Restored ledger desynchronized inside the transaction: "
                    f"rows sum to {ledger_sum}, expected {declared_balance}"
                )
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('current_balance', ?)",
                (declared_balance,),
            )

    # Post-commit cross-check against the stored balance (defence in depth).
    is_sync, ledger, stored = db_manager.validate_balance_consistency()
    if not is_sync:
        raise ValueError(f"Restored ledger desynchronized! Stored: {stored}, Calculated: {ledger}")


def load_sync_config() -> Optional[Dict[str, Any]]:
    if os.path.exists(SYNC_CONFIG_FILE):
        with open(SYNC_CONFIG_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return None


def save_sync_config(config: Dict[str, Any]) -> None:
    with open(SYNC_CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)


def _request_json(
    url: str,
    *,
    method: str = "GET",
    payload: Optional[Dict[str, Any]] = None,
    auth_token: Optional[str] = None,
    timeout: int = 30,
) -> Tuple[int, Dict[str, Any]]:
    """Perform one vault request, returning (status, parsed body) without raising on 4xx."""
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers: Dict[str, str] = {}
    if data is not None:
        headers["Content-Type"] = "application/json"
    if auth_token:
        headers["Authorization"] = f"Bearer {auth_token}"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = getattr(resp, "status", None)
            if status is None:
                status = resp.getcode() if hasattr(resp, "getcode") else 200
            return int(status or 200), json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            body = json.loads(exc.read().decode("utf-8"))
        except Exception:
            body = {}
        return exc.code, body


def _vault_urls(server_url: str, vault_id: str) -> Tuple[str, str]:
    base = server_url.rstrip("/")
    quoted = urllib.parse.quote(vault_id, safe="")
    return f"{base}/api/vault/{quoted}", f"{base}/api/vault/{quoted}/metadata"


def _join_existing_vault(
    vault_id: str, passphrase: str, server_url: str
) -> Dict[str, Any]:
    """Attach to an existing vault (e.g. one created by the Web UI).

    The KDF salt is public metadata; deriving with it produces the same auth token
    the creating client registered. The passphrase is verified with an authenticated
    read before the local config is saved.
    """
    record_url, metadata_url = _vault_urls(server_url, vault_id)
    status, meta = _request_json(metadata_url)
    if status != 200 or not isinstance(meta.get("kdf_salt_b64"), str):
        raise ValueError(
            f"Could not read metadata for existing vault {vault_id!r} (HTTP {status})."
        )
    try:
        salt = base64.b64decode(meta["kdf_salt_b64"], validate=True)
    except Exception as exc:
        raise ValueError("Existing vault has invalid KDF metadata.") from exc
    auth_token, _ = derive_keys(passphrase, salt)
    read_status, _ = _request_json(record_url, auth_token=auth_token)
    if read_status == 401:
        raise ValueError(
            f"A vault with id {vault_id!r} already exists but the passphrase is wrong."
        )
    if read_status != 200:
        raise ValueError(f"Could not authenticate to existing vault (HTTP {read_status}).")
    cfg = {
        "vault_id": vault_id,
        "salt_b64": meta["kdf_salt_b64"],
        "server_url": server_url,
        "revision": int(meta.get("revision", 1)),
    }
    save_sync_config(cfg)
    return cfg


def sync_init(vault_id: str, passphrase: Optional[str] = None, server_url: str = DEFAULT_SERVER_URL) -> Dict[str, Any]:
    """Create a vault. The passphrase is resolved per credential policy and never stored."""
    passphrase = resolve_passphrase(
        supplied=passphrase,
        confirm=passphrase is None,
        prompt="Choose a vault passphrase: ",
    )
    salt = os.urandom(16)
    salt_b64 = base64.b64encode(salt).decode("ascii")
    auth_token, enc_key = derive_keys(passphrase, salt)

    snapshot = export_ledger_snapshot()
    ct_b64, nonce_b64 = encrypt_payload(snapshot, enc_key)

    payload = {
        "vault_id": vault_id,
        "auth_token": auth_token,
        "ciphertext_b64": ct_b64,
        "nonce_b64": nonce_b64,
        "kdf_salt_b64": salt_b64,
    }

    url = f"{server_url.rstrip('/')}/api/vault"
    status, res = _request_json(url, method="POST", payload=payload)
    if status == 409:
        # The vault already exists (possibly created by the Web UI). Attach to it
        # with its stored salt instead of overwriting it or failing opaquely.
        return _join_existing_vault(vault_id, passphrase, server_url)
    if status not in (200, 201):
        raise ValueError(f"Vault creation failed (HTTP {status}): {res.get('error', 'unknown')}")

    # Deliberately no "passphrase" here: credentials live in the user's head or
    # environment, not on disk. sync_push/sync_pull re-resolve it every run.
    cfg = {
        "vault_id": vault_id,
        "salt_b64": salt_b64,
        "server_url": server_url,
        "revision": res.get("revision", 1),
    }
    save_sync_config(cfg)
    return cfg


def _passphrase_for_operation(supplied: Optional[str], cfg: Dict[str, Any]) -> str:
    """Resolve the passphrase for push/pull, honouring legacy plaintext configs with a warning."""
    stored = cfg.get("passphrase")
    if stored and not supplied:
        _warn_stored_passphrase()
        return stored
    return resolve_passphrase(supplied=supplied)


def sync_push(server_url: Optional[str] = None, passphrase: Optional[str] = None) -> Dict[str, Any]:
    cfg = load_sync_config()
    if not cfg:
        raise ValueError("Sync not initialized. Run `monte-carlo-ledger sync init` first.")

    passphrase = _passphrase_for_operation(passphrase, cfg)
    salt = base64.b64decode(cfg["salt_b64"])
    auth_token, enc_key = derive_keys(passphrase, salt)

    snapshot = export_ledger_snapshot()
    ct_b64, nonce_b64 = encrypt_payload(snapshot, enc_key)

    url_base = (server_url or cfg.get("server_url", DEFAULT_SERVER_URL)).rstrip("/")
    url = f"{url_base}/api/vault/{cfg['vault_id']}"

    payload = {
        "expected_revision": cfg.get("revision", 1),
        "ciphertext_b64": ct_b64,
        "nonce_b64": nonce_b64,
        "kdf_salt_b64": cfg["salt_b64"],
    }

    status, res = _request_json(url, method="PUT", payload=payload, auth_token=auth_token)
    if status == 401:
        raise ValueError("Authentication failed: wrong vault passphrase.")
    if status == 409:
        raise ValueError(
            "Sync conflict: this vault was modified by another client "
            f"(current revision {res.get('current_revision')}). "
            "Run `monte-carlo-ledger sync pull` before pushing again; "
            "your local ledger has not been overwritten."
        )
    if status not in (200, 201):
        raise ValueError(f"Vault push failed (HTTP {status}): {res.get('error', 'unknown')}")

    cfg["revision"] = res.get("revision", cfg.get("revision", 1) + 1)
    save_sync_config(cfg)
    return res


def sync_pull(server_url: Optional[str] = None, passphrase: Optional[str] = None) -> Dict[str, Any]:
    cfg = load_sync_config()
    if not cfg:
        raise ValueError("Sync not initialized. Run `monte-carlo-ledger sync init` first.")

    passphrase = _passphrase_for_operation(passphrase, cfg)
    salt = base64.b64decode(cfg["salt_b64"])
    auth_token, enc_key = derive_keys(passphrase, salt)

    url_base = (server_url or cfg.get("server_url", DEFAULT_SERVER_URL)).rstrip("/")
    url = f"{url_base}/api/vault/{cfg['vault_id']}"

    status, res = _request_json(url, auth_token=auth_token)
    if status == 401:
        raise ValueError("Authentication failed: wrong vault passphrase.")
    if status != 200:
        raise ValueError(f"Vault pull failed (HTTP {status}): {res.get('error', 'unknown')}")

    snapshot = decrypt_payload(res["ciphertext_b64"], res["nonce_b64"], enc_key)
    restore_ledger_snapshot(snapshot)

    cfg["revision"] = res.get("revision", cfg.get("revision", 1))
    save_sync_config(cfg)
    return {
        "status": "restored",
        "revision": cfg["revision"],
        "balance_cents": snapshot.get("current_balance_cents"),
        "transactions_count": len(snapshot.get("transactions", [])),
    }


def sync_lock() -> Dict[str, Any]:
    """Remove any plaintext passphrase from the local sync config.

    Legacy configs stored the passphrase on disk; this removes it without touching the
    server-side vault (the passphrase itself remains the user's encryption key). Push/pull
    will prompt or read MC_LEDGER_SYNC_PASSPHRASE afterwards.
    """
    cfg = load_sync_config()
    if not cfg:
        raise ValueError("Sync not initialized. Run `monte-carlo-ledger sync init` first.")
    had_passphrase = "passphrase" in cfg
    if had_passphrase:
        del cfg["passphrase"]
        save_sync_config(cfg)
    return {"locked": True, "removed_stored_passphrase": had_passphrase, "vault_id": cfg.get("vault_id")}
