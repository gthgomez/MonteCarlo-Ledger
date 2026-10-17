import { createClient, type Client } from "@libsql/client";
import crypto from "node:crypto";

let clientInstance: Client | null = null;
let isInitialized = false;

// In-memory fallback if Turso env vars are not set
const memoryVaults = new Map<
  string,
  {
    vault_id: string;
    auth_key_hash: string;
    revision: number;
    ciphertext_b64: string;
    nonce_b64: string;
    kdf_salt_b64: string;
    updated_at: string;
  }
>();

export function getTursoClient(): Client | null {
  const url = process.env.TURSO_DATABASE_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (!url) {
    return null;
  }

  if (!clientInstance) {
    clientInstance = createClient({
      url,
      authToken,
    });
  }
  return clientInstance;
}

export async function initVaultTable(): Promise<void> {
  if (isInitialized) return;
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
  isInitialized = true;
}

export function hashAuthToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export async function getVaultRecord(vaultId: string) {
  await initVaultTable();
  const client = getTursoClient();
  if (client) {
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
  } else {
    return memoryVaults.get(vaultId) ?? null;
  }
}

export async function saveVaultRecord(record: {
  vault_id: string;
  auth_key_hash: string;
  revision: number;
  ciphertext_b64: string;
  nonce_b64: string;
  kdf_salt_b64: string;
}) {
  await initVaultTable();
  const now = new Date().toISOString();
  const client = getTursoClient();
  if (client) {
    await client.execute({
      sql: `
        INSERT INTO vaults (vault_id, auth_key_hash, revision, ciphertext_b64, nonce_b64, kdf_salt_b64, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(vault_id) DO UPDATE SET
          revision = excluded.revision,
          ciphertext_b64 = excluded.ciphertext_b64,
          nonce_b64 = excluded.nonce_b64,
          kdf_salt_b64 = excluded.kdf_salt_b64,
          updated_at = excluded.updated_at
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
  } else {
    memoryVaults.set(record.vault_id, {
      ...record,
      updated_at: now,
    });
  }
}
