/**
 * Unit tests for the PAT shared primitives (P2, plan §4.2).
 *
 * Pure api-core assertions, no server boot: the `vbf_pat_` wire format
 * (positional parse — the base64url secret alphabet contains `_`, so a
 * separator split would misparse), the Settings access presets, and the
 * scope normalizer the token endpoints validate with.
 */

import { describe, it, expect } from "vitest";
import {
  PAT_READ_ONLY_SCOPES,
  PAT_READ_WRITE_SCOPES,
  PAT_SCHEME_PREFIX,
  extractBearerToken,
  extractPatPrefix,
  formatPatSecret,
  isPatFormat,
  normalizeTokenScopes,
  parsePatSecret,
} from "@vibeflow-tools/api-core";

const PREFIX = "9f2ca71b";
const SECRET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmno12";
// 26 + 9 + 8 = 43 base64url chars, includes no separator ambiguity.
const WELL_FORMED = `${PAT_SCHEME_PREFIX}${PREFIX}_${SECRET}`;

describe("PAT wire format", () => {
  it("parses a well-formed secret into prefix + secret part", () => {
    expect(parsePatSecret(WELL_FORMED)).toEqual({
      prefix: PREFIX,
      secretPart: SECRET,
    });
  });

  it("round-trips through the single construction site", () => {
    expect(formatPatSecret(PREFIX, SECRET)).toBe(WELL_FORMED);
    expect(parsePatSecret(formatPatSecret(PREFIX, SECRET))).toEqual({
      prefix: PREFIX,
      secretPart: SECRET,
    });
  });

  it("accepts a secret part containing base64url _ and -", () => {
    const tricky = `${PAT_SCHEME_PREFIX}${PREFIX}_${"_".repeat(21)}${"-".repeat(22)}`;
    const parsed = parsePatSecret(tricky);
    expect(parsed).not.toBeNull();
    expect(parsed?.prefix).toBe(PREFIX);
    expect(parsed?.secretPart).toHaveLength(43);
  });

  it("rejects malformed secrets as not-a-PAT (never an error to detail)", () => {
    const bad = [
      null,
      undefined,
      42,
      "",
      "Bearer abc",
      "vbf_pat_",
      `${PAT_SCHEME_PREFIX}short_abc`,
      `${PAT_SCHEME_PREFIX}ZZZZZZZZ_${SECRET}`,
      `${PAT_SCHEME_PREFIX}${PREFIX}_short`,
      `${PAT_SCHEME_PREFIX}${PREFIX}_${SECRET}extra`,
      `${PAT_SCHEME_PREFIX}${PREFIX}${SECRET}`,
      WELL_FORMED.slice(0, -1),
    ];
    for (const value of bad) {
      expect(parsePatSecret(value), JSON.stringify(value)).toBeNull();
      expect(isPatFormat(value)).toBe(false);
      expect(extractPatPrefix(value)).toBeNull();
    }
    expect(isPatFormat(WELL_FORMED)).toBe(true);
    expect(extractPatPrefix(WELL_FORMED)).toBe(PREFIX);
  });

  it("the construction site rejects bad parts loudly", () => {
    expect(() => formatPatSecret("short", SECRET)).toThrow();
    expect(() => formatPatSecret(PREFIX, "short")).toThrow();
  });

  it("chains with the bearer seam: Bearer header → PAT prefix", () => {
    const bearer = extractBearerToken(`Bearer ${WELL_FORMED}`);
    expect(bearer).toBe(WELL_FORMED);
    expect(extractPatPrefix(bearer)).toBe(PREFIX);
    expect(extractPatPrefix(extractBearerToken("Token abc"))).toBeNull();
  });
});

describe("PAT scope presets", () => {
  it("read-only holds every read scope and nothing else", () => {
    expect([...PAT_READ_ONLY_SCOPES].sort()).toEqual(
      [
        "comments:read",
        "files:read",
        "profile:read",
        "settings:read",
        "tasks:read",
      ].sort(),
    );
  });

  it("read-write holds every resource scope except tokens:manage", () => {
    expect(PAT_READ_WRITE_SCOPES).not.toContain("tokens:manage");
    for (const scope of [
      "tasks:read",
      "tasks:write",
      "comments:read",
      "comments:write",
      "files:read",
      "files:write",
      "settings:read",
      "settings:write",
      "profile:read",
    ] as const) {
      expect(PAT_READ_WRITE_SCOPES).toContain(scope);
    }
  });
});

describe("normalizeTokenScopes", () => {
  it("validates, dedupes, and returns contract order", () => {
    expect(
      normalizeTokenScopes(["tasks:write", "tasks:read", "tasks:read", "admin"]),
    ).toEqual(["tasks:read", "tasks:write"]);
  });

  it("passes tokens:manage through (granting is the route's decision)", () => {
    expect(normalizeTokenScopes(["tokens:manage"])).toEqual(["tokens:manage"]);
  });

  it("returns [] for non-array or fully unknown input", () => {
    expect(normalizeTokenScopes(null)).toEqual([]);
    expect(normalizeTokenScopes("tasks:read")).toEqual([]);
    expect(normalizeTokenScopes(["nope", 42])).toEqual([]);
  });
});
