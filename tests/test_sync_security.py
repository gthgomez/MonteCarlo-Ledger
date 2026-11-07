"""Security and continuity tests for vault-sync credential handling and the local API boundary.

Threat model under test:
- The vault passphrase must never appear in argv (shell history / process listings) or on
  disk (plaintext config).
- Legacy configs that still carry a plaintext passphrase must keep working while warning,
  and `sync lock` must remove the credential from disk.
- A wrong passphrase must never corrupt the local ledger (restore is not even attempted).
- The unauthenticated local API must refuse non-loopback clients at runtime.
"""

from __future__ import annotations

import base64
import json
import os
from typing import Optional
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from monte_carlo_ledger import api as api_module
from monte_carlo_ledger import commands, db_manager, sync


@pytest.fixture()
def sync_config(tmp_path, monkeypatch):
    """Redirect the sync config into a temp dir so tests never touch a real vault config."""
    cfg_path = tmp_path / ".ledger-sync.json"
    monkeypatch.setattr(sync, "SYNC_CONFIG_FILE", str(cfg_path))
    return cfg_path


@pytest.fixture(autouse=True)
def clean_passphrase_env(monkeypatch):
    monkeypatch.delenv(sync.PASSPHRASE_ENV, raising=False)


def _fake_urlopen(payload, calls):
    """Build a urlopen replacement that records requests and returns canned JSON."""

    class _Resp:
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self):
            return json.dumps(payload).encode("utf-8")

    def _handler(request, *args, **kwargs):
        calls.append(request)
        return _Resp()

    return _handler


class FakeVaultServer:
    """In-memory server implementing the Web vault route semantics."""

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

    def set_from_snapshot(self, passphrase, snapshot, revision=1):
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

    def snapshot(self, passphrase):
        return sync.decrypt_payload(self.ciphertext_b64, self.nonce_b64, self.key)


def _minimal_snapshot():
    return {
        "version": "2.0",
        "updated_at": "2026-11-07T00:00:00+00:00",
        "current_balance_cents": 0,
        "incomes": [],
        "payments": [],
        "transactions": [],
        "bill_occurrences": [],
        "liabilities": [],
    }


def test_parser_rejects_positional_passphrase():
    # Regression: `sync init <vault_id> <passphrase>` used to leak the passphrase into
    # shell history. argparse must fail instead of accepting a second positional.
    with pytest.raises(SystemExit) as excinfo:
        commands.main(["sync", "init", "vault-1", "hunter2"])
    assert excinfo.value.code == 2


def test_init_with_env_passphrase_stores_no_credential(sync_config):
    calls = []
    with patch.object(sync, "export_ledger_snapshot", _minimal_snapshot):
        with patch.object(
            sync.urllib.request, "urlopen", _fake_urlopen({"revision": 1}, calls)
        ):
            with patch.dict(os.environ, {sync.PASSPHRASE_ENV: "correct horse"}):
                cfg = sync.sync_init("vault-1", None, "https://sync.example.test")

    stored = json.loads(sync_config.read_text())
    assert "passphrase" not in stored, "plaintext passphrase must never be persisted"
    assert "passphrase" not in cfg
    assert stored["vault_id"] == "vault-1"
    assert stored["salt_b64"] == cfg["salt_b64"]

    sent = json.loads(calls[0].data.decode("utf-8"))
    assert "passphrase" not in sent
    # The auth token in the POST must be derivable from the env passphrase and salt.
    auth_token, _ = sync.derive_keys("correct horse", base64.b64decode(stored["salt_b64"]))
    assert sent["auth_token"] == auth_token


def test_push_resolves_env_passphrase_when_nothing_is_stored(sync_config):
    server = FakeVaultServer()
    with patch.object(sync, "export_ledger_snapshot", _minimal_snapshot):
        with patch.object(sync, "_request_json", server.request):
            with patch.dict(os.environ, {sync.PASSPHRASE_ENV: "env-secret"}):
                sync.sync_init("vault-1", None, "https://sync.example.test")
            # patch.dict unsets the var on exit; push must resolve it from the env again.
            with patch.dict(os.environ, {sync.PASSPHRASE_ENV: "env-secret"}):
                sync.sync_push("https://sync.example.test")

    put = [call for call in server.calls if call[0] == "PUT"][-1]
    auth_token, _ = sync.derive_keys(
        "env-secret", base64.b64decode(json.loads(sync_config.read_text())["salt_b64"])
    )
    assert put[2] == auth_token


