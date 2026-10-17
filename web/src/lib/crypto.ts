/**
 * Client-Side Zero-Knowledge Encryption (E2EE) using WebCrypto AES-GCM & PBKDF2.
 * The server only sees ciphertext and an auth token hash; it never sees the encryption key.
 */

function bufToB64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function b64ToBuf(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export interface DerivedKeys {
  authToken: string;
  encKey: CryptoKey;
  saltB64: string;
}

export async function deriveVaultKeys(
  passphrase: string,
  existingSaltB64?: string
): Promise<DerivedKeys> {
  const enc = new TextEncoder();
  const salt = existingSaltB64
    ? b64ToBuf(existingSaltB64)
    : crypto.getRandomValues(new Uint8Array(16));

  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(passphrase),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: salt as any,
      iterations: 100000,
      hash: "SHA-256",
    },
    baseKey,
    512 // 64 bytes total: 32 bytes for auth token, 32 bytes for AES-GCM
  );

  const authSlice = derivedBits.slice(0, 32);
  const encSlice = derivedBits.slice(32, 64);

  const authToken = bufToB64(authSlice);
  const encKey = await crypto.subtle.importKey(
    "raw",
    encSlice,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"]
  );

  return {
    authToken,
    encKey,
    saltB64: bufToB64(salt),
  };
}

export async function encryptVault(
  plaintext: string,
  encKey: CryptoKey
): Promise<{ ciphertext_b64: string; nonce_b64: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const encoded = enc.encode(plaintext);

  const ciphertextBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as any },
    encKey,
    encoded
  );

  return {
    ciphertext_b64: bufToB64(ciphertextBuf),
    nonce_b64: bufToB64(iv),
  };
}

export async function decryptVault(
  ciphertext_b64: string,
  nonce_b64: string,
  encKey: CryptoKey
): Promise<string> {
  const ciphertext = b64ToBuf(ciphertext_b64);
  const iv = b64ToBuf(nonce_b64);

  const decryptedBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as any },
    encKey,
    ciphertext as any
  );

  const dec = new TextDecoder();
  return dec.decode(decryptedBuf);
}
