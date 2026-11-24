import { decryptVault, deriveVaultKeys, encryptVault } from "./crypto";
import { defaultLedgerLockManager, LEDGER_LOCK_NAME, LEDGER_STORAGE_KEY } from "./persistence";
import { LedgerState } from "./types";
import { parseLedgerState } from "./validate";
import {
  SyncStorage,
  VAULT_ID_STORAGE_KEY,
  commitSynchronizedState,
  defaultSyncStorage,
  localChangesSinceSync,
  planPush,
  readSyncRecord,
} from "./sync-state";

/** Browser-side vault protocol: salt discovery, auth, encryption, CAS revisions. */

export class VaultAuthError extends Error {
  constructor(message = "Wrong passphrase for this vault.") {
    super(message);
    this.name = "VaultAuthError";
  }
}

export class VaultConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultConflictError";
  }
}

/** The local ledger has edits this device never pushed/pulled; a pull would replace them. */
export class VaultLocalChangesError extends VaultConflictError {
  constructor(
    message = "This ledger has changes that have not been synchronized. Pulling would replace them. Export your ledger first, then confirm the overwrite."
  ) {
    super(message);
    this.name = "VaultLocalChangesError";
  }
}

/** The device has no trustworthy base revision for an existing vault. */
export class VaultAncestryError extends VaultConflictError {
  constructor(
    message = "This vault already exists, but this browser has no synchronized base for it. Pull it first; pushing now could overwrite changes this device never observed."
  ) {
    super(message);
    this.name = "VaultAncestryError";
  }
}

interface VaultMetadata {
  kdf_salt_b64: string;
  revision: number;
}

async function readError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return typeof data?.error === "string" ? data.error : `HTTP_${res.status}`;
  } catch {
    return `HTTP_${res.status}`;
  }
}

async function fetchMetadata(vaultId: string): Promise<VaultMetadata | null> {
  const res = await fetch(`/api/vault/${encodeURIComponent(vaultId)}/metadata`, {
    method: "GET",
    cache: "no-store",
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`Vault metadata unavailable (${await readError(res)})`);
  }
  const data = await res.json();
  return { kdf_salt_b64: data.kdf_salt_b64, revision: data.revision };
}

export interface PushOptions {
  storage?: SyncStorage | null;
  /** The actual durable ledger shown in the initiating tab, not a reserialized snapshot. */
  expectedLedgerRaw?: string | null;
}

export interface PushResult {
  revision: number;
  /** False when the server accepted the push but ancestry could not be persisted locally. */
  ancestryPersisted: boolean;
  /**
   * False when the upload succeeded but this browser could not record the vault
   * selection. Only the vault id is remembered; the passphrase is never stored.
   */
  vaultIdPersisted: boolean;
}

interface StoredValue {
  value: string | null;
  readable: boolean;
}

function readStoredValue(storage: SyncStorage | null, key: string): StoredValue {
  if (!storage) return { value: null, readable: false };
  try {
    return { value: storage.getItem(key), readable: true };
  } catch {
    return { value: null, readable: false };
  }
}

