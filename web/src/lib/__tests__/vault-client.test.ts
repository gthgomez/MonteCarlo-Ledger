import test from "node:test";
import assert from "node:assert/strict";
import {
  VaultAncestryError,
  VaultConflictError,
  VaultLocalChangesError,
  pullVault,
  pushVault,
} from "../vault-client";
import {
  SyncStorage,
  VAULT_ID_STORAGE_KEY,
  commitSynchronizedState,
  readSyncRecord,
} from "../sync-state";
import { deriveVaultKeys, encryptVault } from "../crypto";
import { LEDGER_LOCK_NAME, LEDGER_STORAGE_KEY } from "../persistence";
import { SAMPLE_LEDGER_STATE, LedgerState } from "../types";

class FakeStorage implements SyncStorage {
  data = new Map<string, string>();
  failWrites = false;
  getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    if (this.failWrites) throw new Error("QuotaExceededError");
    this.data.set(key, value);
  }
  removeItem(key: string) {
    this.data.delete(key);
  }
}

interface RemoteVault {
  salt: string;
  auth: string;
  revision: number;
  ciphertext: string;
  nonce: string;
}

function makeServer() {
  const vaults = new Map<string, RemoteVault>();
  const log: string[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  const fetchImpl = async (input: any, init: any = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = String(init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers);
    log.push(`${method} ${url}`);

    const meta = url.match(/\/api\/vault\/([^/]+)\/metadata$/);
    if (meta && method === "GET") {
      const vault = vaults.get(decodeURIComponent(meta[1]));
      if (!vault) return json({ error: "VAULT_NOT_FOUND" }, 404);
      return json({ kdf_salt_b64: vault.salt, revision: vault.revision });
    }

    if (/\/api\/vault$/.test(url) && method === "POST") {
      const body = JSON.parse(init.body);
      if (vaults.has(body.vault_id)) return json({ error: "VAULT_ALREADY_EXISTS" }, 409);
      vaults.set(body.vault_id, {
        salt: body.kdf_salt_b64,
        auth: body.auth_token,
        revision: 1,
        ciphertext: body.ciphertext_b64,
        nonce: body.nonce_b64,
      });
      return json({ success: true, revision: 1 }, 201);
    }

    const one = url.match(/\/api\/vault\/([^/]+)$/);
    if (one) {
      const vault = vaults.get(decodeURIComponent(one[1]));
      if (!vault) return json({ error: "VAULT_NOT_FOUND" }, 404);
      const token = headers.get("authorization")?.replace(/^Bearer /, "");
      if (token !== vault.auth) return json({ error: "UNAUTHORIZED" }, 401);

      if (method === "GET") {
        return json({
          revision: vault.revision,
          ciphertext_b64: vault.ciphertext,
          nonce_b64: vault.nonce,
          kdf_salt_b64: vault.salt,
        });
      }
      if (method === "PUT") {
        const body = JSON.parse(init.body);
        if (body.expected_revision !== vault.revision) {
          return json(
            { error: "REVISION_CONFLICT", current_revision: vault.revision },
            409
          );
        }
        vault.revision += 1;
        vault.ciphertext = body.ciphertext_b64;
        vault.nonce = body.nonce_b64;
        return json({ success: true, revision: vault.revision });
      }
    }
    return json({ error: "NOT_FOUND" }, 404);
  };

  return { vaults, log, fetchImpl };
}

function mutateState(delta: number): LedgerState {
  const state: LedgerState = JSON.parse(JSON.stringify(SAMPLE_LEDGER_STATE));
  state.transactions[2].amount_cents += delta;
  state.current_balance_cents += delta;
  state.updated_at = new Date(2026, 0, 1, 0, 0, delta).toISOString();
  return state;
}

async function withServer<T>(
  fn: (server: ReturnType<typeof makeServer>) => Promise<T>
): Promise<T> {
  const server = makeServer();
  const original = globalThis.fetch;
  (globalThis as any).fetch = server.fetchImpl;
  try {
    return await fn(server);
  } finally {
    (globalThis as any).fetch = original;
  }
}

async function withFakeLocks<T>(fn: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        async request(_name: string, _options: unknown, callback: () => unknown) {
          return callback();
        },
      },
    },
  });
  try {
    return await fn();
  } finally {
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else Reflect.deleteProperty(globalThis, "navigator");
  }
}