def test_wrong_passphrase_push_fails_and_never_stores_it(sync_config):
    server = FakeVaultServer()
    with patch.object(sync, "export_ledger_snapshot", _minimal_snapshot):
        with patch.object(sync, "_request_json", server.request):
            with patch.dict(os.environ, {sync.PASSPHRASE_ENV: "right"}):
                sync.sync_init("vault-1", None, "https://sync.example.test")
            with patch.dict(os.environ, {sync.PASSPHRASE_ENV: "wrong"}):
                with pytest.raises(ValueError, match="Authentication failed"):
                    sync.sync_push("https://sync.example.test")
    stored = json.loads(sync_config.read_text())
    assert "passphrase" not in stored


def test_pull_with_wrong_passphrase_never_touches_local_ledger(sync_config):
    """A payload encrypted under passphrase A must not decrypt under passphrase B."""
    calls = []
    salt = os.urandom(16)
    cfg = {
        "vault_id": "vault-1",
        "salt_b64": base64.b64encode(salt).decode("ascii"),
        "server_url": "https://sync.example.test",
        "revision": 1,
    }
    sync_config.write_text(json.dumps(cfg))

    _, enc_key_right = sync.derive_keys("right", salt)
    ct_b64, nonce_b64 = sync.encrypt_payload(_minimal_snapshot(), enc_key_right)
    server_payload = {"revision": 7, "ciphertext_b64": ct_b64, "nonce_b64": nonce_b64}

    restored = []
    with patch.dict(os.environ, {sync.PASSPHRASE_ENV: "wrong"}):
        with patch.object(
            sync.urllib.request, "urlopen", _fake_urlopen(server_payload, calls)
        ):
            with patch.object(
                sync, "restore_ledger_snapshot", lambda snap: restored.append(snap)
            ):
                with pytest.raises(Exception):
                    sync.sync_pull("https://sync.example.test")
    assert restored == [], "a failed decrypt must never restore or mutate the ledger"


def test_legacy_config_passphrase_still_works_with_warning(sync_config, capsys):
    snapshot = _minimal_snapshot()
    server = FakeVaultServer().set_from_snapshot("legacy-secret", snapshot, revision=3)
    legacy = {
        "vault_id": "vault-legacy",
        "passphrase": "legacy-secret",
        "salt_b64": base64.b64encode(server.salt).decode("ascii"),
        "server_url": "https://sync.example.test",
        "revision": 3,
        "ancestry_established": True,
        "synced_fingerprint": sync._snapshot_fingerprint(snapshot),
    }
    sync_config.write_text(json.dumps(legacy))

    with patch.object(sync, "export_ledger_snapshot", _minimal_snapshot):
        with patch.object(sync, "_request_json", server.request):
            sync.sync_push("https://sync.example.test")

    auth_token, _ = sync.derive_keys("legacy-secret", server.salt)
    puts = [call for call in server.calls if call[0] == "PUT"]
    assert puts and puts[-1][2] == auth_token
    err = capsys.readouterr().err
    assert "deprecated" in err and "sync lock" in err


def test_sync_lock_removes_stored_passphrase(sync_config):
    salt = os.urandom(16)
    sync_config.write_text(
        json.dumps(
            {
                "vault_id": "vault-legacy",
                "passphrase": "legacy-secret",
                "salt_b64": base64.b64encode(salt).decode("ascii"),
                "server_url": "https://sync.example.test",
                "revision": 3,
            }
        )
    )
    res = sync.sync_lock()
    assert res["removed_stored_passphrase"] is True
    stored = json.loads(sync_config.read_text())
    assert "passphrase" not in stored
    # Idempotent second run
    res2 = sync.sync_lock()
    assert res2["removed_stored_passphrase"] is False


def test_snapshot_updated_at_is_timezone_aware_utc():
    snap = _minimal_snapshot()
    snap["updated_at"] = sync._utc_now_iso()
    assert snap["updated_at"].endswith("+00:00")
    # Round-trips through ISO parsing as an aware datetime.
    from datetime import datetime

    parsed = datetime.fromisoformat(snap["updated_at"])
    assert parsed.tzinfo is not None


# ---------------------------------------------------------------------------
# Local API boundary


def test_loopback_middleware_rejects_remote_client():
    async def _inner_app(scope, receive, send):  # pragma: no cover - must not be reached
        raise AssertionError("remote request must not reach the app")

    middleware = api_module.LoopbackOnlyMiddleware(_inner_app)
    sent = []

    async def _receive():
        return {"type": "http.request"}

    async def _send(message):
        sent.append(message)

    import asyncio

    scope = {
        "type": "http",
        "method": "GET",
        "path": "/safe-to-spend",
        "headers": [],
        "client": ("203.0.113.7", 54321),
    }
    asyncio.run(middleware(scope, _receive, _send))
    assert sent[0]["status"] == 403
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    assert b"loopback-only" in body


