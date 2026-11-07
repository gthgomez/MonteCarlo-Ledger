import { NextResponse } from "next/server";
import { getVaultRecord, storageAvailable } from "@/lib/turso";
import { isValidVaultId } from "@/lib/vault-protocol";

export const runtime = "nodejs";

/**
 * Public KDF metadata lookup.
 *
 * A returning client (or a second device) needs the vault's PBKDF2 salt before it
 * can derive the same authentication token; the salt is not a secret. The trade-off
 * is that this endpoint reveals whether a high-entropy vault id exists, so callers
 * must generate unguessable ids. No ciphertext or authentication material is exposed.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ vault_id: string }> }
) {
  const { vault_id: vaultId } = await params;
  if (!isValidVaultId(vaultId)) {
    return NextResponse.json({ error: "INVALID_VAULT_ID" }, { status: 400 });
  }
  if (!storageAvailable()) {
    return NextResponse.json({ error: "STORAGE_UNAVAILABLE" }, { status: 503 });
  }
  try {
    const vault = await getVaultRecord(vaultId);
    if (!vault) {
      return NextResponse.json({ error: "VAULT_NOT_FOUND" }, { status: 404 });
    }
    return NextResponse.json({
      vault_id: vault.vault_id,
      kdf_salt_b64: vault.kdf_salt_b64,
      revision: vault.revision,
      updated_at: vault.updated_at,
    });
  } catch (err) {
    console.error("[vault] metadata failed:", err instanceof Error ? err.name : "unknown");
    return NextResponse.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