function requestUrl(input: any): string {
  if (typeof input === "string") return input;
  return input.url ?? input.href;
}

test("a returning client pulls to establish ancestry, then both clients share a base", async () => {
  await withServer(async (server) => {
    const a = new FakeStorage();
    const b = new FakeStorage();
    const pass = "correct horse battery";
    const initial = mutateState(0);

    const created = await pushVault("vault-1", pass, initial, { storage: a });
    assert.equal(created.revision, 1);
    assert.equal(readSyncRecord("vault-1", a)?.baseRevision, 1);

    const pulled = await pullVault("vault-1", pass, undefined, { storage: b });
    assert.equal(pulled.revision, 1);
    assert.deepEqual(pulled.state, initial);
    commitSynchronizedState("vault-1", pulled.revision, pulled.state, b);
    assert.equal(readSyncRecord("vault-1", b)?.baseRevision, 1);

    // A pushes a new edit first.
    const updated = await pushVault("vault-1", pass, mutateState(100), { storage: a });
    assert.equal(updated.revision, 2);

    // B is still at base 1 and must not be able to overwrite revision 2.
    await assert.rejects(
      () => pushVault("vault-1", pass, mutateState(-250), { storage: b }),
      (err: unknown) => err instanceof VaultConflictError
    );
    assert.equal(server.vaults.get("vault-1")!.revision, 2);
    assert.equal(readSyncRecord("vault-1", b)?.baseRevision, 1);
  });
});

test("sequential stale writes cannot overwrite a newer remote snapshot", async () => {
  await withServer(async (server) => {
    const a = new FakeStorage();
    const b = new FakeStorage();
    const pass = "another long passphrase";
    await pushVault("vault-1", pass, mutateState(0), { storage: a });

    const pulled = await pullVault("vault-1", pass, undefined, { storage: b });
    commitSynchronizedState("vault-1", pulled.revision, pulled.state, b);

    // Device A edits and pushes twice while B is idle.
    await pushVault("vault-1", pass, mutateState(10), { storage: a });
    await pushVault("vault-1", pass, mutateState(20), { storage: a });
    assert.equal(server.vaults.get("vault-1")!.revision, 3);

    // B looks up the fresh metadata inside pushVault; it must not use revision 3 as
    // its expected revision. Its recorded base is 1, so the push is refused.
    await assert.rejects(
      () => pushVault("vault-1", pass, mutateState(-1), { storage: b }),
      /changed on another device/
    );
    assert.equal(server.vaults.get("vault-1")!.revision, 3);
    assert.equal(readSyncRecord("vault-1", b)?.baseRevision, 1);
  });
});

test("a push keeps its base if shared ancestry advances during the metadata lookup", async () => {
  await withServer(async (server) => {
    const local = new FakeStorage();
    const otherDevice = new FakeStorage();
    const pass = "synthetic passphrase";
    const oldState = mutateState(0);
    const newState = mutateState(100);
    await pushVault("vault-1", pass, oldState, { storage: local });
    commitSynchronizedState("vault-1", 1, oldState, otherDevice);
    await pushVault("vault-1", pass, newState, { storage: otherDevice });
    const before = server.log.length;
    globalThis.fetch = (input, init) => {
      // The original tab hasn't seen the snapshot, but a sibling tab has pulled it.
      commitSynchronizedState("vault-1", 2, newState, local);
      return server.fetchImpl(input, init);
    };

    await assert.rejects(
      () => pushVault("vault-1", pass, oldState, { storage: local }),
      /changed on another device/
    );
    assert.equal(server.vaults.get("vault-1")?.revision, 2);
    assert.deepEqual(server.log.slice(before), ["GET /api/vault/vault-1/metadata"]);
  });
});

