import { describe, it, expect } from "vitest";

import { parseTaskRecord, validateRecordDomain } from "../task-record";

const base = {
  schemaVersion: 1,
  id: "t1",
  title: "Hello",
  status: "todo",
  created: "2026-03-01T10:00:00Z",
};

describe("JSON domain (plan §2.5.2, R-DOM-1)", () => {
  it("accepts the complete in-domain set", () => {
    expect(validateRecordDomain({ ...base })).toEqual([]);
    // Fractional geometry under baseline.* only.
    expect(
      validateRecordDomain({
        ...base,
        baseline: {
          position: {
            boundingBox: { x: 119.80000305175781, y: 1.25 },
            dpr: 2,
          },
        },
      }),
    ).toEqual([]);
    // Numeric-looking keys, emoji, combining marks, U+007F.
    expect(
      validateRecordDomain({
        ...base,
        baseline: { "1": "a", "01": "b", "1e5": "c" },
        description: "héllo — 🌍 é ",
      }),
    ).toEqual([]);
    // 9-digit fractional timestamps pass the shape (schema enforces it).
    expect(
      parseTaskRecord({
        ...base,
        updated: "2026-03-05T12:34:56.123456789Z",
      }).ok,
    ).toBe(true);
  });

  it("rejects undefined as an own property (would hash like absent)", () => {
    const input: Record<string, unknown> = { ...base, updated: undefined };
    expect(
      validateRecordDomain(input).some((i) => i.code === "domain_undefined"),
    ).toBe(true);
  });

  it("rejects null anywhere", () => {
    expect(
      validateRecordDomain({ ...base, title: null }).some(
        (i) => i.code === "domain_null",
      ),
    ).toBe(true);
  });

  it("rejects array holes and undefined elements (stringify turns them into null)", () => {
    const holes: unknown[] = [1, 2];
    delete holes[1];
    expect(
      validateRecordDomain({ ...base, tags: holes }).length,
    ).toBeGreaterThan(0);
    expect(
      validateRecordDomain({ ...base, tags: [undefined] }).length,
    ).toBeGreaterThan(0);
  });

  it("rejects non-finite numbers", () => {
    for (const n of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        validateRecordDomain({ ...base, baseline: { x: n } }).length,
      ).toBeGreaterThan(0);
    }
  });

  it("rejects -0 (jsonb returns 0)", () => {
    expect(
      validateRecordDomain({ ...base, baseline: { x: -0 } }).some(
        (i) => i.code === "domain_neg_zero",
      ),
    ).toBe(true);
  });

  it("rejects integers outside Number.isSafeInteger", () => {
    expect(
      validateRecordDomain({
        ...base,
        baseline: { x: 2 ** 53 },
      }).length,
    ).toBeGreaterThan(0);
  });

  it("rejects exponent-notation numbers (1e-7, 1e21 change across a jsonb round-trip)", () => {
    expect(
      validateRecordDomain({ ...base, baseline: { x: 1e-7 } }).some(
        (i) => i.code === "domain_exponent",
      ),
    ).toBe(true);
    expect(
      validateRecordDomain({ ...base, baseline: { x: 1e21 } }).some(
        (i) => i.code === "domain_exponent",
      ),
    ).toBe(true);
  });

  it("rejects fractional numbers outside baseline.*", () => {
    expect(
      validateRecordDomain({ ...base, line: 1.5 }).length,
    ).toBeGreaterThan(0);
  });

  it("rejects NUL and lone surrogates in strings", () => {
    expect(
      validateRecordDomain({ ...base, title: "a\0b" }).some(
        (i) => i.code === "domain_string",
      ),
    ).toBe(true);
    expect(
      validateRecordDomain({ ...base, title: "a\ud800b" }).some(
        (i) => i.code === "domain_string",
      ),
    ).toBe(true);
  });

  it("rejects non-ISO timestamps (precision is part of the record)", () => {
    expect(
      parseTaskRecord({ ...base, created: "2026-03-01 10:00:00" }).ok,
    ).toBe(false);
    expect(
      parseTaskRecord({ ...base, created: "2026-03-01T10:00:00" }).ok,
    ).toBe(false);
  });
});
