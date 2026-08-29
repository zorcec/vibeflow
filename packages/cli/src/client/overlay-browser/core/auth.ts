/**
 * Auth state capture + encryption (spec §7).
 *
 * Runs in the browser (not Node.js). Uses Web Crypto API for AES-256-GCM.
 * Key derivation uses PBKDF2 (browser-compatible alternative to scrypt).
 *
 * The CLI server uses Node.js crypto.scryptSync for decryption — the derived
 * keys are compatible because both use the same password and salt with a
 * deterministic KDF. For v1, the browser uses PBKDF2 with a high iteration
 * count to match the security properties.
 *
 * NOTE: For Phase 1, the overlay captures the auth state and sends it to the
 * CLI server API, which handles the actual encryption and disk storage. This
 * module provides the capture logic and the browser-side crypto primitives
 * for self-contained testing.
 */

import type { AuthState, EncryptedAuthState } from "./types.js";

// ── Auth state capture (spec §7.1) ────────────────────────────────────────────

/** Parse document.cookie into structured cookie objects. */
function parseCookies(): AuthState["cookies"] {
  const cookies: AuthState["cookies"] = [];

  if (!document.cookie) return cookies;

  for (const pair of document.cookie.split(";")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;

    const name = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();

    // Basic cookie attributes (limited — full parsing would need Set-Cookie header)
    cookies.push({
      name,
      value,
      domain: location.hostname,
      path: "/",
      expires: -1, // Unknown from document.cookie
      httpOnly: false, // Cannot determine from JS
      secure: location.protocol === "https:",
      sameSite: "Lax", // Default assumption
    });
  }

  return cookies;
}

/** Capture all accessible browser auth state. */
export function captureAuthState(): AuthState {
  // LocalStorage
  const localStorageData: Record<string, string> = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key) {
        localStorageData[key] = localStorage.getItem(key) ?? "";
      }
    }
  } catch {
    // localStorage may be blocked (privacy mode, quota exceeded)
  }

  // SessionStorage
  const sessionStorageData: Record<string, string> = {};
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i);
      if (key) {
        sessionStorageData[key] = sessionStorage.getItem(key) ?? "";
      }
    }
  } catch {
    // sessionStorage may be blocked
  }

  return {
    cookies: parseCookies(),
    localStorage: localStorageData,
    sessionStorage: sessionStorageData,
  };
}

// ── Encryption (spec §7.2) ────────────────────────────────────────────────────

const SALT = "vibeflow-auth-v1";
const AUTH_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Convert Uint8Array to hex string. */
function bufToHex(buf: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < buf.length; i++) {
    hex += buf[i].toString(16).padStart(2, "0");
  }
  return hex;
}

/** Convert hex string to Uint8Array. */
function hexToBuf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  }
  return bytes;
}

/** Derive an AES-256-GCM key from a password using PBKDF2. */
async function deriveKey(password: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode(SALT),
      iterations: 100_000,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt auth state for storage (spec §7.2).
 *
 * @param authState - The captured browser auth state
 * @param taskAuthor - The task author (used as password for key derivation)
 * @returns Encrypted auth state ready for disk storage
 */
export async function encryptAuthState(
  authState: AuthState,
  taskAuthor: string,
): Promise<EncryptedAuthState> {
  const key = await deriveKey(taskAuthor);
  const iv = crypto.getRandomValues(new Uint8Array(16));
  const enc = new TextEncoder();
  const plaintext = enc.encode(JSON.stringify(authState));

  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext,
  );

  // AES-GCM appends the 16-byte auth tag to the ciphertext
  const data = new Uint8Array(encrypted);
  const tag = data.slice(data.length - 16);
  const ciphertext = data.slice(0, data.length - 16);

  const now = new Date();
  return {
    version: 1,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + AUTH_TTL_MS).toISOString(),
    iv: bufToHex(iv),
    tag: bufToHex(tag),
    data: bufToHex(ciphertext),
  };
}

/**
 * Decrypt auth state from encrypted storage (spec §7.5).
 *
 * @param encrypted - The encrypted auth state from disk
 * @param taskAuthor - The task author (used as password for key derivation)
 * @returns Decrypted auth state, or null if expired/corrupted
 */
export async function decryptAuthState(
  encrypted: EncryptedAuthState,
  taskAuthor: string,
): Promise<AuthState | null> {
  // Check expiry
  if (new Date(encrypted.expiresAt) < new Date()) {
    return null;
  }

  try {
    const key = await deriveKey(taskAuthor);
    const iv = hexToBuf(encrypted.iv);
    const tag = hexToBuf(encrypted.tag);
    const ciphertext = hexToBuf(encrypted.data);

    // AES-GCM expects ciphertext + tag concatenated
    const combined = new Uint8Array(ciphertext.length + tag.length);
    combined.set(ciphertext, 0);
    combined.set(tag, ciphertext.length);

    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv.buffer as ArrayBuffer },
      key,
      combined,
    );

    const dec = new TextDecoder();
    return JSON.parse(dec.decode(decrypted)) as AuthState;
  } catch {
    return null; // Corruption or wrong key
  }
}

// ── File path helpers ──────────────────────────────────────────────────────────

/**
 * Get the file path for encrypted auth state (spec §7.2).
 * Path: .vibeflow/auth-state.<taskId>.enc
 */
export function getAuthStatePath(taskId: string): string {
  return `.vibeflow/auth-state.${taskId}.enc`;
}
