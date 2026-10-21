/**
 * Canonical `TaskRecord` — the single strict, versioned task representation.
 *
 * Stage 1 (additive only): this module defines the schema and the pure
 * function boundary. No consumer is changed here; no I/O, no clock, no
 * `node:*` imports (the CLI browser bundle builds from the shared barrel,
 * so `node:crypto` here would break it — hashing lives in `./delta-hash`).
 *
 * Design notes (plan §2):
 * - `strict()`: unknown keys are REJECTED. An old reader must say
 *   "I cannot write this" rather than silently drop a key.
 * - There is NO `null` anywhere: absent is the only "no value" spelling.
 * - `type` is a FREE-FORM string. A user-written label (e.g. `Chore`) is
 *   data and must survive verbatim; only stringified artifacts
 *   (`[object Object]`), empties and non-strings read as absent.
 * - Two comment-text caps, deliberately different (B03): the *authoring*
 *   cap stays at 10,000 in `schemas.ts` (`createCommentSchema`); the
 *   *persisted* bound here is 1,000,000 so the three real historical texts
 *   (10,950 / 14,960 / 30,045 chars) migrate without truncation.
 * - `schemaVersion` bump policy (§2.4): any field-set change (even an
 *   additive optional field) bumps the version; writers write only the
 *   current version and refuse to write a record above it.
 */

import { z } from "zod";

/** Current canonical record version. Writers write only this version. */
export const TASK_RECORD_SCHEMA_VERSION = 1 as const;

/** Maximum persisted task description (product limit, shared with schemas.ts). */
export const TASK_RECORD_DESCRIPTION_MAX = 20_000 as const;

/**
 * Representational bound on a stored comment `text`. This is a jsonb
 * size guard, NOT an authoring limit: the authoring cap (`createCommentSchema`
 * / `updateCommentSchema`) stays at 10,000. Measured historical maximum is
 * 30,045 chars, so a 10,000 cap here would make three real comments
 * unmigratable.
 */
export const PERSISTED_COMMENT_TEXT_MAX = 1_000_000 as const;

/** Canonical status vocabulary (local hyphenated spelling + `cancelled`). */
export const TASK_RECORD_STATUSES = [
  "backlog",
  "todo",
  "in-progress",
  "review",
  "done",
  "cancelled",
] as const;

export type TaskRecordStatus = (typeof TASK_RECORD_STATUSES)[number];

/** Comment author vocabulary. */
export const TASK_RECORD_COMMENT_AUTHORS = ["user", "agent"] as const;

/** Comment `type` vocabulary. */
export const TASK_RECORD_COMMENT_TYPES = ["comment", "system"] as const;

/** Comment `source` vocabulary. */
export const TASK_RECORD_SOURCES = ["cli", "web"] as const;

/** Task link relationship vocabulary. */
export const TASK_RECORD_LINK_TYPES = ["parent", "relates", "blocks"] as const;

/** ISO-8601 UTC instant, stored verbatim (precision is part of the record). */
export const ISO_8601_UTC_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;

const isoUtc = (label: string) =>
  z
    .string()
    .regex(ISO_8601_UTC_RE, `${label} must be an ISO-8601 UTC instant (…Z)`);

/**
 * Email-ish validation for optional `authorEmail` attribution metadata.
 * Deliberately permissive (attribution, never a delivery address) but
 * rejects empty/whitespace strings and anything without a
 * `local@domain.tld` shape. Mirrors `isValidAuthorEmail` in CLI core/types
 * without creating a dependency (dependency direction stays cli → shared).
 */
export function isRecordAuthorEmail(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length <= 320 &&
    /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(v)
  );
}

const authorEmailField = z
  .string()
  .refine(isRecordAuthorEmail, "authorEmail must look like local@domain.tld");

// ── Child records ───────────────────────────────────────────────────────────

export const TaskLinkRecordSchema = z
  .object({
    taskId: z.string().min(1),
    type: z.enum(TASK_RECORD_LINK_TYPES),
  })
  .strict();

export type TaskLinkRecord = z.infer<typeof TaskLinkRecordSchema>;

export const TaskCommitRecordSchema = z
  .object({
    sha: z.string().min(1).max(255),
    message: z.string().max(2_000),
    timestamp: isoUtc("timestamp"),
    authorEmail: authorEmailField.optional(),
  })
  .strict();

export type TaskCommitRecord = z.infer<typeof TaskCommitRecordSchema>;

