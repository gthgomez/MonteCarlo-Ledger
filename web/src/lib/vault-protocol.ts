/** Shared vault request validation and best-effort abuse limits. */

export const VAULT_ID_PATTERN = /^[A-Za-z0-9._-]{3,128}$/;
export const MAX_CIPHERTEXT_BYTES = 8 * 1024 * 1024;
export const MAX_CIPHERTEXT_B64 = Math.ceil((MAX_CIPHERTEXT_BYTES * 4) / 3) + 4;
export const MIN_PASSPHRASE_LENGTH = 8;

export function isValidVaultId(value: unknown): value is string {
  return typeof value === "string" && VAULT_ID_PATTERN.test(value);
}

function b64Bytes(value: unknown): number | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (value.length > MAX_CIPHERTEXT_B64) return null;
  if (value.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return null;
  return Buffer.from(value, "base64").length;
}

export function isCiphertext(value: unknown): value is string {
  const size = b64Bytes(value);
  return size !== null && size > 0 && size <= MAX_CIPHERTEXT_BYTES;
}

export function isNonce(value: unknown): value is string {
  return b64Bytes(value) === 12;
}

export function isSalt(value: unknown): value is string {
  return b64Bytes(value) === 16;
}

export function isAuthToken(value: unknown): value is string {
  return b64Bytes(value) === 32;
}

export function isExpectedRevision(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= Number.MAX_SAFE_INTEGER
  );
}

export function bearerToken(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7).trim();
  return token.length > 0 ? token : null;
}

// Best-effort per-instance throttling. Serverless deployments may have several
// instances, so this raises the cost of online guessing rather than replacing a
// durable rate limiter.
const FAILURE_WINDOW_MS = 60_000;
const MAX_FAILURES_PER_WINDOW = 10;
const failures = new Map<string, { count: number; resetAt: number }>();

export function authThrottled(key: string, now = Date.now()): boolean {
  const entry = failures.get(key);
  if (!entry) return false;
  if (now >= entry.resetAt) {
    failures.delete(key);
    return false;
  }
  return entry.count >= MAX_FAILURES_PER_WINDOW;
}

export function recordAuthFailure(key: string, now = Date.now()): void {
  const entry = failures.get(key);
  if (!entry || now >= entry.resetAt) {
    failures.set(key, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

export function clearAuthFailures(key: string): void {
  failures.delete(key);
}
