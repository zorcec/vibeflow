/**
 * Response normalizer for the conformance battery (plan §6.1).
 *
 * Both surfaces are seeded from the same fixture, then each manifest entry is
 * issued against both and the responses are normalized and compared
 * byte-for-byte after normalization. Normalization strips volatile fields
 * (ids via a per-run id table, timestamps, storage URLs, git SHAs, sortKey)
 * and FAILS CLOSED: a field that appears on one side and is not in the
 * shape allowlist throws, so an unlisted divergence is a test failure rather
 * than a production discovery.
 *
 * Encoded resolutions (assertions, not prose):
 * - D6/status vocabulary: any status outside the canonical set (incl. the
 *   accepted 'cancelled') throws — a lossy read-map would surface here.
 * - Ledger L1/comment author: 'author' is allowlisted and asserted to be
 *   'user' | 'agent' — the normalizer must never strip or rewrite it.
 * - D3/external id: normalizeTask asserts a v1-shaped task carries BOTH
 *   'id' and 'externalId' when present (locally they are equal).
 */

import {
  COMMENT_AUTHORS,
  STATUS_VOCABULARY,
  VOLATILE_TASK_FIELDS,
  type JsonValue,
} from "./types.js";

export class NormalizeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NormalizeError";
  }
}

/** Per-run context: maps each surface's raw ids to a shared placeholder. */
export interface NormalizeContext {
  /** raw id -> stable placeholder ("<id:1>", "<id:2>", ...) */
  idTable: Map<string, string>;
}

export function createNormalizeContext(): NormalizeContext {
  return { idTable: new Map() };
}

function mapId(raw: unknown, ctx: NormalizeContext, field: string): string {
  if (typeof raw !== "string" || raw.length === 0) {
    throw new NormalizeError(`expected non-empty string id in ${field}`);
  }
  let mapped = ctx.idTable.get(raw);
  if (!mapped) {
    mapped = `<id:${ctx.idTable.size + 1}>`;
    ctx.idTable.set(raw, mapped);
  }
  return mapped;
}

function assertStatus(
  value: unknown,
  where: string,
): string {
  if (
    typeof value !== "string" ||
    !(STATUS_VOCABULARY as readonly string[]).includes(value)
  ) {
    throw new NormalizeError(
      `status ${JSON.stringify(value)} in ${where} is outside the v1 vocabulary ` +
        `(${(STATUS_VOCABULARY as readonly string[]).join(", ")})`,
    );
  }
  return value;
}

