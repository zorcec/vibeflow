import { describe, it, expect, beforeEach } from "vitest";
import { createHash, timingSafeEqual } from "node:crypto";

/** Replicate the timing-safe compare from mcp/auth.ts for direct testing. */
function tokensEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

describe("tokensEqual (timing-safe compare)", () => {
  it("returns true for matching tokens", () => {
    expect(tokensEqual("abc123", "abc123")).toBe(true);
  });

  it("returns false for different tokens", () => {
    expect(tokensEqual("abc123", "def456")).toBe(false);
  });

  it("returns false for different lengths", () => {
    expect(tokensEqual("abc", "abcdef")).toBe(false);
  });

  it("handles empty strings", () => {
    expect(tokensEqual("", "")).toBe(true);
  });

  it("handles single character", () => {
    expect(tokensEqual("a", "a")).toBe(true);
    expect(tokensEqual("a", "b")).toBe(false);
  });

  it("handles long tokens", () => {
    const long = "x".repeat(10000);
    expect(tokensEqual(long, long)).toBe(true);
    expect(tokensEqual(long, long + "y")).toBe(false);
  });
});

describe("isLoopbackOrigin", () => {
  let isLoopbackOrigin: (origin: string) => boolean;

  beforeEach(async () => {
    const mod = await import("../../../src/core/loopback.js");
    isLoopbackOrigin = mod.isLoopbackOrigin;
  });

  it.each([
    ["http://localhost:3700", true],
    ["http://localhost:3000", true],
    ["https://localhost:3700", true],
    ["http://127.0.0.1:8000", true],
    ["http://[::1]:3700", true],
    ["http://localhost.attacker.com", false],
    ["http://localhost.attacker.com:3700", false],
    ["https://evil.com", false],
    ["javascript:alert(1)", false],
    ["http://192.168.1.1:3700", false],
    ["ftp://localhost:21", false],
    ["", false],
  ])("isLoopbackOrigin(%s) === %s", (origin, expected) => {
    expect(isLoopbackOrigin(origin)).toBe(expected);
  });
});
