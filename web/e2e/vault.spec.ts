import { test, expect } from "@playwright/test";
import crypto from "node:crypto";

const ITERATIONS = 100_000;

function derive(passphrase: string, salt: Buffer) {
  const derived = crypto.pbkdf2Sync(passphrase, salt, ITERATIONS, 64, "sha256");
  return {
    authToken: derived.subarray(0, 32).toString("base64"),
    encKey: derived.subarray(32, 64),
  };
}

function encrypt(key: Buffer, plaintext: string) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    ciphertext_b64: ciphertext.toString("base64"),
    nonce_b64: nonce.toString("base64"),
  };
}

function uniqueVaultId() {
  return `e2e-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
}

test.describe("encrypted vault protocol", () => {
  test("reopening with the stored salt works and a different salt is rejected", async ({ request }) => {
    const vaultId = uniqueVaultId();
    const passphrase = "correct horse battery staple";
    const salt = crypto.randomBytes(16);
    const keys = derive(passphrase, salt);
    const payload = encrypt(keys.encKey, JSON.stringify({ hello: "ledger" }));

    const created = await request.post("/api/vault", {
      data: {
        vault_id: vaultId,
        auth_token: keys.authToken,
        ciphertext_b64: payload.ciphertext_b64,
        nonce_b64: payload.nonce_b64,
        kdf_salt_b64: salt.toString("base64"),
      },
    });
    expect(created.status()).toBe(201);

    // A second client discovers the salt from public metadata (the original bug
    // derived a fresh salt and therefore a different auth token).
    const metadata = await request.get(`/api/vault/${vaultId}/metadata`);
    expect(metadata.status()).toBe(200);
    expect((await metadata.json()).kdf_salt_b64).toBe(salt.toString("base64"));

    const reopened = derive(passphrase, Buffer.from((await metadata.json()).kdf_salt_b64, "base64"));
    const fetched = await request.get(`/api/vault/${vaultId}`, {
      headers: { Authorization: `Bearer ${reopened.authToken}` },
    });
    expect(fetched.status()).toBe(200);
    expect((await fetched.json()).revision).toBe(1);

    const wrongSaltKeys = derive(passphrase, crypto.randomBytes(16));
    const rejected = await request.get(`/api/vault/${vaultId}`, {
      headers: { Authorization: `Bearer ${wrongSaltKeys.authToken}` },
    });
    expect(rejected.status()).toBe(401);
  });

  test("two clients racing at the same revision: exactly one wins", async ({ request }) => {
    const vaultId = uniqueVaultId();
    const passphrase = "race-condition-passphrase";
    const salt = crypto.randomBytes(16);
    const keys = derive(passphrase, salt);
    const first = encrypt(keys.encKey, "revision-one");

    const created = await request.post("/api/vault", {
      data: {
        vault_id: vaultId,
        auth_token: keys.authToken,
        ciphertext_b64: first.ciphertext_b64,
        nonce_b64: first.nonce_b64,
        kdf_salt_b64: salt.toString("base64"),
      },
    });
    expect(created.status()).toBe(201);

    const body = (tag: string) => {
      const encrypted = encrypt(keys.encKey, tag);
      return {
        expected_revision: 1,
        ciphertext_b64: encrypted.ciphertext_b64,
        nonce_b64: encrypted.nonce_b64,
        kdf_salt_b64: salt.toString("base64"),
      };
    };

    const [a, b] = await Promise.all([
      request.put(`/api/vault/${vaultId}`, {
        headers: { Authorization: `Bearer ${keys.authToken}` },
        data: body("client-a"),
      }),
      request.put(`/api/vault/${vaultId}`, {
        headers: { Authorization: `Bearer ${keys.authToken}` },
        data: body("client-b"),
      }),
    ]);
    expect([a.status(), b.status()].sort()).toEqual([200, 409]);

    const winner = a.status() === 200 ? a : b;
    const loser = a.status() === 200 ? b : a;
    expect((await winner.json()).revision).toBe(2);
    expect((await loser.json()).current_revision).toBe(2);

    // The losing client's local change was not written over the winner's.
    const fetched = await request.get(`/api/vault/${vaultId}`, {
      headers: { Authorization: `Bearer ${keys.authToken}` },
    });
    expect((await fetched.json()).revision).toBe(2);
  });

  test("updates require an expected revision and must not rotate the salt", async ({ request }) => {
    const vaultId = uniqueVaultId();
    const passphrase = "revision-required-passphrase";
    const salt = crypto.randomBytes(16);
    const keys = derive(passphrase, salt);
    const payload = encrypt(keys.encKey, "v1");
    expect(
      (await request.post("/api/vault", {
        data: {
          vault_id: vaultId,
          auth_token: keys.authToken,
          ciphertext_b64: payload.ciphertext_b64,
          nonce_b64: payload.nonce_b64,
          kdf_salt_b64: salt.toString("base64"),
        },
      })).status()
    ).toBe(201);

    const noRevision = await request.put(`/api/vault/${vaultId}`, {
      headers: { Authorization: `Bearer ${keys.authToken}` },
      data: {
        ciphertext_b64: payload.ciphertext_b64,
        nonce_b64: payload.nonce_b64,
      },
    });
    expect(noRevision.status()).toBe(400);

    const newSalt = crypto.randomBytes(16);
    const rotated = await request.put(`/api/vault/${vaultId}`, {
      headers: { Authorization: `Bearer ${keys.authToken}` },
      data: {
        expected_revision: 1,
        ciphertext_b64: payload.ciphertext_b64,
        nonce_b64: payload.nonce_b64,
        kdf_salt_b64: newSalt.toString("base64"),
      },
    });
    expect(rotated.status()).toBe(400);
    expect((await rotated.json()).error).toBe("SALT_ROTATION_NOT_ALLOWED");

    // The vault still opens with the original salt.
    const fetched = await request.get(`/api/vault/${vaultId}`, {
      headers: { Authorization: `Bearer ${keys.authToken}` },
    });
    expect(fetched.status()).toBe(200);
  });

  test("duplicate creation and malformed payloads are rejected", async ({ request }) => {
    const vaultId = uniqueVaultId();
    const salt = crypto.randomBytes(16);
    const keys = derive("duplicate-create-passphrase", salt);
    const payload = encrypt(keys.encKey, "x");
    const data = {
      vault_id: vaultId,
      auth_token: keys.authToken,
      ciphertext_b64: payload.ciphertext_b64,
      nonce_b64: payload.nonce_b64,
      kdf_salt_b64: salt.toString("base64"),
    };
    expect((await request.post("/api/vault", { data })).status()).toBe(201);
    expect((await request.post("/api/vault", { data })).status()).toBe(409);

    const malformed = await request.post("/api/vault", {
      data: { ...data, vault_id: "bad id with spaces", nonce_b64: "not-a-nonce" },
    });
    expect(malformed.status()).toBe(400);
  });
});