function assertAuthor(
  value: unknown,
  where: string,
): string {
  if (
    typeof value !== "string" ||
    !(COMMENT_AUTHORS as readonly string[]).includes(value)
  ) {
    throw new NormalizeError(
      `author ${JSON.stringify(value)} in ${where} must be preserved as ` +
        `"user" | "agent" (ledger L1) — got ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** Storage-URL shaped strings are volatile across surfaces. */
function scrubUrl(value: unknown): JsonValue {
  if (typeof value !== "string") return value as JsonValue;
  // Download URLs embed the task id and filename; keep the shape, drop identity.
  if (value.startsWith("/api/")) return "<local-url>";
  if (/^https?:\/\//.test(value)) return "<remote-url>";
  return value;
}

const VOLATILE = new Set<string>(VOLATILE_TASK_FIELDS as readonly string[]);

/**
 * Normalize one task record. `where` names the operation for error messages.
 * `strictV1` additionally requires the v1 envelope fields (id + externalId);
 * local Phase 0 reads run non-strict and record the delta in the manifest.
 */
export function normalizeTask(
  task: unknown,
  ctx: NormalizeContext,
  where: string,
  strictV1 = false,
): Record<string, JsonValue> {
  if (typeof task !== "object" || task === null || Array.isArray(task)) {
    throw new NormalizeError(`expected task object in ${where}`);
  }
  const input = task as Record<string, unknown>;
  const out: Record<string, JsonValue> = {};

  // Register the record's own id FIRST so identity precedes contents:
  // traversal order is then deterministic regardless of field order.
  if (typeof input["id"] === "string") {
    mapId(input["id"], ctx, `${where}.id`);
  }

  const allowed = new Set([
    "id",
    "externalId",
    "title",
    "description",
    "status",
    "url",
    "selector",
    "cssSelector",
    "file",
    "line",
    "col",
    "component",
    "type",
    "priority",
    "verified",
    "reportBack",
    "agent",
    "model",
    "author",
    "commits",
    "comments",
    "files",
    "screenshot",
    "annotatedElementText",
    "tags",
    "branchName",
    "baseline",
    "baselineElementFile",
    "baselineFile",
    "authStateEnc",
    "links",
    "openedBy",
    "expandedBy",
    "commentCount",
    "fileCount",
    ...VOLATILE,
  ]);

  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key)) {
      throw new NormalizeError(
        `task field ${JSON.stringify(key)} in ${where} is not in the ` +
          `normalizer allowlist — a one-sided field is a divergence, list it or drop it`,
      );
    }
    if (VOLATILE.has(key)) continue;
    out[key] = normalizeValue(key, value, ctx, `${where}.${key}`);
  }

  if (typeof out["id"] === "string") {
    out["id"] = mapId(out["id"], ctx, `${where}.id`);
  }
  if (input["externalId"] !== undefined) {
    if (typeof input["externalId"] !== "string") {
      throw new NormalizeError(`externalId in ${where} must be a string (D3)`);
    }
    out["externalId"] = mapId(
      input["externalId"],
      ctx,
      `${where}.externalId`,
    );
  } else if (strictV1) {
    throw new NormalizeError(
      `v1 task in ${where} must carry both id and externalId (D3)`,
    );
  }
  if (out["status"] !== undefined) {
    out["status"] = assertStatus(out["status"], `${where}.status`);
  }
  // Ledger L1: a task-level author string, when present, is asserted — never dropped.
  if (out["author"] !== undefined && typeof out["author"] === "string") {
    assertAuthor(out["author"], `${where}.author`);
  }
  return out;
}

function normalizeValue(
  key: string,
  value: unknown,
  ctx: NormalizeContext,
  where: string,
): JsonValue {
  if (key === "status") return assertStatus(value, where);
  if (key === "commits" && Array.isArray(value)) {
    return value.map((c): JsonValue => {
      if (typeof c !== "object" || c === null) return c as JsonValue;
      const { sha: _sha, timestamp: _ts, ...rest } = c as Record<
        string,
        unknown
      >;
      const scrubbed: Record<string, JsonValue> = {};
      for (const [k, v] of Object.entries(rest)) scrubbed[k] = scrubUrl(v);
      scrubbed["sha"] = "<sha>";
      scrubbed["timestamp"] = "<ts>";
      return scrubbed;
    });
  }
  if (key === "comments" && Array.isArray(value)) {
    return value.map((c) => normalizeComment(c, ctx, where));
  }
  if (key === "files" && Array.isArray(value)) {
    return value.map((f) => normalizeFileRef(f, ctx, where));
  }
  if (key === "links" && Array.isArray(value)) {
    return value.map((l): JsonValue => {
      if (typeof l !== "object" || l === null) return l as JsonValue;
      const rec = l as Record<string, unknown>;
      const scrubbed: Record<string, JsonValue> = {};
      for (const [k, v] of Object.entries(rec)) {
        scrubbed[k] =
          k === "taskId" && typeof v === "string"
            ? mapId(v, ctx, `${where}.links.taskId`)
            : scrubUrl(v);
      }
      return scrubbed;
    });
  }
  if (key === "url") return scrubUrl(value);
  if (Array.isArray(value)) {
    return value.map((v, i) =>
      typeof v === "object" && v !== null
        ? normalizeTask(v, ctx, `${where}[${i}]`)
        : scrubUrl(v),
    );
  }
  if (typeof value === "object" && value !== null) {
    const rec = value as Record<string, unknown>;
    const out: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(rec)) out[k] = scrubUrl(v);
    return out;
  }
  return value as JsonValue;
}

/** Normalize one comment — author is asserted preserved (ledger L1). */
export function normalizeComment(
  comment: unknown,
  ctx: NormalizeContext,
  where: string,
): Record<string, JsonValue> {
  if (typeof comment !== "object" || comment === null) {
    throw new NormalizeError(`expected comment object in ${where}`);
  }
  const input = comment as Record<string, unknown>;
  const allowed = new Set([
    "id",
    "author",
    "text",
    "files",
    "createdAt",
    "updatedAt",
    "type",
    "deleted",
    "source",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new NormalizeError(
        `comment field ${JSON.stringify(key)} in ${where} is not allowlisted`,
      );
    }
  }
  const out: Record<string, JsonValue> = {};
  if (typeof input["id"] === "string") {
    out["id"] = mapId(input["id"], ctx, `${where}.id`);
  }
  // Author MUST be present and preserved — stripping it would pass both sides
  // while the actor semantics differ (the exact L1 failure mode).
  if (input["author"] === undefined) {
    throw new NormalizeError(
      `comment in ${where} carries no author — actor semantics would be uncompared (ledger L1)`,
    );
  }
  out["author"] = assertAuthor(input["author"], `${where}.author`);
  if (typeof input["text"] === "string") out["text"] = input["text"];
  if (typeof input["type"] === "string") out["type"] = input["type"];
  if (typeof input["deleted"] === "boolean") out["deleted"] = input["deleted"];
  if (typeof input["source"] === "string") out["source"] = input["source"];
  if (Array.isArray(input["files"])) {
    out["files"] = (input["files"] as unknown[]).map((f) => scrubUrl(f));
  }
  return out;
}

/** Normalize one file entry — volatile size/mtime/url are scrubbed. */
export function normalizeFileRef(
  file: unknown,
  _ctx: NormalizeContext,
  where: string,
): Record<string, JsonValue> {
  if (typeof file !== "object" || file === null) {
    throw new NormalizeError(`expected file object in ${where}`);
  }
  const input = file as Record<string, unknown>;
  const allowed = new Set([
    "name",
    "size",
    "url",
    "linkedPath",
    "createdAt",
    "addedAt",
    "mimeType",
    "system",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) {
      throw new NormalizeError(
        `file field ${JSON.stringify(key)} in ${where} is not allowlisted`,
      );
    }
  }
  const out: Record<string, JsonValue> = {};
  if (typeof input["name"] === "string") out["name"] = input["name"];
  if (typeof input["mimeType"] === "string") out["mimeType"] = input["mimeType"];
  if (input["system"] !== undefined) out["system"] = input["system"] === true;
  if (input["linkedPath"] !== undefined) out["linkedPath"] = "<abs-path>";
  out["size"] = "<size>";
  if (input["url"] !== undefined) out["url"] = "<file-url>";
  return out;
}

/**
 * Normalize a full operation response envelope.
 * `shape` selects the envelope: task | task-list | comment-list |
 * file-list | project | me | settings | changelog | raw-bytes.
 */
export function normalizeResponse(
  shape: string,
  body: unknown,
  ctx: NormalizeContext,
  where: string,
): JsonValue {
  switch (shape) {
    case "task":
      return normalizeTask(body, ctx, where);
    case "task-list": {
      if (typeof body !== "object" || body === null) {
        throw new NormalizeError(`expected task-list object in ${where}`);
      }
      const rec = body as Record<string, unknown>;
      // v1 envelope { items, nextCursor } vs local { tasks: [...] } — accept
      // both in Phase 0; the manifest records which surface returns which.
      const items = Array.isArray(rec["items"])
        ? rec["items"]
        : Array.isArray(rec["tasks"])
          ? rec["tasks"]
          : null;
      if (!items) {
        throw new NormalizeError(
          `task-list in ${where} has neither { items } nor { tasks }`,
        );
      }
      const out: Record<string, JsonValue> = {
        items: items.map((t, i) => normalizeTask(t, ctx, `${where}[${i}]`)),
      };
      if (rec["nextCursor"] !== undefined) out["nextCursor"] = "<cursor>";
      return out;
    }
    case "comment-list": {
      if (typeof body !== "object" || body === null) {
        throw new NormalizeError(`expected comment-list object in ${where}`);
      }
      const rec = body as Record<string, unknown>;
      const items = Array.isArray(rec["items"])
        ? rec["items"]
        : Array.isArray(rec["comments"])
          ? rec["comments"]
          : null;
      if (!items) {
        throw new NormalizeError(
          `comment-list in ${where} has neither { items } nor { comments }`,
        );
      }
      return {
        items: items.map((c, i) => normalizeComment(c, ctx, `${where}[${i}]`)),
      };
    }
    case "file-list": {
      if (typeof body !== "object" || body === null) {
        throw new NormalizeError(`expected file-list object in ${where}`);
      }
      const rec = body as Record<string, unknown>;
      const items = Array.isArray(rec["items"])
        ? rec["items"]
        : Array.isArray(rec["files"])
          ? rec["files"]
          : null;
      if (!items) {
        throw new NormalizeError(
          `file-list in ${where} has neither { items } nor { files }`,
        );
      }
      return {
        items: items.map((f, i) => normalizeFileRef(f, ctx, `${where}[${i}]`)),
      };
    }
    case "project":
    case "me":
    case "settings":
    case "changelog": {
      if (typeof body !== "object" || body === null) {
        throw new NormalizeError(`expected ${shape} object in ${where}`);
      }
      const rec = body as Record<string, unknown>;
      const out: Record<string, JsonValue> = {};
      for (const [k, v] of Object.entries(rec)) {
        if (k === "projectDir" || k === "gitUserName") {
          out[k] = "<local>";
          continue;
        }
        out[k] = scrubUrl(v);
      }
      return out;
    }
    case "raw-bytes":
      return "<bytes>";
    default:
      throw new NormalizeError(`unknown response shape ${JSON.stringify(shape)}`);
  }
}
