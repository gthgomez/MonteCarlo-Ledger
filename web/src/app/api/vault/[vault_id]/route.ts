import { NextResponse } from "next/server";
import { getVaultRecord, hashAuthToken, saveVaultRecord } from "@/lib/turso";

function getBearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return null;
  }
  return auth.slice(7).trim();
}

export async function GET(
  req: Request,
  { params }: { params: { vault_id: string } }
) {
  try {
    const vaultId = params.vault_id;
    const token = getBearerToken(req);

    if (!token) {
      return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
    }

    const vault = await getVaultRecord(vaultId);
    if (!vault) {
      return NextResponse.json({ error: "VAULT_NOT_FOUND" }, { status: 404 });
    }

    const tokenHash = hashAuthToken(token);
    if (tokenHash !== vault.auth_key_hash) {
      return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
    }

    return NextResponse.json({
      vault_id: vault.vault_id,
      revision: vault.revision,
      ciphertext_b64: vault.ciphertext_b64,
      nonce_b64: vault.nonce_b64,
      kdf_salt_b64: vault.kdf_salt_b64,
      updated_at: vault.updated_at,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "INTERNAL_ERROR" },
      { status: 500 }
    );
  }
}

export async function PUT(
  req: Request,
  { params }: { params: { vault_id: string } }
) {
  try {
    const vaultId = params.vault_id;
    const token = getBearerToken(req);

    if (!token) {
      return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
    }

    const body = await req.json();
    const { expected_revision, ciphertext_b64, nonce_b64, kdf_salt_b64 } = body;

    const vault = await getVaultRecord(vaultId);
    if (!vault) {
      return NextResponse.json({ error: "VAULT_NOT_FOUND" }, { status: 404 });
    }

    const tokenHash = hashAuthToken(token);
    if (tokenHash !== vault.auth_key_hash) {
      return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });
    }

    if (expected_revision !== undefined && expected_revision !== vault.revision) {
      return NextResponse.json(
        {
          error: "REVISION_CONFLICT",
          current_revision: vault.revision,
          detail: "Vault was modified by another client. Pull latest changes first.",
        },
        { status: 409 }
      );
    }

    const nextRevision = vault.revision + 1;
    await saveVaultRecord({
      vault_id: vaultId,
      auth_key_hash: vault.auth_key_hash,
      revision: nextRevision,
      ciphertext_b64,
      nonce_b64,
      kdf_salt_b64: kdf_salt_b64 || vault.kdf_salt_b64,
    });

    return NextResponse.json({
      success: true,
      vault_id: vaultId,
      revision: nextRevision,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || "INTERNAL_ERROR" },
      { status: 500 }
    );
  }
}
