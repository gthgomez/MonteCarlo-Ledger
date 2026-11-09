"""Cross-client compatibility and non-destructive pull.

Historical defect: a Python client could join a Web vault containing liabilities, then
push a snapshot that silently dropped debt. Compatibility is now enforced by validating
remote snapshots and persisting liabilities in the local SQLite schema.
"""

from __future__ import annotations

import base64
import json
import os
from typing import Any, Dict, Optional

import pytest

from monte_carlo_ledger import db_manager, sync


class FakeVaultServer:
    """Protocol-accurate in-memory vault (salt discovery, auth, CAS)."""

    def __init__(self):
        self.exists = False
        self.create_conflict = False
        self.salt: Optional[bytes] = None
        self.auth: Optional[str] = None
        self.key: Optional[bytes] = None
        self.revision = 1
        self.ciphertext_b64: Optional[str] = None
        self.nonce_b64: Optional[str] = None
        self.calls = []

    def set_from_snapshot(self, passphrase: str, snapshot: Dict[str, Any], revision: int = 1):
        self.salt = os.urandom(16)
        self.auth, self.key = sync.derive_keys(passphrase, self.salt)
        self.ciphertext_b64, self.nonce_b64 = sync.encrypt_payload(snapshot, self.key)
        self.revision = revision
        self.exists = True
        return self

    def request(self, url, *, method="GET", payload=None, auth_token=None, timeout=30):
        self.calls.append((method, url, auth_token, payload))
        if url.endswith("/metadata"):
            if not self.exists:
                return 404, {"error": "VAULT_NOT_FOUND"}
            return 200, {
                "kdf_salt_b64": base64.b64encode(self.salt).decode("ascii"),
                "revision": self.revision,
            }
        if method == "POST":
            if self.create_conflict:
                return 409, {"error": "VAULT_ALREADY_EXISTS"}
            self.exists = True
            self.create_conflict = True
            self.salt = base64.b64decode(payload["kdf_salt_b64"])
            self.auth = payload["auth_token"]
            self.revision = 1
            self.ciphertext_b64 = payload["ciphertext_b64"]
            self.nonce_b64 = payload["nonce_b64"]
            return 201, {"revision": 1}
        if not self.exists:
            return 404, {"error": "VAULT_NOT_FOUND"}
        if auth_token != self.auth:
            return 401, {"error": "UNAUTHORIZED"}
        if method == "GET":
            return 200, {
                "revision": self.revision,
                "ciphertext_b64": self.ciphertext_b64,
                "nonce_b64": self.nonce_b64,
            }
        if method == "PUT":
            if payload["expected_revision"] != self.revision:
                return 409, {"error": "REVISION_CONFLICT", "current_revision": self.revision}
            self.revision += 1
            self.ciphertext_b64 = payload["ciphertext_b64"]
            self.nonce_b64 = payload["nonce_b64"]
            return 200, {"revision": self.revision}
        return 404, {"error": "NOT_FOUND"}

    def snapshot(self) -> Dict[str, Any]:
        return sync.decrypt_payload(self.ciphertext_b64, self.nonce_b64, self.key)


def _empty_snapshot() -> Dict[str, Any]:
    return {
        "version": "2.1",
        "updated_at": "2026-11-07T00:00:00+00:00",
        "current_balance_cents": 0,
        "incomes": [],
        "payments": [],
        "transactions": [],
        "bill_occurrences": [],
        "liabilities": [],
    }


def _debt_snapshot() -> Dict[str, Any]:
    snapshot = _empty_snapshot()
    snapshot["liabilities"] = [
        {
            "id": "card-1",
            "name": "Credit Card",
            "balance_cents": 240_000,
            "apr_basis_points": 2199,
            "min_payment_cents": 6500,
        }
    ]
    return snapshot