export const TaskCommentRecordSchema = z
  .object({
    schemaVersion: z.literal(TASK_RECORD_SCHEMA_VERSION),
    id: z.string().min(1).max(255),
    author: z.enum(TASK_RECORD_COMMENT_AUTHORS),
    text: z.string().min(1).max(PERSISTED_COMMENT_TEXT_MAX),
    files: z.array(z.string().max(500)).max(50).optional(),
    createdAt: isoUtc("createdAt"),
    updatedAt: isoUtc("updatedAt").optional(),
    type: z.enum(TASK_RECORD_COMMENT_TYPES).optional(),
    /** Tombstone: `true` keeps position. `false` is not a value. */
    deleted: z.literal(true).optional(),
    source: z.enum(TASK_RECORD_SOURCES).optional(),
    authorEmail: authorEmailField.optional(),
  })
  .strict();

export type TaskCommentRecord = z.infer<typeof TaskCommentRecordSchema>;

export const TaskFileRecordSchema = z
  .object({
    schemaVersion: z.literal(TASK_RECORD_SCHEMA_VERSION),
    name: z.string().min(1).max(500),
    addedAt: isoUtc("addedAt"),
    /** Local-only: absolute-path link, never materialised as a server row. */
    linkedPath: z.string().max(2_000).optional(),
    /** Never invented by a pull. */
    mimeType: z.string().max(100).optional(),
    system: z.literal(true).optional(),
  })
  .strict();

export type TaskFileRecord = z.infer<typeof TaskFileRecordSchema>;

// ── TaskRecord ──────────────────────────────────────────────────────────────

/**
 * `type` is free-form: any non-empty string round-trips verbatim
 * (e.g. `Chore`). Only values that can never be deliberate read as absent;
 * at the persisted-record boundary the stringified artifact
 * `[object Object]` is rejected so a writer cannot half-express a record
 * (read-for-display repairs it in memory instead, disk bytes untouched).
 */
const taskTypeField = z
  .string()
  .min(1)
  .max(255)
  .refine((v) => v !== "[object Object]", {
    message: 'type "[object Object]" is a stringified artifact, not a label',
  });

export const TaskRecordSchema = z
  .object({
    schemaVersion: z.literal(TASK_RECORD_SCHEMA_VERSION),
    id: z.string().min(1).max(255),
    title: z.string().min(1).max(255),
    description: z.string().max(TASK_RECORD_DESCRIPTION_MAX).optional(),
    status: z.enum(TASK_RECORD_STATUSES),
    type: taskTypeField.optional(),
    priority: z.string().max(50).optional(),
    selector: z.string().max(1_000).optional(),
    cssSelector: z.string().max(1_000).optional(),
    file: z.string().max(1_000).optional(),
    url: z.string().max(2_000).optional(),
    line: z.number().int().min(1).max(2_147_483_647).optional(),
    col: z.number().int().min(0).max(2_147_483_647).optional(),
    component: z.string().max(255).optional(),
    author: z.string().max(255).optional(),
    agent: z.string().max(255).optional(),
    model: z.string().max(255).optional(),
    branchName: z.string().max(255).optional(),
    reportBack: z.boolean().optional(),
    /** Tri-state by absence: true / false / absent. */
    verified: z.boolean().optional(),
    authorEmail: authorEmailField.optional(),
    /** Column is `text` (cap lives here, not in the column type). */
    annotatedElementText: z.string().max(20_000).optional(),
    sortKey: z.string().max(255).optional(),
    created: isoUtc("created"),
    updated: isoUtc("updated").optional(),
    /** Order preserved. */
    tags: z.array(z.string().max(50)).max(20).optional(),
    links: z.array(TaskLinkRecordSchema).max(200).optional(),
    commits: z.array(TaskCommitRecordSchema).max(100).optional(),
    /** Legacy singular SHA list (frozen); prefer `commits`. */
    commit: z.string().max(2_000).optional(),
    openedBy: z.array(z.string()).optional(),
    expandedBy: z.array(z.string()).optional(),
    /** Record-only (no projection column). */
    screenshot: z.string().max(500).optional(),
    /** Record-only (no projection column). */
    baselineElementFile: z.string().max(500).optional(),
    /** Record-only (no projection column). */
    baselineFile: z.string().max(500).optional(),
    /**
     * Record-only free-form DOM snapshot. Typed as `unknown` (not a strict
     * object) so embedded keys (e.g. `__proto__` inside `computedStyles`)
     * and fractional geometry survive parsing byte-identically; the JSON
     * domain walk below still validates every nested value.
     */
    // SAFETY: zod has no type-level spelling for "free-form JSON snapshot";
    // `z.unknown()` accepts the value unchanged at runtime and the cast only
    // restores the optional-wrapper type so the inferred TaskRecord field is
    // `unknown`. Domain validation (validateRecordDomain) checks the value.
    baseline: z.unknown().optional() as unknown as z.ZodOptional<z.ZodTypeAny>,
    comments: z.array(TaskCommentRecordSchema).optional(),
    files: z.array(TaskFileRecordSchema).optional(),
    /**
     * Legacy inline secret. Writers must extract it to the
     * `<id>.auth.json` sidecar and delete the key; the schema accepts it
     * only so existing records parse before extraction.
     */
    authStateEnc: z.string().min(1).optional(),
    /**
     * Runtime envelope (added in memory by `listTasksWithPaths`), never
     * part of the stored bytes. Accepted so a live object parses; writers
     * must not persist it inside the record file.
     */
    filePath: z.string().max(2_000).optional(),
    /** Task-level tombstone. `false` is not a value. */
    deleted: z.literal(true).optional(),
  })
  .strict();

