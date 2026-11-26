import type { KeyValueStorage } from "./budget-targets";

/**
 * Durable "financial settings need review" guard for a vault restore.
 *
 * A ledger snapshot and its optional settings profile are two vault objects with
 * independent revisions. A restore can therefore finish with new records and no
 * confirmed decision settings. The in-memory review gate is not enough: a reload,
 * a tab close, or a crash must not silently turn default assumptions (notably a
 * zero reserve) into spending guidance.
 *
 * This record is local-only metadata. It never contains financial values,
 * ciphertext, a passphrase, or a vault secret.
 */

export const SETTINGS_REVIEW_STORAGE_KEY = "montecarlo_settings_review_v1";

export type SettingsReviewReason = "missing" | "unreadable" | "settings-pending";

export interface SettingsReviewGuard {
  vaultId: string;
  /** Revision of the ledger restored in the same bundle as this guard. */
  ledgerRevision: number;
  /** Identity of this restore; clearing is conditional on this token. */
  token: string;
  reason: SettingsReviewReason;
  recordedAt: string;
}

export interface SettingsReviewStorage extends KeyValueStorage {
  removeItem(key: string): void;
}

export type SettingsReviewRead =
  | { status: "absent" }
  | { status: "valid"; guard: SettingsReviewGuard; raw: string }
  | { status: "corrupt"; raw: string | null };

export interface SettingsReviewResolution {
  ok: boolean;
  cleared: boolean;
  applied: boolean;
  /** The reviewed identity no longer matches; do not apply or clear it. */
  superseded: boolean;
  current: SettingsReviewGuard | null;
  error?: string;
}

const REASONS: readonly SettingsReviewReason[] = ["missing", "unreadable", "settings-pending"];
const GUARD_KEYS = ["vaultId", "ledgerRevision", "token", "reason", "recordedAt"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

/** A present but unreadable record is reported as corrupt, never as absent. */
export function readSettingsReview(storage: KeyValueStorage | null): SettingsReviewRead {
  if (!storage) return { status: "absent" };

  let raw: string | null;
  try {
    raw = storage.getItem(SETTINGS_REVIEW_STORAGE_KEY);
  } catch {
    return { status: "corrupt", raw: null };
  }
  if (raw === null) return { status: "absent" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: "corrupt", raw };
  }
  if (!isObject(parsed) || !hasExactKeys(parsed, GUARD_KEYS)) {
    return { status: "corrupt", raw };
  }
  if (typeof parsed.vaultId !== "string" || parsed.vaultId.length === 0) {
    return { status: "corrupt", raw };
  }
  if (
    typeof parsed.ledgerRevision !== "number" ||
    !Number.isSafeInteger(parsed.ledgerRevision) ||
    parsed.ledgerRevision < 1
  ) {
    return { status: "corrupt", raw };
  }
  if (
    typeof parsed.token !== "string" ||
    parsed.token.length < 8 ||
    parsed.token.length > 128
  ) {
    return { status: "corrupt", raw };
  }
  if (!REASONS.includes(parsed.reason as SettingsReviewReason)) {
    return { status: "corrupt", raw };
  }
  if (
    typeof parsed.recordedAt !== "string" ||
    Number.isNaN(Date.parse(parsed.recordedAt))
  ) {
    return { status: "corrupt", raw };
  }

  return {
    status: "valid",
    raw,
    guard: {
      vaultId: parsed.vaultId,
      ledgerRevision: parsed.ledgerRevision,
      token: parsed.token,
      reason: parsed.reason as SettingsReviewReason,
      recordedAt: parsed.recordedAt,
    },
  };
}

/** Write and verify the guard. A caller must not report a restore as successful if this is false. */
export function writeSettingsReview(
  storage: KeyValueStorage,
  guard: SettingsReviewGuard
): boolean {
  const encoded = JSON.stringify(guard);
  try {
    storage.setItem(SETTINGS_REVIEW_STORAGE_KEY, encoded);
    return storage.getItem(SETTINGS_REVIEW_STORAGE_KEY) === encoded;
  } catch {
    return false;
  }
}

/** Remove the guard and verify that the key is gone. */
export function clearSettingsReview(storage: SettingsReviewStorage): boolean {
  try {
    storage.removeItem(SETTINGS_REVIEW_STORAGE_KEY);
    return storage.getItem(SETTINGS_REVIEW_STORAGE_KEY) === null;
  } catch {
    return false;
  }
}

/** Unguessable restore identity used only to compare review/clear operations. */
export function newSettingsReviewToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `review-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
