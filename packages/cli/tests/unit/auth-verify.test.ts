import { describe, it, expect } from "vitest";
import { encryptAuthState, decryptAuthState } from "../../src/core/auth.js";
import type { AuthState } from "../../src/core/auth.js";

const sampleAuth: AuthState = {
  cookies: [
    {
      name: "session",
      value: "abc123",
      domain: "localhost",
      path: "/",
      expires: Date.now() + 86400000,
      httpOnly: false,
      secure: false,
      sameSite: "Lax",
    },
  ],
  localStorage: { token: "jwt-secret" },
  sessionStorage: { cart: "[]" },
};

describe("encryptAuthState / decryptAuthState", () => {
  it("round-trips auth state correctly", () => {
    const encrypted = encryptAuthState(sampleAuth, "alice");
    const decrypted = decryptAuthState(encrypted, "alice");
    expect(decrypted).toEqual(sampleAuth);
  });

  it("returns null when key does not match", () => {
    const encrypted = encryptAuthState(sampleAuth, "alice");
    const decrypted = decryptAuthState(encrypted, "bob");
    expect(decrypted).toBeNull();
  });

  it("returns null when expired", () => {
    const encrypted = encryptAuthState(sampleAuth, "alice");
    // Tamper with expiresAt to simulate expiry.
    encrypted.expiresAt = new Date(Date.now() - 1000).toISOString();
    const decrypted = decryptAuthState(encrypted, "alice");
    expect(decrypted).toBeNull();
  });

  it("returns null when data is corrupted", () => {
    const encrypted = encryptAuthState(sampleAuth, "alice");
    encrypted.data = "0000000000000000";
    const decrypted = decryptAuthState(encrypted, "alice");
    expect(decrypted).toBeNull();
  });

  it("returns null when IV is corrupted", () => {
    const encrypted = encryptAuthState(sampleAuth, "alice");
    encrypted.iv = "00000000000000000000000000000000";
    const decrypted = decryptAuthState(encrypted, "alice");
    expect(decrypted).toBeNull();
  });

  it("returns null when tag is corrupted", () => {
    const encrypted = encryptAuthState(sampleAuth, "alice");
    encrypted.tag = "00000000000000000000000000000000";
    const decrypted = decryptAuthState(encrypted, "alice");
    expect(decrypted).toBeNull();
  });

  it("produces different ciphertext for different authors", () => {
    const enc1 = encryptAuthState(sampleAuth, "alice");
    const enc2 = encryptAuthState(sampleAuth, "bob");
    expect(enc1.data).not.toBe(enc2.data);
  });

  it("handles empty cookies and storage", () => {
    const emptyAuth: AuthState = {
      cookies: [],
      localStorage: {},
      sessionStorage: {},
    };
    const encrypted = encryptAuthState(emptyAuth, "alice");
    const decrypted = decryptAuthState(encrypted, "alice");
    expect(decrypted).toEqual(emptyAuth);
  });

  it("sets version to 1", () => {
    const encrypted = encryptAuthState(sampleAuth, "alice");
    expect(encrypted.version).toBe(1);
  });

  it("sets createdAt and expiresAt as ISO strings", () => {
    const encrypted = encryptAuthState(sampleAuth, "alice");
    expect(new Date(encrypted.createdAt).toISOString()).toBe(encrypted.createdAt);
    expect(new Date(encrypted.expiresAt).toISOString()).toBe(encrypted.expiresAt);
  });

  it("expiresAt is approximately 24h after creation", () => {
    const before = Date.now();
    const encrypted = encryptAuthState(sampleAuth, "alice");
    const after = Date.now();
    const expiresMs = new Date(encrypted.expiresAt).getTime();
    // Allow 1 second tolerance for test execution time.
    expect(expiresMs).toBeGreaterThanOrEqual(before + 86400000 - 1000);
    expect(expiresMs).toBeLessThanOrEqual(after + 86400000 + 1000);
  });
});