def test_loopback_middleware_allows_loopback_client():
    reached = []
    sent = []

    async def _inner_app(scope, receive, send):
        reached.append(scope["client"])
        from fastapi.responses import JSONResponse

        response = JSONResponse({"ok": True}, status_code=200)
        await response(scope, receive, send)

    middleware = api_module.LoopbackOnlyMiddleware(_inner_app)

    async def _receive():
        return {"type": "http.request"}

    async def _send(message):
        sent.append(message)

    import asyncio

    cases = [
        ("127.0.0.1", b"127.0.0.1:8000"),
        ("::1", b"[::1]:8000"),
        ("testclient", b"testserver"),
    ]
    for host, host_header in cases:
        sent.clear()
        scope = {
            "type": "http",
            "method": "GET",
            "path": "/",
            "headers": [(b"host", host_header)],
            "client": (host, 12345),
        }
        asyncio.run(middleware(scope, _receive, _send))
        assert sent and sent[0]["status"] == 200, host
    assert len(reached) == 3


def test_loopback_middleware_rejects_dns_rebinding_host_header():
    """A loopback peer with a foreign Host header is a DNS-rebinding attempt."""
    async def _inner_app(scope, receive, send):  # pragma: no cover - must not be reached
        raise AssertionError("rebound request must not reach the app")

    middleware = api_module.LoopbackOnlyMiddleware(_inner_app)
    sent = []

    async def _receive():
        return {"type": "http.request"}

    async def _send(message):
        sent.append(message)

    import asyncio

    scope = {
        "type": "http",
        "method": "GET",
        "path": "/safe-to-spend",
        "headers": [(b"host", b"attacker.example")],
        "client": ("127.0.0.1", 54321),
    }
    asyncio.run(middleware(scope, _receive, _send))
    assert sent[0]["status"] == 403


