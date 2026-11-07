import { createClient, type Client } from "@libsql/client";
import crypto from "node:crypto";

/**
 * Vault storage.
 *
 * Durable storage (libSQL/Turso) is required in production. The process-local
 * in-memory map is available only when `VAULT_MEMORY_STORE=1` is set explicitly
 * for tests/local development; it is never selected silently, and a server with
 * neither durable configuration nor the explicit test flag returns
 * STORAGE_UNAVAILABLE instead of pretending a write persisted.
 */

export interface VaultRecord {
  vault_id: string;
  auth_key_hash: string;
  revision: number;
  ciphertext_b64: string;
  nonce_b64: string;
  kdf_salt_b64: string;
  updated_at: string;
}

export class StorageUnavailableError extends Error {
  constructor() {
    super("Durable vault storage is not configured");
    this.name = "StorageUnavailableError";
  }
}

let clientInstance: Client | null = null;
let tableReady = false;

const memoryVaults = new Map<string, VaultRecord>();

function memoryMode(): boolean {
  return process.env.VAULT_MEMORY_STORE === "1" && !process.env.TURSO_DATABASE_URL;
}

export function storageAvailable(): boolean {
  return Boolean(process.env.TURSO_DATABASE_URL) || memoryMode();
}

export function getTursoClient(): Client | null {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) {
    return null;
  }
  if (!clientInstance) {
    clientInstance = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  }
  return clientInstance;
}

export async function initVaultTable(): Promise<void> {
  if (tableReady) return;
  const client = getTursoClient();
  if (client) {
    await client.execute(`
      CREATE TABLE IF NOT EXISTS vaults (
        vault_id TEXT PRIMARY KEY,
        auth_key_hash TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1,
        ciphertext_b64 TEXT NOT NULL,
        nonce_b64 TEXT NOT NULL,
        kdf_salt_b64 TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }
  tableReady = true;
}

export function hashAuthToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function timingSafeEqualStrings(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

export async function getVaultRecord(vaultId: string): Promise<VaultRecord | null> {
  if (memoryMode()) {
    return memoryVaults.get(vaultId) ?? null;
  }
  const client = getTursoClient();
  if (!client) {
    throw new StorageUnavailableError();
  }
  await initVaultTable();
  const rs = await client.execute({
    sql: "SELECT * FROM vaults WHERE vault_id = ?",
    args: [vaultId],
  });
  if (rs.rows.length === 0) return null;
  const row = rs.rows[0];
  return {
    vault_id: String(row.vault_id),
    auth_key_hash: String(row.auth_key_hash),
    revision: Number(row.revision),
    ciphertext_b64: String(row.ciphertext_b64),
    nonce_b64: String(row.nonce_b64),
    kdf_salt_b64: String(row.kdf_salt_b64),
    updated_at: String(row.updated_at),
  };
}

/** Atomic create. Returns false when the vault already exists (unique-key conflict). */
export async function createVaultRecord(record: Omit<VaultRecord, "updated_at">): Promise<boolean> {
  const now = new Date().toISOString();
  if (memoryMode()) {
    if (memoryVaults.has(record.vault_id)) return false;
    memoryVaults.set(record.vault_id, { ...record, updated_at: now });
    return true;
  }
  const client = getTursoClient();
  if (!client) {
    throw new StorageUnavailableError();
  }
  await initVaultTable();
  try {
    await client.execute({
      sql: `
        INSERT INTO vaults (vault_id, auth_key_hash, revision, ciphertext_b64, nonce_b64, kdf_salt_b64, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        record.vault_id,
        record.auth_key_hash,
        record.revision,
        record.ciphertext_b64,
        record.nonce_b64,
        record.kdf_salt_b64,
        now,
      ],
    });
    return true;
  } catch (err: any) {
    const message = String(err?.message ?? "");
    if (/unique|constraint/i.test(message)) {
      return false;
    }
    throw err;
  }
}

export type UpdateOutcome = "updated" | "not_found" | "unauthorized" | "conflict";

/**
 * Atomic compare-and-swap update. The revision check and the write are one
 * statement, so two concurrent clients at the same revision cannot both succeed.
 * The KDF salt is never rotated by a normal update.
 */
export async function updateVaultRecordAtomic(input: {
  vault_id: string;
  auth_key_hash: string;
  expected_revision: number;
  ciphertext_b64: string;
  nonce_b64: string;
}): Promise<UpdateOutcome> {
  const now = new Date().toISOString();
  if (memoryMode()) {
    const record = memoryVaults.get(input.vault_id);
    if (!record) return "not_found";
    if (!timingSafeEqualStrings(record.auth_key_hash, input.auth_key_hash)) return "unauthorized";
    if (record.revision !== input.expected_revision) return "conflict";
    memoryVaults.set(input.vault_id, {
      ...record,
      revision: record.revision + 1,
      ciphertext_b64: input.ciphertext_b64,
      nonce_b64: input.nonce_b64,
      updated_at: now,
    });
    return "updated";
  }

  const client = getTursoClient();
  if (!client) {
    throw new StorageUnavailableError();
  }
  await initVaultTable();
  const result = await client.execute({
    sql: `
      UPDATE vaults
         SET revision = revision + 1,
             ciphertext_b64 = ?,
             nonce_b64 = ?,
             updated_at = ?
       WHERE vault_id = ? AND auth_key_hash = ? AND revision = ?
    `,
    args: [
      input.ciphertext_b64,
      input.nonce_b64,
      now,
      input.vault_id,
      input.auth_key_hash,
      input.expected_revision,
    ],
  });
  if (Number(result.rowsAffected) === 1) {
    return "updated";
  }

  // The conditional write did not apply; classify without leaking existence.
  const current = await getVaultRecord(input.vault_id);
  if (!current) return "not_found";
  if (!timingSafeEqualStrings(current.auth_key_hash, input.auth_key_hash)) return "unauthorized";
  return "conflict";
}
