import { describe, it, expect } from "vitest";

import { canonicalJson, sha256Hex, hashTaskRecord } from "../delta-hash";
import { parseTaskRecord } from "../task-record";
import vectors from "./fixtures/task-record-hash-vectors.json";

interface Vector {
  name: string;
  record: unknown;
  canonical: string;
  hash: string;
}

function reverseTopLevel(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseTopLevel);
  if (typeof value === "object" && value !== null) {
    // Null prototype, like the serialiser: a `{}`-build would invoke the
    // Object.prototype setter on `__proto__` and lose the key (M02) — the
    // very collision this suite pins. The reversal must preserve it.
    const out: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(value as Record<string, unknown>).reverse()) {
      out[k] = reverseTopLevel(
        (value as Record<string, unknown>)[k],
      );
    }
    return out;
  }
  return value;
}

describe("task-record golden vectors (plan §2 + §14.1, finding M01)", () => {
  it("loads a non-empty serialised fixture set", () => {
    expect((vectors as Vector[]).length).toBeGreaterThan(0);
  });

  for (const v of vectors as Vector[]) {
    it(`vector ${v.name}: canonical bytes and sha256 match`, () => {
      expect(canonicalJson(v.record)).toBe(v.canonical);
      expect(sha256Hex(v.canonical)).toBe(v.hash);
    });

    it(`vector ${v.name}: round-trips through the schema with an identical hash`, () => {
      const parsed = parseTaskRecord(v.record);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(hashTaskRecord(parsed.record)).toBe(v.hash);
      }
    });

    it(`vector ${v.name}: hash is stable across key insertion order`, () => {
      expect(hashTaskRecord(reverseTopLevel(v.record))).toBe(v.hash);
    });
  }

  it("pins array ordering: comment order is meaningful (two orders hash differently)", () => {
    const vs = vectors as Vector[];
    const a = vs.find((v) => v.name === "comments-order-a");
    const b = vs.find((v) => v.name === "comments-order-b");
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a!.record).not.toEqual(b!.record);
    expect(a!.hash).not.toBe(b!.hash);
  });

  it("addresses M02: __proto__ inside computedStyles no longer collides with {}", () => {
    const vs = vectors as Vector[];
    const proto = vs.find((v) => v.name === "proto-in-computed-styles");
    expect(proto).toBeDefined();
    expect(proto!.canonical).toContain('"__proto__"');
    // The fixed serialiser keeps the key; the old `{}`-build lost it.
    expect(canonicalJson({ baseline: { computedStyles: {} } })).not.toBe(
      proto!.canonical,
    );
    expect(hashTaskRecord({ baseline: { computedStyles: {} } })).not.toBe(
      proto!.hash,
    );
  });
});
