import { NextResponse } from "next/server";
import { getVaultRecord, hashAuthToken, saveVaultRecord } from "@/lib/turso";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { vault_id, auth_token, ciphertext_b64, nonce_b64, kdf_salt_b64 } = body;

    if (!vault_id || !auth_token || !ciphertext_b64 || !nonce_b64 || !kdf_salt_b64) {
      return NextResponse.json(
        { error: "MISSING_REQUIRED_FIELDS" },
        { status: 400 }
      );
    }

    const existing = await getVaultRecord(vault_id);
    if (existing) {
      return NextResponse.json(
        { error: "VAULT_ALREADY_EXISTS" },
        { status: 409 }
      );
    }

    const authKeyHash = hashAuthToken(auth_token);
    await saveVaultRecord({
      vault_id,
      auth_key_hash: authKeyHash,
      revision: 1,
      ciphertext_b64,
      nonce_b64,
      kdf_salt_b64,
    });

    return NextResponse.json({
      success: true,
      vault_id,
      revision: 1,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "INTERNAL_ERROR" },
      { status: 500 }
    );
  }
}
