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
 * the accepted bytes).
 *
 * The v0 create route carries the ACCEPTED raw record on an explicit
 * `record` member of the create response (verbatim `raw` the server
 * stored — client body plus backfilled id/links, sanitized, no merged
 * column defaults). When that member is present the clone persists it
 * VERBATIM — no mapper, no invented defaults (`description: ""`,
 * `selector: "/"`, stamped author, forced `comments: []` / `files: []`
 * are all dropped on this path; they were guesses about the old
 * server-synthesized raw and would hash differently from the stored raw).
 * Only two keys may be ADDED, both load-bearing for the local store and
 * both the same rule the pull merge applies to imported tasks:
 * `sortKey` (the raw carries none — the column default lives in the row,
 * not the record — and the local board needs one to order the row; minted
 * above the store ceiling with the ceiling cache invalidated afterwards)
 * and `created` (the writer shards files by date subdirectory and the raw
 * carries none; taken from the response `createdAt` column echo, falling
 * back to now). Both ARE hash inputs, so the next delta push re-sends the
 * clone exactly once and then converges — the price of a locally-minted
 * order key and file path, stated openly.
 *
 * OLDER SERVERS (no `record` member — write path predates the member):
 * fall back to `saasTaskToLocalRecord`, the response-view mapper, and WARN
 * LOUDLY on stderr that the clone is RECONSTRUCTED, not exact — never
 * silently pretend it is. A reconstructed clone converges after a push +
 * pull round-trip instead of being identical from birth.
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
 * The accepted record for the clone, plus whether it is the server's own
 * bytes. `exact` is true only when the create response carried the
 * explicit `record` member (a plain object with a string id) — that object
 * is returned by reference-adjacent spread (never mutated here) and the
 * caller persists it verbatim. Otherwise the response-view mapper
 * reconstructs the closest approximation and the caller must warn loudly.
 */
export function extractAcceptedRecord(task: SaasTask): {
  record: Record<string, unknown>;
  exact: boolean;
} {
  const candidate = asRecord(task).record;
  if (
    typeof candidate === "object" &&
    candidate !== null &&
    !Array.isArray(candidate) &&
    typeof (candidate as Record<string, unknown>).id === "string"
  ) {
    return { record: { ...(candidate as Record<string, unknown>) }, exact: true };
  }
  return { record: saasTaskToLocalRecord(task), exact: false };
}

/**
 * Persist the server-accepted task as its normal local `.json` record and
 * return the file path. Serialised under the same `.store-create` lock
 * `createTask` mints under, so a racing local create can never mint the
 * same `sortKey`. Best-effort is the CALLER's decision — this throws on
 * I/O failure so the caller can say so loudly instead of silently
 * diverging.
 *
 * Exact path (`record` member present): the accepted object is written
 * VERBATIM — the mapper's invented defaults are deleted on this path by
 * construction (the mapper is never called). Only `sortKey` and `created`
 * are filled when absent (see the module docstring for why those two are
 * load-bearing and what the one-push convergence cost is). Reconstructed
 * path (older server): the mapper output is written as before, plus a
 * LOUD stderr warning naming the clone reconstructed — the caller (and
 * the test) must never mistake it for exact.
 */
export function writeOnlineClone(projectDir: string, task: SaasTask): string {
  ensureTaskDirs(projectDir);
  const lock = taskLockPath(projectDir, ".store-create");
  return withFileLockSync(lock, () => {
    const { record, exact } = extractAcceptedRecord(task);
    if (!exact) {
      // LOUD, not silent: stderr keeps --json stdout pure while a human
      // sees the divergence risk. The fix is `vibeflow pull` (the export
      // carries the accepted record) followed by a push to converge.
      console.error(
        `⚠ Online task created, but the server did not return the accepted record (no \`record\` member on the create response) — the local clone is RECONSTRUCTED from the response view, not exact. Run 'vibeflow pull' to fetch the accepted bytes.`
      );
    }
    if (typeof record.sortKey !== "string" || record.sortKey.length === 0) {
      // No server-minted key on the accepted record: mint above the store
      // ceiling exactly like createTask, then invalidate the ceiling (the
      // pull merge's own rule for imported tasks) so the next create
      // rescans once instead of colliding with the minted key.
      const ceiling = maxStoreSortKey(projectDir);
      record.sortKey = generateSortKeyBetween(ceiling, null);
    }
    if (typeof record.created !== "string" || record.created.length === 0) {
      // The date-subdir writer requires `created`; the accepted raw carries
      // none (timestamps live in the row columns, not the record). Prefer
      // the response's own `createdAt` column echo over the local clock so
      // the clone shards under the server's creation date.
      record.created =
        typeof task.createdAt === "string" && task.createdAt.length > 0
          ? task.createdAt
          : new Date().toISOString();
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