@pytest.fixture()
def populated_db(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    db_path = tmp_path / "ledger.db"
    monkeypatch.setattr(db_manager, "DB_PATH", str(db_path))
    db_manager.init_db()
    db_manager.add_transaction(
        500_000, "System", "Opening", t_type="Adjustment", date_str="2026-10-01"
    )
    db_manager.add_income_source("Pay", 220_000, "Monthly", "2026-01-31")
    return db_path


def _local_state():
    with db_manager.get_db_connection() as conn:
        return {
            "balance": db_manager.get_ledger_balance(),
            "transactions": [dict(r) for r in conn.execute("SELECT * FROM transactions ORDER BY id")],
            "income": [dict(r) for r in conn.execute("SELECT * FROM income ORDER BY id")],
            "payments": [dict(r) for r in conn.execute("SELECT * FROM payments ORDER BY id")],
            "occurrences": [
                dict(r) for r in conn.execute("SELECT * FROM bill_occurrences ORDER BY id")
            ],
        }


def _cfg(server, passphrase, revision, *, ancestry=True, fingerprint=None):
    cfg = {
        "vault_id": "shared-vault",
        "salt_b64": base64.b64encode(server.salt).decode("ascii"),
        "server_url": "http://vault.test",
        "revision": revision,
        "ancestry_established": ancestry,
    }
    if fingerprint is not None:
        cfg["synced_fingerprint"] = fingerprint
    sync.save_sync_config(cfg)
    return cfg


def test_join_restores_web_vault_with_liabilities_after_explicit_pull(
    populated_db, monkeypatch, tmp_path
):
    server = FakeVaultServer().set_from_snapshot("passphrase", _debt_snapshot(), revision=5)
    server.create_conflict = True
    monkeypatch.setattr(sync, "_request_json", server.request)
    before = _local_state()

    cfg = sync.sync_init("shared-vault", "passphrase", "http://vault.test")
    assert cfg is not None
    sync.sync_pull(passphrase="passphrase", allow_local_overwrite=True)
    exported = sync.export_ledger_snapshot()
    assert exported["liabilities"] == _debt_snapshot()["liabilities"]
    assert _local_state() != before
    assert server.snapshot()["liabilities"], "remote debt must remain intact"
    assert server.revision == 5


def test_joined_vault_cannot_be_pushed_until_a_pull_establishes_ancestry(
    populated_db, monkeypatch
):
    server = FakeVaultServer().set_from_snapshot("passphrase", _empty_snapshot(), revision=7)
    server.create_conflict = True
    monkeypatch.setattr(sync, "_request_json", server.request)

    cfg = sync.sync_init("shared-vault", "passphrase", "http://vault.test")
    assert cfg["ancestry_established"] is False

    with pytest.raises(ValueError, match="ancestry"):
        sync.sync_push(passphrase="passphrase")
    assert server.revision == 7
    assert not [c for c in server.calls if c[0] == "PUT"]

    # An explicit pull (confirming the local replacement) establishes the base.
    sync.sync_pull(passphrase="passphrase", allow_local_overwrite=True)
    assert sync.load_sync_config()["ancestry_established"] is True
    assert sync.load_sync_config()["revision"] == 7

    result = sync.sync_push(passphrase="passphrase")
    assert result["revision"] == 8
    assert server.revision == 8


def test_push_round_trips_liabilities_after_pull_establishes_ancestry(
    populated_db, monkeypatch
):
    server = FakeVaultServer().set_from_snapshot("passphrase", _debt_snapshot(), revision=3)
    server.create_conflict = True
    monkeypatch.setattr(sync, "_request_json", server.request)
    sync.sync_init("shared-vault", "passphrase", "http://vault.test")
    sync.sync_pull(passphrase="passphrase", allow_local_overwrite=True)
    remote_before = server.snapshot()

    result = sync.sync_push(passphrase="passphrase")
    assert result["revision"] == 4
    assert server.snapshot()["liabilities"] == remote_before["liabilities"]
    assert [c for c in server.calls if c[0] == "PUT"]


def test_push_preflight_refuses_unknown_future_fields(populated_db, monkeypatch):
    snapshot = _empty_snapshot()
    snapshot["future_debt_records"] = [{"id": "x"}]
    server = FakeVaultServer().set_from_snapshot("passphrase", snapshot, revision=2)
    monkeypatch.setattr(sync, "_request_json", server.request)
    _cfg(server, "passphrase", 2, ancestry=True, fingerprint="whatever")

    with pytest.raises(ValueError, match="cannot represent"):
        sync.sync_push(passphrase="passphrase")
    assert server.revision == 2


def test_pull_refuses_to_discard_unsynchronized_local_changes(
    populated_db, monkeypatch
):
    local_before = sync.export_ledger_snapshot()
    server = FakeVaultServer().set_from_snapshot("passphrase", _empty_snapshot(), revision=4)
    monkeypatch.setattr(sync, "_request_json", server.request)
    _cfg(
        server,
        "passphrase",
        4,
        ancestry=True,
        fingerprint=sync._snapshot_fingerprint(local_before),
    )

    # Local edit after the last sync.
    db_manager.add_transaction(
        -25_000, "Food", "Groceries", t_type="Expense", date_str="2026-10-05"
    )
    edited = _local_state()

    with pytest.raises(ValueError, match="never synchronized"):
        sync.sync_pull(passphrase="passphrase")

    backup = f"{db_manager.DB_PATH}.pre-pull-backup"
    assert os.path.exists(backup), "a recovery copy must exist before a destructive pull"
    assert _local_state() == edited
    assert sync.load_sync_config()["revision"] == 4

    # Explicit recovery: the user accepted the replacement.
    result = sync.sync_pull(passphrase="passphrase", allow_local_overwrite=True)
    assert result["balance_cents"] == 0
    assert db_manager.get_ledger_balance() == 0
    assert sync.load_sync_config()["revision"] == 4
    assert sync.load_sync_config()["ancestry_established"] is True


def test_pull_with_invalid_payload_leaves_ledger_and_config_untouched(
    populated_db, monkeypatch
):
    local = sync.export_ledger_snapshot()
    server = FakeVaultServer().set_from_snapshot(
        "passphrase", {"version": "2.1"}, revision=6
    )
    monkeypatch.setattr(sync, "_request_json", server.request)
    _cfg(
        server,
        "passphrase",
        6,
        ancestry=True,
        fingerprint=sync._snapshot_fingerprint(local),
    )
    before = _local_state()

    with pytest.raises(ValueError, match="missing required field"):
        sync.sync_pull(passphrase="passphrase")

    assert _local_state() == before
    assert sync.load_sync_config()["revision"] == 6
    assert server.revision == 6


def test_old_compatible_snapshot_still_pulls(populated_db, monkeypatch):
    old = _empty_snapshot()
    old["version"] = "2.0"
    server = FakeVaultServer().set_from_snapshot("passphrase", old, revision=2)
    monkeypatch.setattr(sync, "_request_json", server.request)
    _cfg(server, "passphrase", 2, ancestry=True, fingerprint="unknown")

    # ancestry is established but the fingerprint is stale -> explicit confirmation.
    result = sync.sync_pull(passphrase="passphrase", allow_local_overwrite=True)
    assert result["transactions_count"] == 0
    restored = sync.export_ledger_snapshot()
    assert restored["version"] == "2.1"
    assert restored["current_balance_cents"] == 0


def test_pull_fingerprint_describes_the_remapped_local_ledger(populated_db, monkeypatch):
    """Web string ids become Python integers; ancestry must match what is stored."""
    remote = _empty_snapshot()
    remote["current_balance_cents"] = 100_000
    remote["transactions"] = [
        {
            "id": "tx-web-1",
            "amount_cents": 100_000,
            "category": "System",
            "type": "Adjustment",
            "date": "2026-10-01",
            "description": "Opening",
        }
    ]
    server = FakeVaultServer().set_from_snapshot("passphrase", remote, revision=4)
    monkeypatch.setattr(sync, "_request_json", server.request)
    _cfg(server, "passphrase", 4, ancestry=True, fingerprint="stale")

    sync.sync_pull(passphrase="passphrase", allow_local_overwrite=True)
    cfg = sync.load_sync_config()
    local_fingerprint = sync._local_ledger_fingerprint()
    assert cfg["synced_fingerprint"] == local_fingerprint
    assert cfg["synced_fingerprint"] != sync._snapshot_fingerprint(remote)

    # An immediate second pull without edits is a no-op, not a false conflict.
    sync.sync_pull(passphrase="passphrase")

    # A real local edit is still detected.
    db_manager.add_transaction(-500, "Coffee", "local", t_type="Expense", date_str="2026-10-02")
    with pytest.raises(ValueError, match="never synchronized"):
        sync.sync_pull(passphrase="passphrase")

    # A compatible push after the pull uses the recorded base.
    result = sync.sync_push(passphrase="passphrase")
    assert result["revision"] == 5
    assert server.revision == 5