export async function pushVault(
  vaultId: string,
  passphrase: string,
  state: LedgerState,
  options: PushOptions = {}
): Promise<PushResult> {
  const storage =
    options.storage === undefined ? defaultSyncStorage() : options.storage;
  const locks = options.expectedLedgerRaw === undefined ? null : defaultLedgerLockManager();
  if (options.expectedLedgerRaw !== undefined && !locks) {
    throw new VaultConflictError(
      "This browser cannot check the saved ledger safely across tabs, so nothing was pushed."
    );
  }
  const withLedgerLock = <T,>(readOrWrite: () => T): Promise<T> =>
    locks ? locks.request(LEDGER_LOCK_NAME, { mode: "exclusive" }, readOrWrite) : Promise.resolve(readOrWrite());
  // A tab must not borrow another tab's newer ancestry to upload its older displayed ledger.
  // Capture the durable ledger, ancestry and current selection under the same lock that
  // protects local restores, before any network waits.
  const captured = await withLedgerLock(() => {
    const ledger = readStoredValue(storage, LEDGER_STORAGE_KEY);
    if (options.expectedLedgerRaw !== undefined &&
        (!storage || !ledger.readable || ledger.value !== options.expectedLedgerRaw)) {
      throw new VaultConflictError("The saved ledger changed in another tab. Reload and review it before pushing.");
    }
    const selected = readStoredValue(storage, VAULT_ID_STORAGE_KEY);
    return {
      record: readSyncRecord(vaultId, storage),
      ledgerRaw: ledger.readable ? ledger.value : undefined,
      selectedVaultId: selected.readable ? selected.value : undefined,
    };
  });

  async function rememberPush(revision: number): Promise<PushResult> {
    let ancestryPersisted = false;
    let vaultIdPersisted = false;
    try {
      const recorded = await withLedgerLock(() => {
        const latest = readSyncRecord(vaultId, storage);
        // A pull in another tab may already have committed this revision or a later one.
        const ancestry =
          (latest !== null && latest.baseRevision >= revision) ||
          commitSynchronizedState(vaultId, revision, state, storage);
        if (!storage) return { ancestry, vaultIdPersisted: false };

        const selected = readStoredValue(storage, VAULT_ID_STORAGE_KEY);
        // Another tab already chose this same vault; nothing to write.
        if (selected.readable && selected.value === vaultId) {
          return { ancestry, vaultIdPersisted: true };
        }
        // A slower push must not replace a selection another tab made meanwhile,
        // and it must not attach its id to a ledger this tab did not upload.
        const ledger = readStoredValue(storage, LEDGER_STORAGE_KEY);
        const selectionUnchanged =
          captured.selectedVaultId !== undefined &&
          selected.readable &&
          selected.value === captured.selectedVaultId;
        const ledgerUnchanged =
          captured.ledgerRaw !== undefined &&
          ledger.readable &&
          ledger.value === captured.ledgerRaw;
        if (!selectionUnchanged || !ledgerUnchanged) {
          return { ancestry, vaultIdPersisted: false };
        }
        try {
          storage.setItem(VAULT_ID_STORAGE_KEY, vaultId);
          return {
            ancestry,
            vaultIdPersisted: storage.getItem(VAULT_ID_STORAGE_KEY) === vaultId,
          };
        } catch {
          return { ancestry, vaultIdPersisted: false };
        }
      });
      ancestryPersisted = recorded.ancestry;
      vaultIdPersisted = recorded.vaultIdPersisted;
    } catch {
      // The upload succeeded even if local ancestry or the selection could not be recorded.
    }
    return { revision, ancestryPersisted, vaultIdPersisted };
  }

  const metadata = await fetchMetadata(vaultId);
  const plan = planPush(captured.record, metadata !== null);
  const plaintext = JSON.stringify(state);

  if (plan.mode === "conflict") {
    if (plan.reason === "stale-local") {
      throw new VaultConflictError(
        "This device has synchronization state for a vault the server no longer has. Refusing to recreate it automatically."
      );
    }
    throw new VaultAncestryError();
  }

  if (plan.mode === "create") {
    const keys = await deriveVaultKeys(passphrase);
    const encrypted = await encryptVault(plaintext, keys.encKey);
    const res = await fetch("/api/vault", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        vault_id: vaultId,
        auth_token: keys.authToken,
        ciphertext_b64: encrypted.ciphertext_b64,
        nonce_b64: encrypted.nonce_b64,
        kdf_salt_b64: keys.saltB64,
      }),
    });
    if (res.status === 409) {
      // Another client created it between our metadata read and this POST.
      throw new VaultConflictError(
        "This vault already exists. Pull it first, then push your changes."
      );
    }
    if (!res.ok) {
      throw new Error(`Failed to create vault (${await readError(res)})`);
    }
    const data = await res.json();
    const revision = Number(data.revision ?? 1);
    return rememberPush(revision);
  }

  // An existing vault: the only safe base is the revision this device synchronized with.
  if (captured.record === null) throw new VaultAncestryError();
  if (metadata!.revision !== captured.record.baseRevision) {
    // Do not substitute the server's latest revision: that is exactly how a stale
    // client overwrites changes it never observed.
    throw new VaultConflictError(
      "This vault changed on another device since your last sync. Pull the latest revision before pushing; your local ledger has not been overwritten."
    );
  }

  const keys = await deriveVaultKeys(passphrase, metadata!.kdf_salt_b64);
  const encrypted = await encryptVault(plaintext, keys.encKey);
  const res = await fetch(`/api/vault/${encodeURIComponent(vaultId)}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${keys.authToken}`,
    },
    body: JSON.stringify({
      expected_revision: plan.expectedRevision,
      ciphertext_b64: encrypted.ciphertext_b64,
      nonce_b64: encrypted.nonce_b64,
      // The existing salt is echoed back, never rotated.
      kdf_salt_b64: metadata!.kdf_salt_b64,
    }),
  });
  if (res.status === 401) throw new VaultAuthError();
  if (res.status === 409) {
    throw new VaultConflictError(
      "This vault changed on another device. Pull the latest revision, then push again. Your local ledger has not been overwritten."
    );
  }
  if (!res.ok) {
    throw new Error(`Failed to push to vault (${await readError(res)})`);
  }
  const data = await res.json();
  const revision = Number(data.revision ?? plan.expectedRevision + 1);
  return rememberPush(revision);
}

export interface PullOptions {
  storage?: SyncStorage | null;
  /** Set only after the user has explicitly accepted losing unsynchronized local edits. */
  allowOverwriteLocal?: boolean;
}

export interface PullResult {
  state: LedgerState;
  revision: number;
}

export async function pullVault(
  vaultId: string,
  passphrase: string,
  localState?: LedgerState,
  options: PullOptions = {}
): Promise<PullResult> {
  const storage =
    options.storage === undefined ? defaultSyncStorage() : options.storage;
  const metadata = await fetchMetadata(vaultId);
  if (!metadata) {
    throw new Error("Vault not found. Push once first, or check the Vault ID.");
  }

  const record = readSyncRecord(vaultId, storage);
  if (
    !options.allowOverwriteLocal &&
    localChangesSinceSync(record, localState)
  ) {
    throw new VaultLocalChangesError();
  }

  const keys = await deriveVaultKeys(passphrase, metadata.kdf_salt_b64);
  const res = await fetch(`/api/vault/${encodeURIComponent(vaultId)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${keys.authToken}` },
    cache: "no-store",
  });
  if (res.status === 401) throw new VaultAuthError();
  if (!res.ok) {
    throw new Error(`Failed to pull from vault (${await readError(res)})`);
  }
  const data = await res.json();
  const plaintext = await decryptVault(data.ciphertext_b64, data.nonce_b64, keys.encKey);
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new Error("Vault payload is not valid JSON.");
  }
  const validated = parseLedgerState(parsed);
  if (!validated.ok) {
    throw new Error(`Vault payload failed validation: ${validated.error}`);
  }
  return { state: validated.state, revision: Number(data.revision) };
}