test("a stale displayed ledger is refused under the shared lock before a push contacts the vault", async () => {
  await withServer(async (server) => {
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    const storage = new FakeStorage();
    const stale = mutateState(0);
    storage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(mutateState(100)));
    const lockRequests: string[] = [];
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        locks: {
          async request(name: string, _options: unknown, callback: () => unknown) {
            lockRequests.push(name);
            return callback();
          },
        },
      },
    });
    try {
      await assert.rejects(
        () => pushVault("vault-1", "synthetic passphrase", stale, {
          storage,
          expectedLedgerRaw: JSON.stringify(stale),
        }),
        /saved ledger changed in another tab/
      );
      assert.deepEqual(lockRequests, [LEDGER_LOCK_NAME]);
      assert.deepEqual(server.log, []);
    } finally {
      if (originalNavigator) Object.defineProperty(globalThis, "navigator", originalNavigator);
      else Reflect.deleteProperty(globalThis, "navigator");
    }
  });
});

test("a vault that already exists without local ancestry is never overwritten", async () => {
  await withServer(async (server) => {
    const a = new FakeStorage();
    const pass = "shared passphrase";
    await pushVault("vault-1", pass, mutateState(0), { storage: a });
    const before = server.vaults.get("vault-1")!;

    await assert.rejects(
      () => pushVault("vault-1", pass, mutateState(999), { storage: new FakeStorage() }),
      (err: unknown) => err instanceof VaultAncestryError
    );
    assert.equal(server.vaults.get("vault-1")!.revision, before.revision);
    assert.equal(server.vaults.get("vault-1")!.ciphertext, before.ciphertext);
  });
});

test("missing or corrupt local revision metadata blocks a push", async () => {
  await withServer(async (server) => {
    const a = new FakeStorage();
    const pass = "shared passphrase";
    await pushVault("vault-1", pass, mutateState(0), { storage: a });

    const corrupt = new FakeStorage();
    corrupt.setItem("montecarlo_vault_sync_v1", "{broken");
    await assert.rejects(
      () => pushVault("vault-1", pass, mutateState(5), { storage: corrupt }),
      (err: unknown) => err instanceof VaultAncestryError
    );
    assert.equal(server.vaults.get("vault-1")!.revision, 1);
  });
});

test("pull refuses to replace unsynchronized local edits unless explicitly allowed", async () => {
  await withServer(async () => {
    const a = new FakeStorage();
    const b = new FakeStorage();
    const pass = "correct horse battery";
    await pushVault("vault-1", pass, mutateState(0), { storage: a });
    const pulled = await pullVault("vault-1", pass, undefined, { storage: b });
    commitSynchronizedState("vault-1", pulled.revision, pulled.state, b);

    // B edits locally without pushing.
    const localEdit = mutateState(-777);
    await assert.rejects(
      () => pullVault("vault-1", pass, localEdit, { storage: b }),
      (err: unknown) => err instanceof VaultLocalChangesError
    );

    // Explicit recovery path: the user accepted the overwrite.
    const recovered = await pullVault("vault-1", pass, localEdit, {
      storage: b,
      allowOverwriteLocal: true,
    });
    assert.deepEqual(recovered.state, mutateState(0));
  });
});

test("a first pull over a non-empty local ledger requires explicit confirmation", async () => {
  await withServer(async () => {
    const a = new FakeStorage();
    const pass = "correct horse battery";
    await pushVault("vault-1", pass, mutateState(0), { storage: a });

    const fresh = new FakeStorage();
    const localOnly = mutateState(500);
    await assert.rejects(
      () => pullVault("vault-1", pass, localOnly, { storage: fresh }),
      (err: unknown) => err instanceof VaultLocalChangesError
    );
    const confirmed = await pullVault("vault-1", pass, localOnly, {
      storage: fresh,
      allowOverwriteLocal: true,
    });
    assert.deepEqual(confirmed.state, mutateState(0));
  });
});

