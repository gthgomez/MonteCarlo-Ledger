"""End-to-End Encrypted Cloud Vault Sync for MonteCarlo-Ledger.

Provides zero-knowledge backup and bidirectional sync between local SQLite (`ledger.db`)
and the Turso-backed edge vault API. Plaintext financial records never leave the local machine.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import shutil
import urllib.error
import urllib.request
from datetime import datetime
from typing import Any, Dict, Optional, Tuple

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from . import db_manager

SYNC_CONFIG_FILE = ".ledger-sync.json"
DEFAULT_SERVER_URL = "https://montecarlo-ledger.vercel.app"


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
        "updated_at": datetime.utcnow().isoformat() + "Z",
        "current_balance_cents": ledger_balance,
        "incomes": incomes,
        "payments": payments,
        "transactions": transactions,
        "bill_occurrences": occurrences,
        "liabilities": [],
    }


def restore_ledger_snapshot(snapshot: Dict[str, Any]) -> None:
    """Atomically restore a ledger snapshot into local ledger.db with backup."""
    db_path = db_manager.DB_PATH
    backup_path = f"{db_path}.bak"
    if os.path.exists(db_path):
        shutil.copy2(db_path, backup_path)

    try:
        with db_manager.get_db_connection() as conn:
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

            # Update cached balance
            conn.execute(
                "INSERT OR REPLACE INTO settings (key, value) VALUES ('current_balance', ?)",
                (snapshot.get("current_balance_cents", 0),),
            )
            conn.commit()

        # Validate restored balance consistency
        is_sync, ledger, stored = db_manager.validate_balance_consistency()
        if not is_sync:
            raise ValueError(f"Restored ledger desynchronized! Stored: {stored}, Calculated: {ledger}")

    except Exception:
        if os.path.exists(backup_path):
            shutil.copy2(backup_path, db_path)
        raise


def load_sync_config() -> Optional[Dict[str, Any]]:
    if os.path.exists(SYNC_CONFIG_FILE):
        with open(SYNC_CONFIG_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return None


def save_sync_config(config: Dict[str, Any]) -> None:
    with open(SYNC_CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(config, f, indent=2)


def sync_init(vault_id: str, passphrase: str, server_url: str = DEFAULT_SERVER_URL) -> Dict[str, Any]:
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

    cfg = {
        "vault_id": vault_id,
        "passphrase": passphrase,
        "salt_b64": salt_b64,
        "server_url": server_url,
        "revision": res.get("revision", 1),
    }
    save_sync_config(cfg)
    return cfg


def sync_push(server_url: Optional[str] = None) -> Dict[str, Any]:
    cfg = load_sync_config()
    if not cfg:
        raise ValueError("Sync not initialized. Run `monte-carlo-ledger sync init` first.")

    salt = base64.b64decode(cfg["salt_b64"])
    auth_token, enc_key = derive_keys(cfg["passphrase"], salt)

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


def sync_pull(server_url: Optional[str] = None) -> Dict[str, Any]:
    cfg = load_sync_config()
    if not cfg:
        raise ValueError("Sync not initialized. Run `monte-carlo-ledger sync init` first.")

    salt = base64.b64decode(cfg["salt_b64"])
    auth_token, enc_key = derive_keys(cfg["passphrase"], salt)

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
