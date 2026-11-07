import { NextResponse } from "next/server";
import { createVaultRecord, hashAuthToken, storageAvailable } from "@/lib/turso";
import {
  isAuthToken,
  isCiphertext,
  isNonce,
  isSalt,
  isValidVaultId,
} from "@/lib/vault-protocol";

function unavailable() {
  return NextResponse.json({ error: "STORAGE_UNAVAILABLE" }, { status: 503 });
}

export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "MALFORMED_JSON" }, { status: 400 });
  }

  const { vault_id, auth_token, ciphertext_b64, nonce_b64, kdf_salt_b64 } = body ?? {};
  if (!isValidVaultId(vault_id)) {
    return NextResponse.json({ error: "INVALID_VAULT_ID" }, { status: 400 });
  }
  if (
    !isAuthToken(auth_token) ||
    !isCiphertext(ciphertext_b64) ||
    !isNonce(nonce_b64) ||
    !isSalt(kdf_salt_b64)
  ) {
    return NextResponse.json({ error: "INVALID_VAULT_PAYLOAD" }, { status: 400 });
  }

  if (!storageAvailable()) {
    return unavailable();
  }

  try {
    const created = await createVaultRecord({
      vault_id,
      auth_key_hash: hashAuthToken(auth_token),
      revision: 1,
      ciphertext_b64,
      nonce_b64,
      kdf_salt_b64,
    });
    if (!created) {
      return NextResponse.json({ error: "VAULT_ALREADY_EXISTS" }, { status: 409 });
    }
    return NextResponse.json({ success: true, vault_id, revision: 1 }, { status: 201 });
  } catch (err) {
    console.error("[vault] create failed:", err instanceof Error ? err.name : "unknown");
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
