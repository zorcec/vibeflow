import crypto from "node:crypto";

/** Capture shape from §7.1 — what the overlay stores in the browser. */
export interface AuthState {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }>;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
}

/** On-disk encryption envelope from §7.2. */
export interface EncryptedAuthState {
  version: number;
  createdAt: string;
  expiresAt: string;
  iv: string;
  tag: string;
  data: string;
}

const SALT = "vibeflow-auth-v1";
/** 24-hour TTL in milliseconds. */
const AUTH_TTL_MS = 24 * 60 * 60 * 1000;

/** Derive an AES-256 key from a task author name + fixed salt. */
function deriveKey(taskAuthor: string): Buffer {
  return crypto.scryptSync(taskAuthor, SALT, 32);
}

// ── Encryption (used by overlay → CLI server path) ────────────────────────

/** Encrypt an AuthState for on-disk storage. */
export function encryptAuthState(
  authState: AuthState,
  taskAuthor: string,
): EncryptedAuthState {
  const key = deriveKey(taskAuthor);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = JSON.stringify(authState);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + AUTH_TTL_MS).toISOString(),
    iv: iv.toString("hex"),
    tag: tag.toString("hex"),
    data: encrypted.toString("hex"),
  };
}

// ── Decryption (used by verify command) ───────────────────────────────────

/**
 * Decrypt an EncryptedAuthState back to AuthState.
 *
 * Returns `null` when:
 * - The TTL has expired (user must re-annotate)
 * - The ciphertext is corrupted or the key doesn't match
 */
export function decryptAuthState(
  encrypted: EncryptedAuthState,
  taskAuthor: string,
): AuthState | null {
  // Check expiry.
  if (new Date(encrypted.expiresAt) < new Date()) {
    return null;
  }

  try {
    const key = deriveKey(taskAuthor);
    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      key,
      Buffer.from(encrypted.iv, "hex"),
    );
    decipher.setAuthTag(Buffer.from(encrypted.tag, "hex"));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encrypted.data, "hex")),
      decipher.final(),
    ]);

    return JSON.parse(decrypted.toString()) as AuthState;
  } catch {
    // Corrupted data, wrong key, or GCM tag mismatch — all unrecoverable.
    return null;
  }
}
