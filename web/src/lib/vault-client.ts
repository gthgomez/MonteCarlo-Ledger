import { decryptVault, deriveVaultKeys, encryptVault } from "./crypto";
import { LedgerState } from "./types";
import { parseLedgerState } from "./validate";

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

export async function pushVault(
  vaultId: string,
  passphrase: string,
  state: LedgerState
): Promise<{ revision: number }> {
  const metadata = await fetchMetadata(vaultId);
  const plaintext = JSON.stringify(state);

  if (!metadata) {
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
      throw new VaultConflictError(
        "This vault already exists. Pull it first, then push your changes."
      );
    }
    if (!res.ok) {
      throw new Error(`Failed to create vault (${await readError(res)})`);
    }
    const data = await res.json();
    return { revision: data.revision };
  }

  const keys = await deriveVaultKeys(passphrase, metadata.kdf_salt_b64);
  const encrypted = await encryptVault(plaintext, keys.encKey);
  const res = await fetch(`/api/vault/${encodeURIComponent(vaultId)}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${keys.authToken}`,
    },
    body: JSON.stringify({
      expected_revision: metadata.revision,
      ciphertext_b64: encrypted.ciphertext_b64,
      nonce_b64: encrypted.nonce_b64,
      // The existing salt is echoed back, never rotated.
      kdf_salt_b64: metadata.kdf_salt_b64,
    }),
  });
  if (res.status === 401) throw new VaultAuthError();
  if (res.status === 409) {
    throw new VaultConflictError(
      "This vault changed on another device. Pull the latest revision, then push again."
    );
  }
  if (!res.ok) {
    throw new Error(`Failed to push to vault (${await readError(res)})`);
  }
  const data = await res.json();
  return { revision: data.revision };
}

export async function pullVault(
  vaultId: string,
  passphrase: string
): Promise<{ state: LedgerState; revision: number }> {
  const metadata = await fetchMetadata(vaultId);
  if (!metadata) {
    throw new Error("Vault not found. Push once first, or check the Vault ID.");
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
  return { state: validated.state, revision: data.revision };
}
