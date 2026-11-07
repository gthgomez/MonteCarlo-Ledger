import { NextResponse } from "next/server";
import {
  getVaultRecord,
  hashAuthToken,
  storageAvailable,
  timingSafeEqualStrings,
  updateVaultRecordAtomic,
} from "@/lib/turso";
import {
  authThrottled,
  bearerToken,
  clearAuthFailures,
  isCiphertext,
  isExpectedRevision,
  isNonce,
  isSalt,
  isValidVaultId,
  recordAuthFailure,
} from "@/lib/vault-protocol";

export const runtime = "nodejs";

function unauthorized() {
  // Deliberately identical for "missing vault" and "wrong passphrase" so an
  // unauthenticated caller cannot enumerate vault identifiers.
  return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
}

function unavailable() {
  return NextResponse.json({ error: "STORAGE_UNAVAILABLE" }, { status: 503 });
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ vault_id: string }> }
) {
  const { vault_id: vaultId } = await params;
  if (!isValidVaultId(vaultId)) {
    return NextResponse.json({ error: "INVALID_VAULT_ID" }, { status: 400 });
  }
  const token = bearerToken(req);
  if (!token) return unauthorized();
  if (authThrottled(vaultId)) {
    return NextResponse.json({ error: "TOO_MANY_ATTEMPTS" }, { status: 429 });
  }
  if (!storageAvailable()) return unavailable();

  try {
    const vault = await getVaultRecord(vaultId);
    if (!vault || !timingSafeEqualStrings(hashAuthToken(token), vault.auth_key_hash)) {
      recordAuthFailure(vaultId);
      return unauthorized();
    }
    clearAuthFailures(vaultId);
    return NextResponse.json({
      vault_id: vault.vault_id,
      revision: vault.revision,
      ciphertext_b64: vault.ciphertext_b64,
      nonce_b64: vault.nonce_b64,
      kdf_salt_b64: vault.kdf_salt_b64,
      updated_at: vault.updated_at,
    });
  } catch (err) {
    console.error("[vault] read failed:", err instanceof Error ? err.name : "unknown");
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ vault_id: string }> }
) {
  const { vault_id: vaultId } = await params;
  if (!isValidVaultId(vaultId)) {
    return NextResponse.json({ error: "INVALID_VAULT_ID" }, { status: 400 });
  }
  const token = bearerToken(req);
  if (!token) return unauthorized();
  if (authThrottled(vaultId)) {
    return NextResponse.json({ error: "TOO_MANY_ATTEMPTS" }, { status: 429 });
  }
  if (!storageAvailable()) return unavailable();

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "MALFORMED_JSON" }, { status: 400 });
  }
  const { expected_revision, ciphertext_b64, nonce_b64, kdf_salt_b64 } = body ?? {};

  // Revision is mandatory: an update without it would allow a lost update.
  if (!isExpectedRevision(expected_revision)) {
    return NextResponse.json({ error: "EXPECTED_REVISION_REQUIRED" }, { status: 400 });
  }
  if (!isCiphertext(ciphertext_b64) || !isNonce(nonce_b64)) {
    return NextResponse.json({ error: "INVALID_VAULT_PAYLOAD" }, { status: 400 });
  }
  if (kdf_salt_b64 !== undefined && !isSalt(kdf_salt_b64)) {
    return NextResponse.json({ error: "INVALID_VAULT_PAYLOAD" }, { status: 400 });
  }

  try {
    const vault = await getVaultRecord(vaultId);
    if (!vault || !timingSafeEqualStrings(hashAuthToken(token), vault.auth_key_hash)) {
      recordAuthFailure(vaultId);
      return unauthorized();
    }
    // Normal updates must not rotate the KDF salt: doing so changes the auth
    // token derived from the same passphrase and locks every other client out.
    if (kdf_salt_b64 !== undefined && !timingSafeEqualStrings(kdf_salt_b64, vault.kdf_salt_b64)) {
      return NextResponse.json({ error: "SALT_ROTATION_NOT_ALLOWED" }, { status: 400 });
    }

    const outcome = await updateVaultRecordAtomic({
      vault_id: vaultId,
      auth_key_hash: vault.auth_key_hash,
      expected_revision,
      ciphertext_b64,
      nonce_b64,
    });

    if (outcome === "updated") {
      clearAuthFailures(vaultId);
      return NextResponse.json({
        success: true,
        vault_id: vaultId,
        revision: expected_revision + 1,
      });
    }
    if (outcome === "conflict") {
      const current = await getVaultRecord(vaultId);
      return NextResponse.json(
        {
          error: "REVISION_CONFLICT",
          current_revision: current?.revision ?? null,
          detail: "Vault was modified by another client. Pull latest changes first.",
        },
        { status: 409 }
      );
    }
    recordAuthFailure(vaultId);
    return unauthorized();
  } catch (err) {
    console.error("[vault] update failed:", err instanceof Error ? err.name : "unknown");
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
