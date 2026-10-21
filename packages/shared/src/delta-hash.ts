/**
 * Shared hashing helpers for push-delta detection.
 *
 * WHY this lives in the shared package: the CLI computes a task-record hash
 * and the web server recomputes it from the stored `raw` jsonb to decide
 * whether a pushed task actually changed. Both sides MUST serialise a record
 * identically, so the serialisation is defined once, here, instead of being
 * re-implemented per repo (a drifted copy silently marks every task as
 * modified, or — worse — misses real changes).
 */

import { createHash } from "node:crypto";

/**
 * The JSON value space, plus `undefined`.
 *
 * `undefined` is included because it is what a missing/undefined property
 * serialises to: `JSON.stringify` DROPS undefined object members and turns
 * them into `null` inside arrays. The serialisation below must keep that
 * behaviour byte-for-byte, so `undefined` has to survive the walk.
 */
type JsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | JsonValue[]
  | { [key: string]: JsonValue };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Order-insensitive JSON identity.
 *
 * `raw` comes back from jsonb, which does NOT preserve key order, while
 * `JSON.stringify` does. Comparing the two directly marked every record as
 * changed, so a re-import rewrote the row and replaced its comments on every
 * push — "unchanged => zero writes" was never true. Sorting keys first makes
 * the comparison structural; arrays keep their order because comment order
 * is meaningful in the local store.
 */
export function canonicalJson(value: unknown): string {
  const walk = (v: unknown): JsonValue => {
    if (Array.isArray(v)) return v.map(walk) as JsonValue[];
    if (isObject(v)) {
      // Null prototype: assigning `out["__proto__"]` on `{}` would invoke
      // the Object.prototype setter and LOSE the key (M02: a record containing
      // `{"__proto__":"lost"}` hashed like one without it). Verified by
      // `task-record-hash.test.ts` (`__proto__` vector) and `json-domain.test.ts`.
      const out: Record<string, JsonValue> = Object.create(null);
      for (const key of Object.keys(v).sort()) out[key] = walk(v[key]);
      return out;
    }
    return v as JsonValue;
  };
  return JSON.stringify(walk(value ?? null));
}

/** Hex sha256 of a string or raw bytes. */
export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Content hash of a task record, stable under key reordering. */
export function hashTaskRecord(raw: unknown): string {
  return sha256Hex(canonicalJson(raw));
}