test("pull rejects an authenticated payload that fails ledger validation", async () => {
  await withServer(async (server) => {
    const a = new FakeStorage();
    const pass = "correct horse battery";
    await pushVault("vault-1", pass, mutateState(0), { storage: a });
    const remote = server.vaults.get("vault-1")!;

    const keys = await deriveVaultKeys(pass, remote.salt);
    const bad = await encryptVault(JSON.stringify({ version: "2.1" }), keys.encKey);
    remote.ciphertext = bad.ciphertext_b64;
    remote.nonce = bad.nonce_b64;

    await assert.rejects(
      () => pullVault("vault-1", pass, undefined, { storage: a }),
      /failed validation/
    );
  });
});

test("a successful push whose ancestry cannot be persisted is reported honestly", async () => {
  await withServer(async (server) => {
    const a = new FakeStorage();
    const pass = "correct horse battery";
    await pushVault("vault-1", pass, mutateState(0), { storage: a });

    a.failWrites = true;
    const result = await pushVault("vault-1", pass, mutateState(50), { storage: a });
    assert.equal(result.revision, 2);
    assert.equal(result.ancestryPersisted, false);
    // The id from the earlier successful push is already durable, so it is still known.
    assert.equal(result.vaultIdPersisted, true);
    assert.equal(server.vaults.get("vault-1")!.revision, 2);
  });
});

test("conflict recovery preserves the loser's data and lets it push after a pull", async () => {
  await withServer(async (server) => {
    const a = new FakeStorage();
    const b = new FakeStorage();
    const pass = "correct horse battery";
    await pushVault("vault-1", pass, mutateState(0), { storage: a });
    const pulled = await pullVault("vault-1", pass, undefined, { storage: b });
    commitSynchronizedState("vault-1", pulled.revision, pulled.state, b);

    await pushVault("vault-1", pass, mutateState(100), { storage: a });

    const localEdit = mutateState(-300);
    await assert.rejects(
      () => pushVault("vault-1", pass, localEdit, { storage: b }),
      (err: unknown) => err instanceof VaultConflictError
    );
    // The losing client's in-memory data was not mutated by the rejected push.
    assert.equal(localEdit.current_balance_cents, SAMPLE_LEDGER_STATE.current_balance_cents - 300);

    const latest = await pullVault("vault-1", pass, localEdit, {
      storage: b,
      allowOverwriteLocal: true,
    });
    commitSynchronizedState("vault-1", latest.revision, latest.state, b);
    const pushed = await pushVault("vault-1", pass, localEdit, { storage: b });
    assert.equal(pushed.revision, 3);
    assert.equal(server.vaults.get("vault-1")!.revision, 3);
  });
});

test("an upload whose local id cannot be stored is reported without failing the push", async () => {
  await withServer(async (server) => {
    const storage = new FakeStorage();
    storage.failWrites = true;
    const result = await pushVault("vault-1", "synthetic passphrase", mutateState(0), {
      storage,
    });
    assert.equal(result.revision, 1);
    assert.equal(result.ancestryPersisted, false);
    assert.equal(result.vaultIdPersisted, false);
    assert.equal(storage.getItem(VAULT_ID_STORAGE_KEY), null);
    assert.equal(server.vaults.get("vault-1")!.revision, 1);
  });
});

test("a successful push remembers the generated vault id for the next page load", async () => {
  await withFakeLocks(() => withServer(async () => {
    const storage = new FakeStorage();
    const vaultId = "vault-generated-default";
    const result = await pushVault(vaultId, "synthetic passphrase", mutateState(0), {
      storage,
      expectedLedgerRaw: null,
    });
    assert.equal(result.revision, 1);
    assert.equal(result.ancestryPersisted, true);
    assert.equal(result.vaultIdPersisted, true);
    // A reload observes the same durable origin storage.
    assert.equal(storage.getItem(VAULT_ID_STORAGE_KEY), vaultId);
    assert.equal(readSyncRecord(vaultId, storage)?.baseRevision, 1);
  }));
});

