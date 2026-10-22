/**
 * Clone mode (ticket 4efaa878): every task created while logged in (online
 * mode) is ALSO persisted in the local `.vibeflow` store as its normal
 * `.json` record, so the local copy exists for grep/diff/inspection offline
 * and the two stay identical.
 *
 * WHY the clone is written from the server response, never from the request:
 * the request is a partly-populated object (no `created`, no `comments` /
 * `files` arrays, no server defaults for `priority` / `type` / `selector`,
 * and a locally-minted id the server is free to replace). Re-deriving the
 * local record from it is exactly the divergence this ticket repairs: the
 * next `pull` would rewrite the file (the export carries the accepted
 * record) and the next `push` would re-upload it (the delta hash is over
 * the accepted bytes). The v0 create route answers the bare accepted task
 * (contract Task = local fields plus the external id, counts, and the
 * `createdAt` alias), so the response IS the accepted record — map it onto
 * local field names and write those bytes.
 *
 * WHY response-driven with omit-on-absent (no local defaults filled in):
 * the stored server `raw` cannot contain `null` (the shared TaskRecord
 * domain rejects it), so a `null`/absent answer means the key is absent
 * server-side too — inventing a local default (`"Medium"`) would hash
 * differently from the server raw and the next delta push would re-send
 * the task. Two exceptions, both proven by smoke: `description` and
 * `selector` default to `""` / `"/"` (the create view answers null while
 * the raw carries the defaults — see the mapper). `comments: []` /
 * `files: []` are forced: the pull merge ADDS a missing array (a rewrite),
 * while an explicit empty array deep-equals the export. `sortKey` is the
 * one locally-minted field
 * (the response carries none and the local board needs one to order the
 * row); it is minted above the store ceiling exactly like `createTask`
 * mints it, and the ceiling cache is invalidated afterwards — the same
 * rule the pull merge follows for imported tasks — so the next create
 * rescans once instead of minting a colliding key.
 *
 * SCOPE: online create only (`tasks --add` in saas mode, the single
 * `createSaasTask` call site). Online delete already drops the local
 * record(s) via `deleteTask` (index.ts delete path) — reused, not
 * duplicated. Online update does NOT clone (out of scope for this ticket;
 * see the residual risk in the suite docstring).
 */

import { generateSortKeyBetween } from "@vibeflow-tools/ui/kanban";
import { taskLockPath, withFileLockSync } from "../core/lock.js";
import type { Task } from "../core/types.js";
import {
  ensureTaskDirs,
  getTaskFilePath,
  invalidateSortKeyCeiling,
  maxStoreSortKey,
  writeTaskJson,
} from "../core/tasks.js";
import { toCliStatus, type SaasTask } from "./client.js";

/** Non-empty strings travel verbatim; anything else reads as absent. */
function presentString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  // SAFETY: v0 responses are parsed JSON bodies — plain objects, arrays and
  // scalars. Reading one through a Record view only restores key access the
  // SaasTask interface does not name (forward-tolerant extra keys); no value
  // is converted or trusted beyond the per-field guards below.
  return value as unknown as Record<string, unknown>;
}

/**
 * One v0 contract Comment (`{ id, author, text, createdAt, … }`) onto the
 * local comment shape. `author` is kept verbatim — open display labels
 * (e.g. `orchestrator`) are valid data, never a repair — and only known
 * local keys are carried; server-only keys never enter the file.
 */
function toLocalComment(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: typeof row.id === "string" ? row.id : "",
    author: typeof row.author === "string" ? row.author : "agent",
    text: typeof row.text === "string" ? row.text : "",
    createdAt:
      typeof row.createdAt === "string"
        ? row.createdAt
        : new Date().toISOString(),
  };
  if (presentString(row.type)) out.type = row.type;
  if (presentString(row.source)) out.source = row.source;
  return out;
}

/**
 * One v0 file row onto the local files[] entry. `addedAt` is required by
 * the local schema and the row carries no file timestamp, so the task's
 * own creation time stands in (a clone is born with its task). `mimeType`
 * is never invented — same rule the pull merge follows.
 */
function toLocalFileRef(
  row: Record<string, unknown>,
  taskCreatedAt: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: typeof row.name === "string" ? row.name : "",
    addedAt: taskCreatedAt,
  };
  if (row.system === true) out.system = true;
  return out;
}

