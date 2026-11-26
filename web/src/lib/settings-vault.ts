import { decryptVault, deriveVaultKeys, encryptVault } from "./crypto";
import {
  parseSettingsProfile,
  readSettingsProfileRevision,
  rememberSettingsProfileRevision,
  settingsProfileVaultId,
  SETTINGS_PROFILE_SCHEMA_VERSION,
  type SettingsProfile,
} from "./settings-profile";
import { defaultSyncStorage, type SyncStorage } from "./sync-state";
import { fetchMetadata, VaultAuthError, VaultConflictError } from "./vault-client";

/**
 * Transport for the optional portable financial-settings object.
 *
 * It lives in a second encrypted vault object under a derived id. The ledger
 * snapshot is untouched, so existing Python/Android readers keep working. The
 * profile uses the ledger's KDF salt (same passphrase, no extra secret) and its
 * own CAS revision, which prevents a stale device from replacing newer settings.
 */

export type SettingsProfilePullResult =
  | { status: "found"; profile: SettingsProfile; revision: number; profileVaultId: string }
  | { status: "missing"; profileVaultId: string }
  | { status: "unreadable"; profileVaultId: string; error: string };

export type SettingsProfilePushResult =
  | { ok: true; revision: number; profileVaultId: string; ancestryPersisted: boolean }
  | { ok: false; profileVaultId: string; error: string; conflict: boolean };

async function readError(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return typeof data?.error === "string" ? data.error : `HTTP_${res.status}`;
  } catch {
    return `HTTP_${res.status}`;
  }
}

export async function pullSettingsProfile(
  vaultId: string,
  passphrase: string
): Promise<SettingsProfilePullResult> {
  const profileVaultId = await settingsProfileVaultId(vaultId);
  const metadata = await fetchMetadata(profileVaultId);
  if (!metadata) return { status: "missing", profileVaultId };

  const keys = await deriveVaultKeys(passphrase, metadata.kdf_salt_b64);
  const res = await fetch(`/api/vault/${encodeURIComponent(profileVaultId)}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${keys.authToken}` },
    cache: "no-store",
  });
  if (res.status === 401) throw new VaultAuthError("Wrong passphrase for the recovered financial settings.");
  if (!res.ok) {
    return {
      status: "unreadable",
      profileVaultId,
      error: `Saved financial settings could not be downloaded (${await readError(res)}).`,
    };
  }
  const data = await res.json();
  let parsed: unknown;
  try {
    const plaintext = await decryptVault(data.ciphertext_b64, data.nonce_b64, keys.encKey);
    parsed = JSON.parse(plaintext);
  } catch {
    return {
      status: "unreadable",
      profileVaultId,
      error: "Saved financial settings could not be decrypted or are not valid JSON.",
    };
  }
  const validated = parseSettingsProfile(parsed);
  if (!validated.ok) {
    return { status: "unreadable", profileVaultId, error: validated.error };
  }
  return {
    status: "found",
    profile: validated.profile,
    revision: Number(data.revision ?? metadata.revision),
    profileVaultId,
  };
}

export async function pushSettingsProfile(
  vaultId: string,
  passphrase: string,
  profile: SettingsProfile,
  ledgerRevision: number,
  storage: SyncStorage | null = defaultSyncStorage()
): Promise<SettingsProfilePushResult> {
  const profileVaultId = await settingsProfileVaultId(vaultId);
  try {
    const ledgerMetadata = await fetchMetadata(vaultId);
    if (!ledgerMetadata) {
      return {
        ok: false,
        profileVaultId,
        conflict: false,
        error: "The ledger vault does not exist yet, so financial settings were not sent.",
      };
    }
    if (ledgerMetadata.revision !== ledgerRevision) {
      return {
        ok: false,
        profileVaultId,
        conflict: true,
        error: "The ledger was updated again before these financial settings could be saved. Pull the latest vault and review its settings.",
      };
    }
    const bound = parseSettingsProfile({
      ...profile,
      schemaVersion: SETTINGS_PROFILE_SCHEMA_VERSION,
      ledgerRevision,
    });
    if (!bound.ok) return { ok: false, profileVaultId, conflict: false, error: bound.error };
    const existing = await fetchMetadata(profileVaultId);
    const keys = await deriveVaultKeys(passphrase, ledgerMetadata.kdf_salt_b64);
    const encrypted = await encryptVault(JSON.stringify(bound.profile), keys.encKey);

    if (!existing) {
      const res = await fetch("/api/vault", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          vault_id: profileVaultId,
          auth_token: keys.authToken,
          ciphertext_b64: encrypted.ciphertext_b64,
          nonce_b64: encrypted.nonce_b64,
          kdf_salt_b64: keys.saltB64,
        }),
      });
      if (res.status === 409) {
        return {
          ok: false,
          profileVaultId,
          conflict: true,
          error: "Financial settings were created on another device while this push was starting. Pull before pushing settings again.",
        };
      }
      if (!res.ok) {
        return {
          ok: false,
          profileVaultId,
          conflict: false,
          error: `Financial settings could not be created (${await readError(res)}).`,
        };
      }
      const data = await res.json();
      const revision = Number(data.revision ?? 1);
      const ancestryPersisted = rememberSettingsProfileRevision(
        storage,
        profileVaultId,
        revision,
        profile.savedAt
      );
      return { ok: true, revision, profileVaultId, ancestryPersisted };
    }

    const ancestry = readSettingsProfileRevision(storage, profileVaultId);
    if (!ancestry || ancestry.baseRevision !== existing.revision) {
      return {
        ok: false,
        profileVaultId,
        conflict: true,
        error: "Financial settings changed on another device since this browser last synchronized them. Pull the latest vault before pushing again.",
      };
    }

    const res = await fetch(`/api/vault/${encodeURIComponent(profileVaultId)}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${keys.authToken}`,
      },
      body: JSON.stringify({
        expected_revision: existing.revision,
        ciphertext_b64: encrypted.ciphertext_b64,
        nonce_b64: encrypted.nonce_b64,
        kdf_salt_b64: existing.kdf_salt_b64,
      }),
    });
    if (res.status === 401) {
      return {
        ok: false,
        profileVaultId,
        conflict: false,
        error: "Wrong passphrase for the existing financial-settings object.",
      };
    }
    if (res.status === 409) {
      return {
        ok: false,
        profileVaultId,
        conflict: true,
        error: "Financial settings changed on another device. Pull the latest vault before pushing again.",
      };
    }
    if (!res.ok) {
      return {
        ok: false,
        profileVaultId,
        conflict: false,
        error: `Financial settings could not be updated (${await readError(res)}).`,
      };
    }
    const data = await res.json();
    const revision = Number(data.revision ?? existing.revision + 1);
    const ancestryPersisted = rememberSettingsProfileRevision(
      storage,
      profileVaultId,
      revision,
      profile.savedAt
    );
    return { ok: true, revision, profileVaultId, ancestryPersisted };
  } catch (err: unknown) {
    if (err instanceof VaultAuthError) throw err;
    if (err instanceof VaultConflictError) {
      return { ok: false, profileVaultId, conflict: true, error: err.message };
    }
    return {
      ok: false,
      profileVaultId,
      conflict: false,
      error: err instanceof Error ? err.message : "Financial settings could not be synchronized.",
    };
  }
}
