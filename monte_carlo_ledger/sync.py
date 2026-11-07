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
import shutil
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
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
        "version": "2.0",
        "updated_at": _utc_now_iso(),
        "current_balance_cents": ledger_balance,
        "incomes": incomes,
        "payments": payments,
        "transactions": transactions,
        "bill_occurrences": occurrences,
        "liabilities": [],
    }


SUPPORTED_SNAPSHOT_VERSIONS = ("2.0",)


def restore_ledger_snapshot(snapshot: Dict[str, Any]) -> None:
    """Atomically restore a ledger snapshot into the local database.

    The whole replacement runs in one SQLite transaction and the snapshot's internal
    consistency (declared balance == sum of its transactions) is checked *before*
    commit. A rejected or interrupted restore therefore leaves the pre-existing ledger
    exactly as it was — there is no window in which a partially restored ledger is
    committed and then "repaired" from a file copy.
    """
    if not isinstance(snapshot, dict):
        raise ValueError("Snapshot must be an object")
    version = snapshot.get("version")
    if version not in SUPPORTED_SNAPSHOT_VERSIONS:
        raise ValueError(
            f"Unsupported snapshot version: {version!r}; supported: {SUPPORTED_SNAPSHOT_VERSIONS}"
        )

    declared_balance = snapshot.get("current_balance_cents", 0)
    if not isinstance(declared_balance, int) or isinstance(declared_balance, bool):
        raise ValueError(f"Snapshot current_balance_cents must be an integer, got {declared_balance!r}")
    declared_sum = sum(
        int(tx.get("amount_cents", 0)) for tx in snapshot.get("transactions", [])
    )
    if declared_sum != declared_balance:
        raise ValueError(
            f"Snapshot is internally inconsistent: transactions sum to {declared_sum}, "
            f"declared balance is {declared_balance}"
        )

    # A file backup is kept as a last-resort recovery aid for tooling. The transaction
    # below is what guarantees atomicity.
    db_path = db_manager.DB_PATH
    backup_path = f"{db_path}.bak"
    if os.path.exists(db_path):
        shutil.copy2(db_path, backup_path)

    with db_manager.get_db_connection() as conn:
        with conn:  # one transaction: commit on success, roll back on any error
            conn.execute("DELETE FROM bill_occurrences")
            conn.execute("DELETE FROM transactions")
            conn.execute("DELETE FROM payments")
            conn.execute("DELETE FROM income")

            for inc in snapshot.get("incomes", []):
                conn.execute(
                    "INSERT INTO income (id, name, amount, frequency, last_payday, next_payday) VALUES (?, ?, ?, ?, ?, ?)",
                    (inc.get("id"), inc["name"], inc["amount_cents"], inc["frequency"], inc["last_payday"], inc["next_payday"]),
                )

            for pmt in snapshot.get("payments", []):
                conn.execute(
                    "INSERT INTO payments (id, name, amount, due_day, recurrence, due_date, is_auto_withdraw) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (pmt.get("id"), pmt["name"], pmt["amount_cents"], pmt.get("due_day"), pmt["recurrence"], pmt.get("due_date"), 1 if pmt.get("is_auto_withdraw", True) else 0),
                )

            for tx in snapshot.get("transactions", []):
                conn.execute(
                    "INSERT INTO transactions (id, amount, category, type, date, description) VALUES (?, ?, ?, ?, ?, ?)",
                    (tx.get("id"), tx["amount_cents"], tx.get("category"), tx.get("type", "Expense"), tx["date"], tx.get("description")),
                )

            for occ in snapshot.get("bill_occurrences", []):
                conn.execute(
                    "INSERT INTO bill_occurrences (id, payment_id, due_date, paid, transaction_id) VALUES (?, ?, ?, ?, ?)",
                    (occ.get("id"), occ["payment_id"], occ["due_date"], 1 if occ.get("paid") else 0, occ.get("transaction_id")),
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
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    with urllib.request.urlopen(req) as resp:
        res = json.loads(resp.read().decode("utf-8"))

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

    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {auth_token}",
        },
        method="PUT",
    )

    with urllib.request.urlopen(req) as resp:
        res = json.loads(resp.read().decode("utf-8"))

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

    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {auth_token}"},
        method="GET",
    )

    with urllib.request.urlopen(req) as resp:
        res = json.loads(resp.read().decode("utf-8"))

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