def test_remote_origin_is_not_granted_cors_access():
    client = TestClient(api_module.app)
    response = client.options(
        "/v1/forecast",
        headers={
            "Origin": "https://attacker.example",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert "access-control-allow-origin" not in {
        key.lower() for key in response.headers.keys()
    }


def test_api_still_serves_loopback_requests(tmp_path, monkeypatch):
    """The guard must not break the normal local workflow (TestClient acts as loopback)."""
    from monte_carlo_ledger import db_manager

    test_db = tmp_path / "test_ledger_security.db"
    monkeypatch.setattr(db_manager, "DB_PATH", str(test_db))
    db_manager.init_db()
    db_manager.add_transaction(
        amount_cents=50000, category="System", description="Starting Balance", t_type="Adjustment"
    )
    with db_manager.get_db_connection() as conn:
        conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES ('onboarded', 1)")

    client = TestClient(api_module.app)
    resp = client.get("/safe-to-spend", params={"days_ahead": 7})
    assert resp.status_code == 200, resp.text
    payload = resp.json()
    assert "safe_spend_cents" in payload


# ---------------------------------------------------------------------------
# Restore integrity: a rejected or interrupted restore must never destroy or
# partially replace the pre-existing ledger.


@pytest.fixture()
def ledger_db(tmp_path, monkeypatch):
    db_path = tmp_path / "ledger.db"
    monkeypatch.setattr(db_manager, "DB_PATH", str(db_path))
    db_manager.init_db()
    db_manager.add_transaction(
        500_000, "System", "Opening", t_type="Adjustment", date_str="2026-10-01"
    )
    return db_path


def _without_timestamp(snapshot):
    doc = json.loads(json.dumps(snapshot))
    doc.pop("updated_at", None)
    return doc


def test_restore_rejects_unsupported_snapshot_version(ledger_db):
    before = sync.export_ledger_snapshot()
    bad = _without_timestamp(before)
    bad["version"] = "9.9"
    with pytest.raises(ValueError, match="Unsupported snapshot version"):
        sync.restore_ledger_snapshot(bad)
    assert _without_timestamp(sync.export_ledger_snapshot()) == _without_timestamp(before)


def test_restore_rejects_inconsistent_snapshot_and_preserves_ledger(ledger_db):
    before = sync.export_ledger_snapshot()
    bad = _without_timestamp(before)
    bad["transactions"] = [
        {"id": 1, "amount_cents": -100, "type": "Expense", "date": "2026-10-01", "description": "x"}
    ]
    bad["current_balance_cents"] = 999
    with pytest.raises(ValueError, match="internally inconsistent"):
        sync.restore_ledger_snapshot(bad)
    assert _without_timestamp(sync.export_ledger_snapshot()) == _without_timestamp(before)


def test_restore_rolls_back_on_midway_failure(ledger_db):
    before = sync.export_ledger_snapshot()
    bad = _without_timestamp(before)
    duplicate = before["transactions"][0]
    bad["transactions"] = [duplicate, dict(duplicate)]
    bad["current_balance_cents"] = sum(t["amount_cents"] for t in bad["transactions"])
    with pytest.raises(Exception):
        sync.restore_ledger_snapshot(bad)
    assert _without_timestamp(sync.export_ledger_snapshot()) == _without_timestamp(before)


def test_restore_round_trip_is_exact_and_idempotent(ledger_db):
    db_manager.add_income_source("Paycheck", 220_000, "Bi-weekly", "2026-10-30")
    db_manager.add_payment("Rent", 135_000, "Monthly", 1)
    snapshot = sync.export_ledger_snapshot()

    sync.restore_ledger_snapshot(snapshot)
    first = _without_timestamp(sync.export_ledger_snapshot())
    sync.restore_ledger_snapshot(snapshot)
    second = _without_timestamp(sync.export_ledger_snapshot())

    assert first == second
    assert first == _without_timestamp(snapshot)


# --- vault protocol interoperability (mocked transport) ---------------------


def test_sync_init_joins_existing_vault_using_public_metadata(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    db_manager.DB_PATH = str(tmp_path / "ledger.db")
    db_manager.init_db()
    server = FakeVaultServer().set_from_snapshot("passphrase", _minimal_snapshot(), revision=7)
    server.create_conflict = True
    monkeypatch.setattr(sync, "_request_json", server.request)

    cfg = sync.sync_init("shared-vault", "passphrase", "http://vault.test")

    assert cfg["vault_id"] == "shared-vault"
    assert cfg["salt_b64"] == base64.b64encode(server.salt).decode("ascii")
    assert cfg["revision"] == 7
    # Joining proves the passphrase but does NOT establish push ancestry.
    assert cfg["ancestry_established"] is False
    assert any(token for (_, _, token, _) in server.calls)


def test_sync_init_join_with_wrong_passphrase_is_explicit(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    db_manager.DB_PATH = str(tmp_path / "ledger.db")
    db_manager.init_db()
    server = FakeVaultServer().set_from_snapshot("right", _minimal_snapshot(), revision=3)
    server.create_conflict = True
    monkeypatch.setattr(sync, "_request_json", server.request)
    with pytest.raises(ValueError, match="passphrase is wrong"):
        sync.sync_init("shared-vault", "wrong", "http://vault.test")


def test_sync_push_conflict_is_explicit_and_preserves_local_ledger(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    db_manager.DB_PATH = str(tmp_path / "ledger.db")
    db_manager.init_db()
    db_manager.add_transaction(500_000, "System", "Opening", t_type="Adjustment", date_str="2026-10-01")
    snapshot = sync.export_ledger_snapshot()
    server = FakeVaultServer().set_from_snapshot("passphrase", snapshot, revision=1)
    # Another client advanced the remote vault after this device's last sync.
    server.revision = 2
    monkeypatch.setattr(sync, "_request_json", server.request)
    sync.save_sync_config({
        "vault_id": "v",
        "salt_b64": base64.b64encode(server.salt).decode("ascii"),
        "server_url": "http://vault.test",
        "revision": 1,
        "ancestry_established": True,
        "synced_fingerprint": sync._snapshot_fingerprint(snapshot),
    })

    with pytest.raises(ValueError, match="Sync conflict"):
        sync.sync_push(passphrase="passphrase")

    # No PUT was attempted and the local ledger/revision are untouched.
    assert not [call for call in server.calls if call[0] == "PUT"]
    assert db_manager.get_ledger_balance() == 500_000
    assert sync.load_sync_config()["revision"] == 1


def test_sync_pull_wrong_passphrase_does_not_touch_the_ledger(monkeypatch, tmp_path):
    monkeypatch.chdir(tmp_path)
    db_manager.DB_PATH = str(tmp_path / "ledger.db")
    db_manager.init_db()
    db_manager.add_transaction(123_456, "System", "Opening", t_type="Adjustment", date_str="2026-10-01")
    local = sync.export_ledger_snapshot()
    server = FakeVaultServer().set_from_snapshot("right", local, revision=4)
    sync.save_sync_config({
        "vault_id": "v",
        "salt_b64": base64.b64encode(server.salt).decode("ascii"),
        "server_url": "http://vault.test",
        "revision": 4,
        "ancestry_established": True,
        "synced_fingerprint": sync._snapshot_fingerprint(local),
    })

    monkeypatch.setattr(
        sync,
        "_request_json",
        lambda url, **kwargs: (401, {"error": "UNAUTHORIZED"}),
    )
    with pytest.raises(ValueError, match="Authentication failed"):
        sync.sync_pull(passphrase="wrong")
    assert db_manager.get_ledger_balance() == 123_456
