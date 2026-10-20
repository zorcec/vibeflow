import { describe, it, expect } from "vitest";

import { canonicalJson, sha256Hex, hashTaskRecord } from "../delta-hash";

describe("canonicalJson", () => {
  it("is independent of key order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("sorts keys recursively, including inside arrays of objects", () => {
    const a = {
      z: { y: 1, x: 2 },
      list: [{ b: 1, a: 2 }, { d: 4, c: 3 }],
    };
    const b = {
      list: [{ a: 2, b: 1 }, { c: 3, d: 4 }],
      z: { x: 2, y: 1 },
    };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe(
      '{"list":[{"a":2,"b":1},{"c":3,"d":4}],"z":{"x":2,"y":1}}',
    );
  });

  it("keeps array order", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it("round-trips null, undefined, numbers, booleans and unicode strings", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson(42)).toBe("42");
    expect(canonicalJson(1.5)).toBe("1.5");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(false)).toBe("false");
    expect(canonicalJson("héllo — 🌍")).toBe('"héllo — 🌍"');
    expect(canonicalJson({ s: "héllo — 🌍" })).toBe(
      '{"s":"héllo — 🌍"}',
    );
    // undefined members are dropped by JSON.stringify, undefined array
    // entries become null — the same as the pre-existing implementation.
    expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
    expect(canonicalJson([undefined])).toBe("[null]");
  });
});

describe("sha256Hex", () => {
  it("matches the known sha256 vector for 'abc'", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("hashes raw bytes the same as the equivalent string", () => {
    const bytes = new TextEncoder().encode("abc");
    expect(sha256Hex(bytes)).toBe(sha256Hex("abc"));
  });
});

describe("hashTaskRecord", () => {
  it("ignores key order", () => {
    expect(hashTaskRecord({ id: "t1", title: "x", meta: { b: 1, a: 2 } })).toBe(
      hashTaskRecord({ meta: { a: 2, b: 1 }, title: "x", id: "t1" }),
    );
  });

  it("changes when a value changes", () => {
    expect(hashTaskRecord({ id: "t1", title: "x" })).not.toBe(
      hashTaskRecord({ id: "t1", title: "y" }),
    );
  });
});