test("a successful push updates the saved selection this tab chose", async () => {
  await withFakeLocks(() => withServer(async () => {
    const storage = new FakeStorage();
    storage.setItem(VAULT_ID_STORAGE_KEY, "vault-previously-selected");
    const result = await pushVault("vault-newly-chosen", "synthetic passphrase", mutateState(0), {
      storage,
      expectedLedgerRaw: null,
    });
    assert.equal(result.vaultIdPersisted, true);
    assert.equal(storage.getItem(VAULT_ID_STORAGE_KEY), "vault-newly-chosen");
  }));
});

test("a push refused by ancestry does not replace the saved vault selection", async () => {
  await withServer(async (server) => {
    const owner = new FakeStorage();
    const pass = "synthetic passphrase";
    await pushVault("vault-1", pass, mutateState(0), { storage: owner });

    const fresh = new FakeStorage();
    await withFakeLocks(async () => {
      await assert.rejects(
        () => pushVault("vault-1", pass, mutateState(5), {
          storage: fresh,
          expectedLedgerRaw: null,
        }),
        (err: unknown) => err instanceof VaultAncestryError
      );
    });
    assert.equal(fresh.getItem(VAULT_ID_STORAGE_KEY), null);
    assert.equal(server.vaults.get("vault-1")!.revision, 1);
  });
});

test("a slowed push does not overwrite a vault selection another tab made meanwhile", async () => {
  await withServer(async (server) => {
    const storage = new FakeStorage();
    const vaultId = "vault-this-tab";
    let selectedElsewhere = false;
    globalThis.fetch = (input, init) => {
      if (!selectedElsewhere && requestUrl(input).endsWith(`/api/vault/${vaultId}/metadata`)) {
        selectedElsewhere = true;
        // Another tab intentionally chose a different vault while this push waited.
        storage.setItem(VAULT_ID_STORAGE_KEY, "vault-other-tab");
      }
      return server.fetchImpl(input, init);
    };

    await withFakeLocks(async () => {
      const result = await pushVault(vaultId, "synthetic passphrase", mutateState(0), {
        storage,
        expectedLedgerRaw: null,
      });
      // The upload is still safe to record as ancestry, but the newer selection wins.
      assert.equal(result.ancestryPersisted, true);
      assert.equal(result.vaultIdPersisted, false);
    });
    assert.equal(storage.getItem(VAULT_ID_STORAGE_KEY), "vault-other-tab");
    assert.equal(readSyncRecord(vaultId, storage)?.baseRevision, 1);
    assert.equal(server.vaults.get(vaultId)?.revision, 1);
  });
});

test("a push does not attach its vault id after another tab replaced the ledger", async () => {
  await withServer(async (server) => {
    const storage = new FakeStorage();
    const vaultId = "vault-this-tab";
    let replaced = false;
    globalThis.fetch = (input, init) => {
      if (!replaced && requestUrl(input).endsWith(`/api/vault/${vaultId}/metadata`)) {
        replaced = true;
        // A normal edit in another tab lands after this push captured its ledger.
        storage.setItem(LEDGER_STORAGE_KEY, JSON.stringify(mutateState(100)));
      }
      return server.fetchImpl(input, init);
    };

    await withFakeLocks(async () => {
      const result = await pushVault(vaultId, "synthetic passphrase", mutateState(0), {
        storage,
        expectedLedgerRaw: null,
      });
      assert.equal(result.ancestryPersisted, true);
      assert.equal(result.vaultIdPersisted, false);
    });
    // The tab that changed the ledger keeps its own unsynchronized selection state.
    assert.equal(storage.getItem(VAULT_ID_STORAGE_KEY), null);
    assert.equal(server.vaults.get(vaultId)?.revision, 1);
  });
});