export type TaskRecord = z.infer<typeof TaskRecordSchema>;

// ── Function boundary (no ZodType crosses a package boundary) ───────────────

export interface RecordIssue {
  path: string;
  code: string;
  message: string;
}

// ── JSON domain (R-DOM-1) ───────────────────────────────────────────────────
// Complete domain pinned by tests (plan §2.5.2):
// - object keys sort canonically; arrays keep their order (comment order is
//   meaningful), so `[a,b]` and `[b,a]` hash differently;
// - `undefined` as an own property is REJECTED (JSON.stringify would drop
//   it, making `{x: undefined}` and `{}` hash alike while the in-memory
//   objects differ). Absent is the only "no value" spelling — convert to
//   absent explicitly;
// - `null` anywhere in a record is REJECTED (absent is the spelling);
// - array holes / `undefined` elements are REJECTED (stringify → null);
// - non-finite numbers (NaN, ±Infinity) are REJECTED (not JSON);
// - `-0` is REJECTED (jsonb returns `0`, JSON prints `0` — not representable);
// - integers outside `Number.isSafeInteger` are REJECTED (PG `integer`
//   columns bind at ±2_147_483_647; larger values must never be silently
//   rounded);
// - non-integers whose `JSON.stringify` form uses exponent notation are
//   REJECTED (`1e-7` → jsonb `0.0000001`, `1e21` → `1000000000000000000000`;
//   both change the canonical text after a jsonb round-trip). Enforced as
//   `v === 0 || 1e-6 <= abs(v) < 1e21` for non-integers;
// - fractional numbers are allowed only under `baseline.*` (measured float
//   leaves, e.g. `119.80000305175781`, round-trip exactly);
// - strings with `\u0000` or lone surrogates are REJECTED (Postgres jsonb
//   cannot store NUL; a lone surrogate is not representable);
// - timestamps are stored verbatim; precision is part of the record;
// - all other Unicode (incl. emoji, combining marks, U+007F) is allowed,
//   byte-preserved, with NO NFC/NFD normalisation.

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function hasNulOrLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) return true;
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (Number.isNaN(n) || n < 0xdc00 || n > 0xdfff) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/**
 * Validate a parsed record against the JSON domain. Returns issues (empty
 * when the value is in-domain). Runs inside `parseTaskRecord` before any
 * hashing; a value outside the domain is an error, never a coercion.
 */
