import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock browser globals ──────────────────────────────────────────────────────

function setupBrowserMocks() {
  vi.stubGlobal("crypto", {
    subtle: {
      importKey: vi.fn().mockResolvedValue({}),
      deriveKey: vi.fn().mockResolvedValue({}),
      encrypt: vi.fn().mockImplementation((_algo: unknown, _key: unknown, data: ArrayBuffer) => {
        // Return encrypted data: copy input + add 16-byte auth tag
        const input = new Uint8Array(data);
        const output = new Uint8Array(input.length + 16);
        output.set(input, 0);
        return output.buffer;
      }),
      decrypt: vi.fn().mockImplementation((_algo: unknown, _key: unknown, data: ArrayBuffer) => {
        // Return decrypted data: strip last 16 bytes (auth tag)
        const input = new Uint8Array(data);
        return input.slice(0, input.length - 16).buffer;
      }),
    },
    getRandomValues: vi.fn((arr: Uint8Array) => {
      for (let i = 0; i < arr.length; i++) arr[i] = i;
      return arr;
    }),
  });

  vi.stubGlobal("document", {
    cookie: "session_id=abc123; theme=dark",
    body: { outerHTML: "<body></body>" },
  });

  const lsStore: Record<string, string> = { token: "test-token" };
  vi.stubGlobal("localStorage", {
    getItem: vi.fn((key: string) => lsStore[key] ?? null),
    setItem: vi.fn((key: string, val: string) => { lsStore[key] = val; }),
    removeItem: vi.fn((key: string) => { delete lsStore[key]; }),
    key: vi.fn((i: number) => Object.keys(lsStore)[i] ?? null),
    length: Object.keys(lsStore).length,
  });

  vi.stubGlobal("sessionStorage", {
    getItem: vi.fn((key: string) => (key === "csrf" ? "token123" : null)),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    key: vi.fn((i: number) => (i === 0 ? "csrf" : null)),
    length: 1,
  });

  vi.stubGlobal("fetch", vi.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true }) }),
  ));

  vi.stubGlobal("window", {
    scrollX: 0,
    scrollY: 0,
    innerWidth: 1920,
    innerHeight: 1080,
    devicePixelRatio: 1,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    confirm: vi.fn(() => true),
  });

  vi.stubGlobal("navigator", { userAgent: "TestBrowser/1.0" });

  vi.stubGlobal("history", {
    pushState: vi.fn(),
    replaceState: vi.fn(),
  });

  vi.stubGlobal("location", { hostname: "localhost", protocol: "http:" });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("auth capture", () => {
  beforeEach(() => {
    setupBrowserMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("captureAuthState reads cookies", async () => {
    const { captureAuthState } = await import("../../src/client/overlay-browser/core/auth.js");
    const state = captureAuthState();
    expect(state.cookies).toBeInstanceOf(Array);
    expect(state.cookies.length).toBeGreaterThan(0);
    expect(state.cookies[0].name).toBe("session_id");
    expect(state.cookies[0].value).toBe("abc123");
  });

  it("captureAuthState reads localStorage", async () => {
    const { captureAuthState } = await import("../../src/client/overlay-browser/core/auth.js");
    const state = captureAuthState();
    expect(state.localStorage).toHaveProperty("token", "test-token");
  });

  it("captureAuthState reads sessionStorage", async () => {
    const { captureAuthState } = await import("../../src/client/overlay-browser/core/auth.js");
    const state = captureAuthState();
    expect(state.sessionStorage).toHaveProperty("csrf", "token123");
  });

  it("captureAuthState sets cookie domain from location", async () => {
    const { captureAuthState } = await import("../../src/client/overlay-browser/core/auth.js");
    const state = captureAuthState();
    expect(state.cookies[0].domain).toBe("localhost");
  });

  it("captureAuthState sets secure flag from protocol", async () => {
    const { captureAuthState } = await import("../../src/client/overlay-browser/core/auth.js");
    const state = captureAuthState();
    expect(state.cookies[0].secure).toBe(false); // http:
  });
});

describe("auth encryption", () => {
  beforeEach(() => {
    setupBrowserMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("encryptAuthState returns EncryptedAuthState shape", async () => {
    const { encryptAuthState } = await import("../../src/client/overlay-browser/core/auth.js");
    const authState = {
      cookies: [],
      localStorage: {},
      sessionStorage: {},
    };
    const encrypted = await encryptAuthState(authState, "testuser");
    expect(encrypted.version).toBe(1);
    expect(typeof encrypted.createdAt).toBe("string");
    expect(typeof encrypted.expiresAt).toBe("string");
    expect(typeof encrypted.iv).toBe("string");
    expect(typeof encrypted.tag).toBe("string");
    expect(typeof encrypted.data).toBe("string");
  });

  it("encryptAuthState sets 24h TTL", async () => {
    const { encryptAuthState } = await import("../../src/client/overlay-browser/core/auth.js");
    const authState = { cookies: [], localStorage: {}, sessionStorage: {} };
    const encrypted = await encryptAuthState(authState, "testuser");
    const created = new Date(encrypted.createdAt);
    const expires = new Date(encrypted.expiresAt);
    const diffMs = expires.getTime() - created.getTime();
    expect(diffMs).toBe(24 * 60 * 60 * 1000);
  });

  it("decryptAuthState returns decrypted AuthState", async () => {
    const { encryptAuthState, decryptAuthState } = await import("../../src/client/overlay-browser/core/auth.js");
    const authState = {
      cookies: [{ name: "sid", value: "xyz", domain: "localhost", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" as const }],
      localStorage: { key1: "val1" },
      sessionStorage: { key2: "val2" },
    };
    const encrypted = await encryptAuthState(authState, "testuser");
    const decrypted = await decryptAuthState(encrypted, "testuser");
    expect(decrypted).not.toBeNull();
    expect(decrypted!.cookies[0].name).toBe("sid");
    expect(decrypted!.localStorage).toHaveProperty("key1", "val1");
    expect(decrypted!.sessionStorage).toHaveProperty("key2", "val2");
  });

  it("decryptAuthState returns null for expired auth", async () => {
    const { decryptAuthState } = await import("../../src/client/overlay-browser/core/auth.js");
    const expired = {
      version: 1,
      createdAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-01-01T00:00:00.000Z",
      iv: "00000000000000000000000000000000",
      tag: "00000000000000000000000000000000",
      data: "00000000",
    };
    const result = await decryptAuthState(expired, "testuser");
    expect(result).toBeNull();
  });

  it("decryptAuthState returns null for wrong key", async () => {
    const { encryptAuthState, decryptAuthState } = await import("../../src/client/overlay-browser/core/auth.js");
    const authState = { cookies: [], localStorage: {}, sessionStorage: {} };
    const encrypted = await encryptAuthState(authState, "testuser");
    // Mock decrypt to throw for wrong key
    vi.stubGlobal("crypto", {
      subtle: {
        importKey: vi.fn().mockResolvedValue({}),
        deriveKey: vi.fn().mockResolvedValue({}),
        encrypt: vi.fn().mockImplementation((_algo: unknown, _key: unknown, data: ArrayBuffer) => {
          const input = new Uint8Array(data);
          const output = new Uint8Array(input.length + 16);
          output.set(input, 0);
          return output.buffer;
        }),
        decrypt: vi.fn().mockRejectedValue(new Error("Invalid key")),
      },
      getRandomValues: vi.fn((arr: Uint8Array) => arr),
    });
    const result = await decryptAuthState(encrypted, "wronguser");
    expect(result).toBeNull();
  });
});

describe("auth state path", () => {
  it("getAuthStatePath returns correct path", async () => {
    const { getAuthStatePath } = await import("../../src/client/overlay-browser/core/auth.js");
    expect(getAuthStatePath("abc123")).toBe(".vibeflow/auth-state.abc123.enc");
  });
});
