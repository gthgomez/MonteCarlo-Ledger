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
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from monte_carlo_ledger import api as api_module
from monte_carlo_ledger import commands, sync


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
    calls = []
    with patch.object(sync, "export_ledger_snapshot", _minimal_snapshot):
        with patch.object(
            sync.urllib.request, "urlopen", _fake_urlopen({"revision": 1}, calls)
        ):
            with patch.dict(os.environ, {sync.PASSPHRASE_ENV: "env-secret"}):
                sync.sync_init("vault-1", None, "https://sync.example.test")
            # patch.dict unsets the var on exit; push must resolve it from the env again.
            with patch.dict(os.environ, {sync.PASSPHRASE_ENV: "env-secret"}):
                with patch.object(
                    sync.urllib.request, "urlopen", _fake_urlopen({"revision": 2}, calls)
                ):
                    sync.sync_push("https://sync.example.test")

    put = calls[-1]
    auth_token, _ = sync.derive_keys(
        "env-secret", base64.b64decode(json.loads(sync_config.read_text())["salt_b64"])
    )
    assert put.get_header("Authorization") == f"Bearer {auth_token}"


def test_wrong_passphrase_push_fails_and_never_stores_it(sync_config):
    calls = []
    with patch.object(sync, "export_ledger_snapshot", _minimal_snapshot):
        with patch.object(
            sync.urllib.request, "urlopen", _fake_urlopen({"revision": 1}, calls)
        ):
            with patch.dict(os.environ, {sync.PASSPHRASE_ENV: "right"}):
                sync.sync_init("vault-1", None, "https://sync.example.test")
        with patch.dict(os.environ, {sync.PASSPHRASE_ENV: "wrong"}):
            with patch.object(
                sync.urllib.request, "urlopen", _fake_urlopen({"revision": 2}, calls)
            ):
                # A wrong passphrase derives a different auth token; the server would
                # reject it. The client must still send a request (server decides), and
                # the local config must not have absorbed the wrong credential.
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
    salt = os.urandom(16)
    legacy = {
        "vault_id": "vault-legacy",
        "passphrase": "legacy-secret",
        "salt_b64": base64.b64encode(salt).decode("ascii"),
        "server_url": "https://sync.example.test",
        "revision": 3,
    }
    sync_config.write_text(json.dumps(legacy))

    calls = []
    with patch.object(sync, "export_ledger_snapshot", _minimal_snapshot):
        with patch.object(
            sync.urllib.request, "urlopen", _fake_urlopen({"revision": 4}, calls)
        ):
            sync.sync_push("https://sync.example.test")

    auth_token, _ = sync.derive_keys("legacy-secret", salt)
    assert calls[-1].get_header("Authorization") == f"Bearer {auth_token}"
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

    for host in ("127.0.0.1", "::1", "testclient"):
        sent.clear()
        scope = {
            "type": "http",
            "method": "GET",
            "path": "/",
            "headers": [],
            "client": (host, 12345),
        }
        asyncio.run(middleware(scope, _receive, _send))
        assert sent and sent[0]["status"] == 200, host
    assert len(reached) == 3


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