export function validateRecordDomain(value: unknown): RecordIssue[] {
  const issues: RecordIssue[] = [];
  const walk = (v: unknown, path: string): void => {
    if (v === undefined) {
      issues.push({
        path,
        code: "domain_undefined",
        message: `${path || "<root>"}: undefined is not in the JSON domain (use absent)`,
      });
      return;
    }
    if (v === null) {
      issues.push({
        path,
        code: "domain_null",
        message: `${path || "<root>"}: null is not in the JSON domain (use absent)`,
      });
      return;
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v)) {
        issues.push({
          path,
          code: "domain_number",
          message: `${path}: non-finite numbers are not JSON`,
        });
        return;
      }
      if (Object.is(v, -0)) {
        issues.push({
          path,
          code: "domain_neg_zero",
          message: `${path}: -0 is not representable (jsonb returns 0)`,
        });
        return;
      }
      if (!Number.isSafeInteger(v)) {
        // Exponent-notation guard first: `1e-7` stringifies as "1e-7" and
        // `1e21` as "1e+21" — both change across a jsonb round-trip
        // (jsonb `0.0000001` / `1000000000000000000000`). Checked on the
        // stringified form so integer-valued (1e21) and fractional (1e-7)
        // cases share one rule, exactly as §2.5.2 states it.
        if (/e[+-]/i.test(JSON.stringify(v))) {
          issues.push({
            path,
            code: "domain_exponent",
            message: `${path}: number would use exponent notation and change across a jsonb round-trip`,
          });
          return;
        }
        if (!Number.isInteger(v)) {
          // Non-integer without exponent form: allowed only under baseline.*.
          if (!path.startsWith("baseline")) {
            issues.push({
              path,
              code: "domain_fractional",
              message: `${path}: fractional numbers are allowed only under baseline.*`,
            });
          }
          return;
        }
        issues.push({
          path,
          code: "domain_unsafe_integer",
          message: `${path}: integer outside Number.isSafeInteger`,
        });
        return;
      }
      if (!Number.isInteger(v) && !path.startsWith("baseline")) {
        // Safe-range fractional outside baseline.* (e.g. `line: 1.5`).
        issues.push({
          path,
          code: "domain_fractional",
          message: `${path}: fractional numbers are allowed only under baseline.*`,
        });
      }
      return;
    }
    if (typeof v === "string") {
      if (hasNulOrLoneSurrogate(v)) {
        issues.push({
          path,
          code: "domain_string",
          message: `${path}: strings must not contain NUL or lone surrogates`,
        });
      }
      return;
    }
    if (typeof v === "boolean") return;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        if (!(i in v)) {
          issues.push({
            path: `${path}[${i}]`,
            code: "domain_hole",
            message: `${path}[${i}]: array holes are not in the JSON domain`,
          });
          continue;
        }
        walk(v[i], `${path}[${i}]`);
      }
      return;
    }
    if (isPlainObject(v) || typeof v === "object") {
      for (const key of Object.keys(v as Record<string, unknown>)) {
        const childPath = path ? `${path}.${key}` : key;
        walk((v as Record<string, unknown>)[key], childPath);
      }
      return;
    }
    issues.push({
      path,
      code: "domain_type",
      message: `${path || "<root>"}: value of type ${typeof v} is not in the JSON domain`,
    });
  };
  walk(value, "");
  return issues;
}

function zodIssuesToRecordIssues(err: z.ZodError): RecordIssue[] {
  return err.issues.map((i) => ({
    path: i.path
      .map((p) => String(p))
      .join(".")
      .replace(/\.(\d+)(?=\.|$)/g, "[$1]"),
    code: i.code,
    message: i.message,
  }));
}

export function parseTaskRecord(
  input: unknown,
): { ok: true; record: TaskRecord } | { ok: false; issues: RecordIssue[] } {
  const parsed = TaskRecordSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: zodIssuesToRecordIssues(parsed.error) };
  }
  const domainIssues = validateRecordDomain(parsed.data);
  if (domainIssues.length > 0) {
    return { ok: false, issues: domainIssues };
  }
  return { ok: true, record: parsed.data };
}

type CanonicalJsonValue =
  | string
  | number
  | boolean
  | null
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

function canonicalOrder(value: unknown): CanonicalJsonValue {
  if (Array.isArray(value)) return value.map(canonicalOrder);
  if (isPlainObject(value)) {
    // Null prototype: assigning `out["__proto__"]` on `{}` would invoke
    // the Object.prototype setter and LOSE the key (M02 collision:
    // `{"__proto__":"lost"}` hashed like `{}`). `Object.create(null)`
    // has no setter, so the key survives and the hashes differ.
    const out: Record<string, CanonicalJsonValue> = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalOrder(
        (value as Record<string, unknown>)[key],
      );
    }
    return out;
  }
  return value as CanonicalJsonValue;
}

/**
 * Canonical on-disk bytes: `JSON.stringify(canonicalKeyOrder(record), null, 2) + "\n"`.
 * One writer, one byte layout. Values-unchanged-but-non-canonical bytes may
 * be rewritten once; the hash is unaffected (canonicalJson equal).
 */
export function toCanonicalBytes(record: TaskRecord): string {
  return `${JSON.stringify(canonicalOrder(record), null, 2)}\n`;
}