/**
 * The server-accepted task (v0 contract Task) onto the local record bytes.
 * Pure: no I/O, no clock (except the comment fallback above, which only
 * fires on a malformed row the server never sends). Every optional is
 * omit-on-absent — see the module docstring for why filling defaults here
 * would break push convergence. Server-only keys (`boardId`,
 * `externalId`, `commentCount`, `fileCount`, id aliases) are dropped: the
 * server `raw` does not contain them (an import-pushed record round-trips
 * without them, so the export cannot carry them either), and adding them
 * would change the hash inputs.
 */
export function saasTaskToLocalRecord(task: SaasTask): Record<string, unknown> {
  const extra = asRecord(task);
  const record: Record<string, unknown> = {
    id: task.id,
    title: task.title,
    status: toCliStatus(task.status),
    created: task.createdAt,
    comments: Array.isArray(task.comments)
      ? task.comments.map((c) => toLocalComment(asRecord(c) ?? {}))
      : [],
    files: Array.isArray(task.files)
      ? task.files.map((f) => toLocalFileRef(asRecord(f) ?? {}, task.createdAt))
      : [],
  };
  // `description` / `selector`: the v0 create view answers `null` for both
  // even though the stored raw carries the server defaults (`""` and
  // `"/"`) — proven by smoke (ticket 4efaa878): the export record and
  // the inventory hash agree on a raw containing both, while the create
  // response that produced the clone showed nulls. The response nulls are
  // a lossy view, not raw state, so the clone reconstructs the documented
  // defaults instead of omitting the keys: omitting a stored value costs a
  // push resend on EVERY push under a merging import, while including a
  // default the raw lacks converges after a single push under both a
  // replacing and a merging import (the pull merge keeps local-only keys,
  // so pull stays clean either way). An explicit response string always
  // wins over the default.
  record.description =
    typeof task.description === "string" ? task.description : "";
  if (presentString(task.priority)) record.priority = task.priority;
  if (presentString(task.type)) record.type = task.type;
  record.selector = presentString(extra.selector)
    ? (extra.selector as string)
    : "/";
  if (presentString(task.author)) record.author = task.author;
  if (presentString(task.branchName)) record.branchName = task.branchName;
  if (typeof task.verified === "boolean") record.verified = task.verified;
  if (presentString(task.annotatedElementText))
    record.annotatedElementText = task.annotatedElementText;
  if (presentString(task.updatedAt)) record.updated = task.updatedAt;
  if (Array.isArray(task.links) && task.links.length > 0) {
    record.links = task.links.map((l) => {
      const row = asRecord(l);
      return {
        // Spread preserves unknown keys on the link entry — the mirror rule
        // the local store applies everywhere (see normalizeTask).
        ...row,
        taskId: String(row.taskId ?? ""),
        type: String(row.type ?? ""),
      };
    });
  }
  if (presentString(extra.sortKey)) record.sortKey = extra.sortKey;
  return record;
}

/**
 * Persist the server-accepted task as its normal local `.json` record and
 * return the file path. Serialised under the same `.store-create` lock
 * `createTask` mints under, so a racing local create can never mint the
 * same `sortKey`. Best-effort is the CALLER's decision — this throws on
 * I/O failure so the caller can say so loudly instead of silently
 * diverging.
 */
export function writeOnlineClone(projectDir: string, task: SaasTask): string {
  ensureTaskDirs(projectDir);
  const lock = taskLockPath(projectDir, ".store-create");
  return withFileLockSync(lock, () => {
    const record = saasTaskToLocalRecord(task);
    if (typeof record.sortKey !== "string" || record.sortKey.length === 0) {
      // No server-minted key on the response: mint above the store ceiling
      // exactly like createTask, then invalidate the ceiling (the pull
      // merge's own rule for imported tasks) so the next create rescans
      // once instead of colliding with the minted key.
      const ceiling = maxStoreSortKey(projectDir);
      record.sortKey = generateSortKeyBetween(ceiling, null);
    }
    // SAFETY: the record above holds exactly the local Task field set (id,
    // title, status, created, comments, files, plus response-driven
    // optionals); Task is that shape plus runtime-only keys, so the cast
    // only restores the writer's parameter type.
    writeTaskJson(projectDir, record as unknown as Task);
    invalidateSortKeyCeiling(projectDir);
    return getTaskFilePath(
      projectDir,
      String(record.id),
      String(record.created),
    );
  });
}
