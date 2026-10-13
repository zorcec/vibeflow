/**
 * Unit tests for the identity/scope layer (P1, plan §4.3).
 *
 * Pure api-core assertions, no server boot: the scope vocabulary, the
 * requireScope gate (including its 403 denial), the local trusted
 * principal, and the header parsers the cloud adapter builds on.
 */

import { describe, it, expect } from "vitest";
import {
  ALL_SCOPES,
  SCOPE_NAMES,
  ScopeDeniedError,
  ScopeHeaderError,
  extractBearerToken,
  isScopeName,
  parseScopeHeaderValue,
  requireScope,
  resolveLocalPrincipal,
} from "@vibeflow-tools/api-core";

describe("scope vocabulary", () => {
  it("covers the plan §1.2 resource set plus token management", () => {
    expect([...SCOPE_NAMES].sort()).toEqual(
      [
        "boards:read",
        "boards:write",
        "comments:read",
        "comments:write",
        "files:read",
        "files:write",
        "profile:read",
        "settings:read",
        "settings:write",
        "tasks:read",
        "tasks:write",
        "tokens:manage",
      ].sort(),
    );
    expect(ALL_SCOPES.size).toBe(SCOPE_NAMES.length);
  });

  it("isScopeName rejects non-vocabulary strings", () => {
    expect(isScopeName("tasks:read")).toBe(true);
    expect(isScopeName("token scopes")).toBe(false);
    expect(isScopeName("admin")).toBe(false);
    expect(isScopeName(null)).toBe(false);
  });
});

describe("requireScope gate", () => {
  it("passes when the principal holds the scope", () => {
    expect(() =>
      requireScope({ scopes: new Set(["tasks:read"]) }, "tasks:read"),
    ).not.toThrow();
  });

  it("denies with a 403 ScopeDeniedError when the scope is missing", () => {
    try {
      requireScope({ scopes: new Set(["tasks:read"]) }, "tasks:write");
      expect.unreachable("requireScope must throw on a missing scope");
    } catch (err) {
      expect(err).toBeInstanceOf(ScopeDeniedError);
      expect((err as ScopeDeniedError).status).toBe(403);
      expect((err as ScopeDeniedError).code).toBe("SCOPE_DENIED");
    }
  });

  it("denies an empty grant on every gated scope (non-vacuous: the gate is not pass-through)", () => {
    for (const scope of SCOPE_NAMES) {
      expect(() => requireScope({ scopes: new Set() }, scope)).toThrow(
        ScopeDeniedError,
      );
    }
  });

  it("passes public reads (null scope) even with an empty grant", () => {
    expect(() => requireScope({ scopes: new Set() }, null)).not.toThrow();
  });
});

describe("local trusted principal", () => {
  it("holds every scope on the local scope ref, with no token surface", () => {
    const p = resolveLocalPrincipal();
    expect(p.kind).toBe("local");
    expect(p.scope).toEqual({ kind: "local" });
    expect(p.userId).toBeUndefined();
    expect(p.tokenId).toBeUndefined();
    for (const scope of SCOPE_NAMES) {
      expect(p.scopes.has(scope), `local principal must hold ${scope}`).toBe(
        true,
      );
    }
    expect(() => requireScope(p, "tasks:write")).not.toThrow();
  });
});

describe("header parsers (cloud seam, P2)", () => {
  it("extractBearerToken takes the secret from a Bearer header only", () => {
    expect(extractBearerToken("Bearer abc123")).toBe("abc123");
    expect(extractBearerToken("bearer abc123")).toBeNull();
    expect(extractBearerToken("Bearer ")).toBeNull();
    expect(extractBearerToken(undefined)).toBeNull();
    expect(extractBearerToken(null)).toBeNull();
  });

  it("parseScopeHeaderValue defaults to local and takes a board id", () => {
    expect(parseScopeHeaderValue(undefined)).toEqual({ kind: "local" });
    expect(parseScopeHeaderValue("")).toEqual({ kind: "local" });
    expect(parseScopeHeaderValue("  ")).toEqual({ kind: "local" });
    expect(parseScopeHeaderValue("board-1")).toEqual({
      kind: "board",
      boardId: "board-1",
    });
  });

  it("parseScopeHeaderValue rejects control characters and oversize values", () => {
    for (const bad of ["a b", "a\tb", "a\nb", "x".repeat(257)]) {
      try {
        parseScopeHeaderValue(bad);
        expect.unreachable(`must reject ${JSON.stringify(bad)}`);
      } catch (err) {
        expect(err).toBeInstanceOf(ScopeHeaderError);
        expect((err as ScopeHeaderError).status).toBe(400);
      }
    }
  });
});
