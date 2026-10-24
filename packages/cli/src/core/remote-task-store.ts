/**
 * Remote read adapter (ticket d7b9dc13, parent e7482da5) plus the truthful
 * remote CLAIM (ticket 6452504d) plus the authoritative remote WRITES
 * (ticket efcd6992, P4).
 *
 * The READ half of the `TaskStore` ports, backed by the online board instead
 * of the local files. Local MCP operations running under `mode: "saas"` read
 * through here, so they see the same source of truth the CLI's online paths
 * read — a stale local copy can never look current, and a remote failure
 * refuses instead of falling back to local files.
 *
 * P4 (ticket efcd6992): the create/update/comment writes are routed here
 * too, through `resolveWritePorts` — one POST/PATCH per call, awaited
 * before success is reported, with no local file on either success or
 * refusal. The CLI's online `--add`/`--edit` branches and the MCP write
 * tools converge on these methods, so both surfaces POST/PATCH the board
 * they resolved against. Field parity with the CLI's proven online wire:
 * create sends title/description/status/boardId/links only (identity is
 * server-stamped — no `author` member, exactly like the CLI); update
 * PATCHes the operation-computed merge as a whole-set replace; comments
 * POST `{text}` only. Extra server members the mapped `Task` cannot carry
 * (`record` for the CLI's offline clone, `warning` for the CLI's
 * passthrough) ride the returned task as NON-ENUMERABLE props — invisible
 * to JSON/MCP wire and to equality — read back through the accessors below.
 *
 * Conventions (all fail-closed):
 * - The board is resolved ONCE per call through `resolveBoardScope`
 *   (explicit flag → saved workspace → single-board auto-select). Zero
 *   boards, several boards with none selected, an unreachable listing, or a
 *   missing token all refuse — never a guessed board, never local files.
 * - Full-id reads are detail-first: exactly ONE detail request, zero board
 *   enumerations. A prefix falls back to ONE unhydrated listing resolved by
 *   the shared `resolveSaasTaskId` rule (exact wins, unique prefix resolves,
 *   ambiguity refuses with candidates). A row present in the listing that
 *   404s on detail REFUSES — a listed row never overrides an authoritative
 *   detail 404 (read-after-write races resolve to a refusal, not a guess).
 * - Successful envelopes are validated: a list page answering neither
 *   `items` nor `tasks` fails the read instead of resolving to an empty
 *   board, and a repeated pagination cursor fails instead of spinning to
 *   the cap (both handled in `saas/client.ts`, asserted here).
 * - The claim IS routed here (P3): `claimNextTaskAtomic` / `previewClaim`
 *   issue exactly ONE versioned agent-claim POST (`agentVersion: 1`) and
 *   map the answer — the client never lists, never filters, never PATCHes,
 *   so a claim can never succeed when the remote refused. Remaining
 *   unrouted mutations (delete, attach, maintenance) still throw
 *   `RemoteWriteNotRoutedError`, loudly, so a misrouted write fails instead
 *   of landing on the wrong backend (P5 owns them).
 */
import {
  addSaasComment,
  claimSaasTask,
  createSaasTask,
  fetchSaasTaskDetail,
  fetchSaasTasks,
  resolveSaasTaskId,
  toCliStatus,
  updateSaasTask,
  type SaasComment,
  type SaasTask,
} from "../saas/client.js";
import { buildAgentClaimRequest } from "@vibeflow-tools/api-core";
import { saasReadErrorMessage } from "../saas/failure.js";
import { resolveBoardScope } from "../auth/board-scope.js";
import type {
  ClaimOptions,
  ClaimPreview,
  OperationPorts,
  TaskCreateInput,
  TaskResolveOutcome,
  TaskStore,
  TaskUpdateInput,
} from "./task-store.js";
import type {
  FileInfo,
} from "./files.js";
import type {
  Task,
  TaskComment,
  TaskLink,
  TaskStatus,
} from "./types.js";
import {
  inspectLocalTaskRecord,
  type TaskReadFinding,
} from "./task-record-read.js";

/**
 * A remote read refused. Carries the operation-facing code so the operation
 * layer can forward it without relabelling: the code names the actual
 * failure (auth, scope, transport, server refusal, ambiguity), never a
 * catch-all. Operations map unknown throws to their own generic code; this
 * class is how the remote cause survives that mapping.
 */
export class RemoteReadError extends Error {
  readonly code: string;
  readonly suggestion?: string;
  readonly retryable?: boolean;
  constructor(code: string, message: string, opts?: { suggestion?: string; retryable?: boolean }) {
    super(message);
    this.name = "RemoteReadError";
    this.code = code;
    this.suggestion = opts?.suggestion;
    this.retryable = opts?.retryable;
  }
}

/**
 * A write reached the read-only remote adapter. Always a routing bug, never
 * a caller error — the message names the owning phase so the report lands
 * in the right place.
 */
export class RemoteWriteNotRoutedError extends Error {
  readonly code = "REMOTE_WRITE_NOT_ROUTED";
  constructor(method: string) {
    super(
      `Remote writes are not routed yet (P5 owns ${method}) — ${method} must run against the local ports`,
    );
    this.name = "RemoteWriteNotRoutedError";
  }
}

/** The board every request in one operation call carries. Empty means default. */
async function resolveBoardOnce(): Promise<string | undefined> {
  const boardId = await resolveBoardScope();
  return boardId ?? undefined;
}

function toRemoteRefusal(
  error: { code: string; message: string; status?: number; path?: string },
  fallbackSuggestion: string,
): RemoteReadError {
  if (error.code === "NOT_AUTHENTICATED") {
    return new RemoteReadError(
      "E_NOT_AUTHENTICATED",
      saasReadErrorMessage(error),
      {
        suggestion: "Run 'vibeflow auth login' and retry.",
        retryable: false,
      },
    );
  }
  if (error.status === 401 || error.status === 403) {
    return new RemoteReadError(
      "E_NOT_AUTHENTICATED",
      saasReadErrorMessage(error),
      {
        suggestion:
          "The token was rejected — run 'vibeflow auth login' and retry.",
        retryable: false,
      },
    );
  }
  if (error.code === "TASK_NOT_FOUND") {
    return new RemoteReadError("TASK_NOT_FOUND", error.message, {
      retryable: false,
    });
  }
  if (error.code === "BOARD_TRUNCATED") {
    return new RemoteReadError("BOARD_TRUNCATED", error.message, {
      suggestion: fallbackSuggestion,
      retryable: false,
    });
  }
  // P2 CLI-through-operations slice (ticket d7b9dc13): the CLI renders
  // operation refusals verbatim, so the refusal message is worded here with
  // the SAME formatter the CLI's inline paths used (`saasReadErrorMessage`:
  // "Online board read failed …" with status/path). The CLI envelope and
  // the MCP envelope then agree byte-for-byte on the message, and the
  // e2e refusal pins ("Online board read failed" on a dead host) hold
  // through the operations layer. Codes are unchanged — only the wording
  // is shared, never a local fallback.
  return new RemoteReadError(
    "E_BACKEND_UNAVAILABLE",
    saasReadErrorMessage(error),
    {
      suggestion: fallbackSuggestion,
      retryable: error.code === "NETWORK_ERROR",
    },
  );
}

/**
 * Write-side refusal mapping (ticket efcd6992, P4): the same fail-closed
 * ladder as reads, except a STRUCTURED server refusal keeps its own code
 * verbatim instead of hiding behind E_BACKEND_UNAVAILABLE. The server's
 * answer to a bad write (e.g. INVALID_LINKS for a dangling parent) is a
 * fact about the input — "retry" would never fix it — so CLI-online and
 * hosted MCP refuse identically on it, exactly like the CLI's inline
 * `--add`/`--edit` branches already did (`serverCode` passthrough).
 *
 * `retryable` is uniformly false: a write that failed for an unknown
 * reason (transport, 500) may or may not have landed, so inviting a retry
 * risks applying the mutation twice. Fix-and-resend (the suggestion) is
 * not a blind retry — it is a new, deliberate write.
 */
/**
 * Write-side refusal mapping, shared with the update operation's report
 * lifecycle (ticket efcd6992, P4 step 5): a structured server refusal
 * keeps its own code verbatim; anything else falls back to the read-side
 * ladder. Uniformly non-retryable — a failed write may or may not have
 * landed, so fix-and-resend is the only safe recovery.
 */
export function toRemoteWriteRefusal(
  error: {
    code: string;
    message: string;
    status?: number;
    path?: string;
    serverCode?: string;
    bodyHead?: string;
  },
  fallbackSuggestion: string,
): RemoteReadError {
  if (
    typeof error.serverCode === "string" &&
    error.serverCode.length > 0
  ) {
    return new RemoteReadError(error.serverCode, error.message, {
      suggestion: fallbackSuggestion,
      retryable: false,
    });
  }
  return toRemoteRefusal(error, fallbackSuggestion);
}

/**
 * Map one online record onto the local `Task` shape without inventing
 * defaults: every field comes from the server row, and fields the online
 * record has no spelling for are left absent (never zero/empty-string
 * guesses that would read as real data). `selector` is the one structural
 * exception — the local type requires it and the online record carries no
 * annotation — so it reads "/" (the root default), documented here rather
 * than hidden in a mapper.
 */
export function toLocalTask(row: SaasTask): Task | null {
  if (
    typeof row.id !== "string" ||
    row.id.length === 0 ||
    typeof row.title !== "string" ||
    typeof row.createdAt !== "string" ||
    row.createdAt.length === 0
  ) {
    return null;
  }
  const links: TaskLink[] | undefined = Array.isArray(row.links)
    ? row.links
        .filter(
          (l): l is { taskId: string; type: string } =>
            typeof l === "object" &&
            l !== null &&
            typeof (l as { taskId?: unknown }).taskId === "string" &&
            typeof (l as { type?: unknown }).type === "string",
        )
        .map((l) => ({ taskId: l.taskId, type: l.type }) as TaskLink)
    : undefined;
  const comments: TaskComment[] | undefined = Array.isArray(row.comments)
    ? row.comments.map((c) => ({
        id: c.id,
        author: (c.author === "user" || c.author === "agent" ? c.author : "agent") as TaskComment["author"],
        text: c.body,
        createdAt: c.createdAt,
      }))
    : undefined;
  const files = Array.isArray(row.files)
    ? row.files
        .filter((f) => typeof f?.name === "string" && f.name.length > 0)
        .map((f) => ({ name: f.name }) as Task["files"] extends Array<infer R> ? R : never)
    : undefined;
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? "",
    status: toCliStatus(row.status) as TaskStatus,
    selector: "/",
    created: row.createdAt,
    ...(row.type != null ? { type: row.type } : {}),
    ...(row.priority != null ? { priority: row.priority } : {}),
    ...(row.author != null ? { author: row.author } : {}),
    ...(typeof row.verified === "boolean" ? { verified: row.verified } : {}),
    ...(row.branchName != null ? { branchName: row.branchName } : {}),
    ...(row.annotatedElementText != null
      ? { annotatedElementText: row.annotatedElementText }
      : {}),
    ...(links && links.length > 0 ? { links } : {}),
    ...(comments && comments.length > 0 ? { comments } : {}),
    ...(files && files.length > 0 ? { files } : {}),
    ...(typeof row.commentCount === "number" ? { commentCount: row.commentCount } : {}),
    ...(typeof row.fileCount === "number" ? { fileCount: row.fileCount } : {}),
    // P2 CLI-through-operations slice (ticket d7b9dc13): the online
    // DETAIL contract travels with the mapped task so the CLI `--get`
    // renderer keeps its pinned raw-detail behaviour (parentId/children
    // pass through under the legacy `task` key ONLY when the server sent
    // them — never synthesised, never dropped when present). List rows
    // carry no detail relations, so nothing changes for listings.
    ...(row.parentId !== undefined ? { parentId: row.parentId } : {}),
    ...(Array.isArray(row.children) ? { children: row.children } : {}),
  } as Task;
}

/**
 * Ticket 38f085df: one v0 row against the SAME record schema the local
 * reader enforces (`inspectLocalTaskRecord`), so MCP list/get and
 * CLI-online agree on what a task IS — including the >20,000-character
 * description quarantine the CLI applies to local files.
 *
 * The v0 view is a projection, not a raw record: wire spellings are
 * normalized to record spellings first (`createdAt`→`created`,
 * `in_progress`→`in-progress`), and transport-only members (`boardId`,
 * comment/file counts, `files`, detail relations, comment `taskId` /
 * `authorId`) stay OUTSIDE the validated candidate and are reattached
 * unchanged by `toLocalTask` after it passes. Unknown statuses pass
 * through verbatim so strict parsing quarantines them instead of
 * silently coercing to `todo` the way display mapping does. Null
 * wire scalars are omitted silently (routine server data, not a local
 * repair worth a notice); everything else validates exactly as a local
 * record would.
 */
function saasRowToRecordCandidate(row: SaasTask): Record<string, unknown> {
  const candidate: Record<string, unknown> = {
    id: row.id,
    title: row.title,
  };
  if (typeof row.description === "string") candidate.description = row.description;
  if (typeof row.status === "string") {
    candidate.status = row.status === "in_progress" ? "in-progress" : row.status;
  }
  if (typeof row.type === "string") candidate.type = row.type;
  if (typeof row.priority === "string") candidate.priority = row.priority;
  if (typeof row.author === "string") candidate.author = row.author;
  if (typeof row.branchName === "string") candidate.branchName = row.branchName;
  if (typeof row.verified === "boolean") candidate.verified = row.verified;
  if (typeof row.annotatedElementText === "string") {
    candidate.annotatedElementText = row.annotatedElementText;
  }
  if (typeof row.createdAt === "string") candidate.created = row.createdAt;
  if (typeof row.updatedAt === "string") candidate.updated = row.updatedAt;
  if (Array.isArray(row.links)) candidate.links = row.links;
  if (Array.isArray(row.comments)) {
    candidate.comments = row.comments.map((c) => ({
      ...(typeof c.id === "string" ? { id: c.id } : {}),
      // Same coercion the display mapper applies: a server comment
      // without an author label still renders (as `agent`), so it
      // validates as one too — quarantine is for malformed records,
      // not for the server's default attribution.
      author:
        typeof c.author === "string" && c.author.length > 0 ? c.author : "agent",
      ...(typeof c.body === "string" ? { text: c.body } : {}),
      ...(typeof c.createdAt === "string" ? { createdAt: c.createdAt } : {}),
    }));
  }
  return candidate;
}

/** One board row through the shared record schema, with its notice payload. */
function inspectSaasTaskRecord(row: SaasTask): {
  ok: boolean;
  finding: TaskReadFinding;
} {
  const read = inspectLocalTaskRecord(saasRowToRecordCandidate(row));
  const id =
    typeof row.id === "string" && row.id.length > 0 ? row.id : "<unidentified>";
  return {
    ok: read.record !== null,
    finding: {
      id,
      quarantined: read.record === null,
      findings: read.findings,
      issues: read.issues,
    },
  };
}

/**
 * Validate a board snapshot the way the local listing does: quarantined
 * rows are excluded and reported through `reads` (the same
 * `TASK_RECORD_QUARANTINED` / `TASK_RECORD_REPAIRED` notices the CLI
 * renders), repaired rows are kept. Mirrors the local convention — a
 * finding is recorded exactly when the row is quarantined or carries
 * in-memory repairs.
 */
function validateSaasRows(
  rows: SaasTask[],
  reads: TaskReadFinding[] | undefined,
): { tasks: Task[]; quarantined: number } {
  const tasks: Task[] = [];
  let quarantined = 0;
  for (const row of rows) {
    const inspection = inspectSaasTaskRecord(row);
    if (!inspection.ok) {
      quarantined += 1;
      reads?.push(inspection.finding);
      continue;
    }
    const mapped = toLocalTask(row);
    if (!mapped) {
      // Unreachable for schema-passing rows (id/title/created are all
      // required non-empty by the schema), but never present a row the
      // mapper cannot express — fail closed with the same quarantine.
      quarantined += 1;
      reads?.push({
        ...inspection.finding,
        quarantined: true,
        issues: [
          ...inspection.finding.issues,
          {
            path: "",
            code: "unmappable_row",
            message: "Row passed record validation but does not map to a display task",
          },
        ],
      });
      continue;
    }
    if (inspection.finding.findings.length > 0) reads?.push(inspection.finding);
    tasks.push(mapped);
  }
  return { tasks, quarantined };
}

/** A detail response whose record does not validate is unreadable, never empty. */
function requireTask(row: SaasTask, taskId: string): Task {
  const inspection = inspectSaasTaskRecord(row);
  const mapped = inspection.ok ? toLocalTask(row) : null;
  if (!mapped) {
    const reasons = inspection.finding.issues
      .map((issue) => `${issue.path || "<root>"}: ${issue.message}`)
      .join("; ");
    throw new RemoteReadError(
      "REMOTE_MALFORMED_RECORD",
      `The board answered task ${taskId} with a record that does not parse — refusing rather than presenting it as current.${reasons ? ` (${reasons})` : ""}`,
      { retryable: false },
    );
  }
  return mapped;
}

/**
 * Server-only write effects that travel WITH the mapped task but never ON
 * the wire (ticket efcd6992, P4).
 *
 * `record` is the create route's accepted raw — the exact bytes the CLI's
 * offline clone persists verbatim (see `saas/clone.ts`) — and `warning` is
 * the board's bare-string passthrough the CLI surfaces top-level beside
 * its own `notices` array. Neither fits the portable `Task` shape, and
 * both must stay invisible to the MCP wire (which never knew them), so
 * they ride as NON-ENUMERABLE props: `JSON.stringify` drops them, `toEqual`
 * ignores them, and only the CLI write renderer reads them back through
 * the accessors below. Set immediately after mapping, before the task
 * leaves the adapter — never re-attached downstream.
 */
const SAAS_RAW = Symbol.for("vibeflow.saasRaw");
const SAAS_WARNING = Symbol.for("vibeflow.saasWarning");

function attachWriteEffects(
  task: Task,
  raw: SaasTask,
  warning?: string,
): Task {
  Object.defineProperty(task, SAAS_RAW, {
    value: raw,
    enumerable: false,
    writable: false,
  });
  if (typeof warning === "string" && warning.length > 0) {
    Object.defineProperty(task, SAAS_WARNING, {
      value: warning,
      enumerable: false,
      writable: false,
    });
  }
  return task;
}

/** The accepted server record stashed by the remote write, if any. */
export function getSaasRaw(task: Task): SaasTask | undefined {
  // SAFETY: the adapter stashes the raw server row under SAAS_RAW via
  // defineProperty on the very object it returns — a Task carries no symbol
  // keys of its own, so the read below recovers exactly what was stashed.
  return (task as unknown as Record<symbol, unknown>)[SAAS_RAW] as
    | SaasTask
    | undefined;
}

/** The board's `warning` passthrough stashed by the remote write, if any. */
export function getSaasWarning(task: Task): string | undefined {
  // SAFETY: same stash contract as getSaasRaw — SAAS_WARNING is only ever
  // defined by attachWriteEffects on tasks this adapter returned.
  const warning = (task as unknown as Record<symbol, unknown>)[
    SAAS_WARNING
  ];
  return typeof warning === "string" ? warning : undefined;
}

/** One v0 comment row onto the local comment shape (server stamps identity). */
function toLocalComment(row: SaasComment): TaskComment {
  return {
    id: row.id,
    author: (row.author === "user" || row.author === "agent"
      ? row.author
      : "agent") as TaskComment["author"],
    text: row.body,
    createdAt: row.createdAt,
  };
}


/**
 * Prefix fallback: ONE unhydrated listing, resolved by the shared id rule.
 * Ambiguity refuses with the candidates; an unknown value reports missing
 * (the caller decides miss vs refusal); a resolved full id is read back as
 * one detail request, and a detail 404 on that id REFUSES — the listing
 * row never overrides the authoritative detail answer.
 */
async function resolvePrefix(
  boardId: string | undefined,
  raw: string,
): Promise<
  | { outcome: "resolved"; task: Task }
  | { outcome: "missing"; id: string }
  | { outcome: "unreadable"; id: string }
> {
  // Deliberately UNFILTERED (LANE Q step 2, kept ticket 05076246): a prefix
  // can match a task of any status, so a status-narrowed fetch could miss
  // the very row the prefix names — and a `?sort=kanban&limit=K` page could
  // miss it too (the row may sit below the first page). Prefix resolution
  // always reads the whole board, never a narrowed or top-K page.
  const board = await fetchSaasTasks(boardId, { hydrate: false });
  if (!board.ok) {
    throw toRemoteRefusal(board.error, "Check the backend is reachable and retry the read.");
  }
  const rows = board.data.tasks;
  // Ticket 38f085df: a prefix resolves over validated rows only — a
  // quarantined row must never win an id match (the detail read would
  // refuse it anyway), and a ghost id keeps its `missing` answer.
  const valid = rows.filter((r) => inspectSaasTaskRecord(r).ok && toLocalTask(r) !== null);
  const resolved = resolveSaasTaskId(
    valid.map((r) => ({ id: r.id })),
    raw,
  );
  if (!resolved.ok) {
    if (resolved.code === "E_AMBIGUOUS") {
      throw new RemoteReadError("E_AMBIGUOUS", resolved.message, {
        suggestion: "Use the full task id — run 'vibeflow tasks' to see available task IDs.",
        retryable: false,
      });
    }
    return { outcome: "missing", id: raw };
  }
  const detail = await fetchSaasTaskDetail(resolved.id);
  if (!detail.ok) {
    // Deleted between the listing read and the detail request — or a
    // read-after-write race where the listing carries a row detail does
    // not know. Either way the detail answer is authoritative: refuse,
    // never render the listed row as if it were current.
    throw toRemoteRefusal(
      detail.error.code === "TASK_NOT_FOUND"
        ? { ...detail.error, message: `Task not found: ${raw}` }
        : detail.error,
      "The board changed during the read — retry it.",
    );
  }
  // A row that validated in the listing but answers an invalid detail
  // changed mid-read: unreadable, like the detail-first path above.
  try {
    return { outcome: "resolved", task: requireTask(detail.data.task, resolved.id) };
  } catch (err) {
    if (err instanceof RemoteReadError && err.code === "REMOTE_MALFORMED_RECORD") {
      return { outcome: "unreadable", id: resolved.id };
    }
    throw err;
  }
}

/**
 * Map a claim refusal to the operation-facing error. `AGENT_VERSION_UNKNOWN`
 * is the specific old-server refusal (update the server, never work around
 * it); every other claim failure travels verbatim like a read refusal.
 */
function toRemoteClaimRefusal(
  error: { code: string; message: string; status?: number; path?: string },
): RemoteReadError {
  if (error.code === "AGENT_VERSION_UNKNOWN") {
    return new RemoteReadError("REMOTE_CLAIM_UNSUPPORTED", error.message, {
      suggestion:
        "The board does not speak agent claim v1 — update the server, then retry. The claim was NOT made.",
      retryable: false,
    });
  }
  return toRemoteRefusal(error, "Check the backend is reachable and retry the claim.");
}

/**
 * Remote `TaskStore`: reads plus the truthful agent claim (P3). Reads and
 * the claim resolve the board once and refuse loudly on any failure —
 * local files are never consulted here. Every OTHER method that would
 * write throws `RemoteWriteNotRoutedError` (P4 owns the remaining remote
 * mutations), so a misrouted write fails instead of landing on the wrong
 * backend.
 */
/**
 * Statuses the v0 list can narrow server-side with a predicate EQUAL to
 * the client's (`?status=` → storage equality on the normalized status).
 * Verified against the server's list route: `isAcceptedStatus` accepts the
 * hyphenated wire spelling, `canonicalStatus`/`toStorageStatus` normalize
 * it, and `listV0TaskPage` matches on storage — so for these four the
 * narrowed set is exactly what client-side filtering would keep.
 *
 * `done` is DELIBERATELY absent: `?status=done` matches storage `done`
 * only, while the client maps wire `cancelled` to `done` (toCliStatus) and
 * would keep those rows — pushing `done` would silently drop them. The
 * per-filter path table (ticket 05076246: `?sort=kanban&limit=K` top-K plus
 * LANE Z `?scope=roots` — the step-3 contracts this comment promised):
 * - status backlog/todo/in-progress/review → server-side `?status=`, pages
 *   only over the matching set (provably exhausted via nextCursor, same
 *   rows the full scan would filter to). With `sort: "kanban"` + a positive
 *   `limit` AND a child-inclusive scope this becomes ONE `?sort=kanban
 *   &limit=K` request returning the client's first page exactly (same-row
 *   pinned): a filtered search includes children by contract, so the
 *   server's peer scope matches the client's;
 * - unfiltered `--children` + `sort: "kanban"` + limit → ONE `?sort=kanban
 *   &limit=K` request (no `?status=`): the scope is the whole board on both
 *   sides, so the ordering contract applies directly;
 * - status done → FULL SCAN (`?status=done` would silently drop the
 *   storage-cancelled rows the client maps to done);
 * - type/user/tag filters → FULL SCAN (v0 has no param for them — a
 *   narrowed fetch could miss a row the client-side filter would keep);
 * - root-only scope (the DEFAULT unfiltered listing, no `--children`, no
 *   filters) + `sort: "kanban"` + limit → ONE `?scope=roots&sort=kanban
 *   &limit=K` request returning the client's first root page exactly
 *   (same-row pinned, LANE Z proof): the server's ROOTS_ONLY_COND is the
 *   server image of the client's root-only filter, and page + COUNT share
 *   the predicate so the total is a root count;
 * - unfiltered listings that do NOT request the kanban sort → FULL SCAN
 *   (historical createdAt-desc order and cost, unchanged);
 * - prefix resolution → FULL SCAN, always unfiltered (a prefix can name a
 *   task of any status, so a status-narrowed fetch could miss it — and a
 *   top-K page could miss a row below the first page).
 */
export const SERVER_PUSHABLE_STATUSES: ReadonlySet<string> = new Set([
  "backlog",
  "todo",
  "in-progress",
  "review",
]);

class RemoteTaskStore implements TaskStore {
  async listTasks(
    _projectDir?: string,
    _reads?: unknown,
    preFilter?: { status?: string; sort?: "kanban"; limit?: number; scope?: "roots"; children?: boolean },
  ): Promise<Task[]> {
    const boardId = await resolveBoardOnce();
    // Push the status only when predicate-equal (see
    // SERVER_PUSHABLE_STATUSES): the caller still filters/sorts/limits
    // client-side, so a narrowed fetch converges to the identical answer.
    // Anything else (done, unknown, absent) reads the whole board.
    const status =
      preFilter?.status !== undefined &&
      SERVER_PUSHABLE_STATUSES.has(preFilter.status)
        ? preFilter.status
        : undefined;
    // Ticket 05076246 top-K (+ LANE Z scope): forward `sort: "kanban"` +
    // `limit` (+ `scope: "roots"` for the root-only listing) ONLY where the
    // server's scope matches the client's. Every other shape falls back to
    // the full scan below, with the reason named at the decision point:
    // - root-only (no `children`, no status filter) → `scope: "roots"` +
    //   sort + limit (ONE request): ROOTS_ONLY_COND is the server image of
    //   the client's root-only filter, page + COUNT share the predicate;
    // - child-inclusive scope (`children: true`, or a status filter which
    //   implies children by the shared listing contract) over a
    //   pushable-or-absent status → sort + limit WITHOUT scope (ONE
    //   request): peers on both sides. `scope=roots` is NEVER combined with
    //   a status filter — narrowing a child-including search to roots would
    //   silently drop matching children;
    // - `done` (or an unknown status the pushable set excludes) → the
    //   narrowed set is not predicate-equal (cancelled rows would drop);
    // - a non-kanban/absent sort or a non-positive/non-integer limit → no
    //   ordering contract to honour, so a row cap would return wrong rows.
    const scopeIncludesChildren =
      preFilter?.children === true ||
      (preFilter?.status !== undefined && preFilter.status !== "");
    const statusEligible =
      preFilter?.status === undefined ||
      preFilter.status === "" ||
      SERVER_PUSHABLE_STATUSES.has(preFilter.status);
    const limitEligible =
      preFilter?.sort === "kanban" &&
      typeof preFilter?.limit === "number" &&
      Number.isInteger(preFilter.limit) &&
      (preFilter.limit as number) >= 1 &&
      (preFilter.limit as number) <= 500;
    // Root-only top-K: no status filter, no children flag, scope=roots.
    const rootsTopK =
      limitEligible &&
      preFilter?.scope === "roots" &&
      preFilter?.status === undefined &&
      preFilter?.children !== true
        ? (preFilter.limit as number)
        : null;
    // Peers top-K: child-inclusive scope, pushable-or-absent status, never
    // with scope=roots (see above).
    const peersTopK =
      rootsTopK === null &&
      limitEligible &&
      preFilter?.scope !== "roots" &&
      scopeIncludesChildren &&
      statusEligible
        ? (preFilter.limit as number)
        : null;
    const topK = rootsTopK ?? peersTopK;
    const board = await fetchSaasTasks(boardId, {
      hydrate: false,
      ...(status !== undefined ? { status } : {}),
      ...(topK !== null ? { sort: "kanban" as const, limit: topK } : {}),
      ...(rootsTopK !== null ? { scope: "roots" as const } : {}),
    });
    if (!board.ok) {
      throw toRemoteRefusal(board.error, "Check the backend is reachable and retry the read.");
    }
    // A list row that does not validate is SKIPPED, not fatal: one
    // malformed row must not hide the whole board (detail reads stay
    // strict — presenting one current record demands a parseable answer).
    // Quarantined rows still fill `reads` so the operation layer renders
    // the same TASK_RECORD_QUARANTINED notice the CLI shows for local files.
    const reads = Array.isArray(_reads) ? (_reads as TaskReadFinding[]) : undefined;
    let validated = validateSaasRows(board.data.tasks, reads);
    if (topK !== null && validated.quarantined > 0) {
      // Exceptional case: a top-K page containing invalid rows would
      // silently hide valid rows below the page. Fall back to the full
      // paginated read, validate first, then let the shared listing model
      // page it — the normal one-request fast path is preserved for
      // valid data. Findings from the discarded attempt are dropped so
      // the notice names each bad row exactly once.
      const attemptFindings = reads?.length ?? 0;
      const full = await fetchSaasTasks(boardId, {
        hydrate: false,
        ...(status !== undefined ? { status } : {}),
      });
      if (!full.ok) {
        throw toRemoteRefusal(full.error, "Check the backend is reachable and retry the read.");
      }
      if (reads) reads.splice(reads.length - attemptFindings, attemptFindings);
      validated = validateSaasRows(full.data.tasks, reads);
    }
    return validated.tasks;
  }

  async getTask(_projectDir: string, idOrPrefix: string): Promise<Task | undefined> {
    const outcome = await this.resolveTask(_projectDir, idOrPrefix);
    return outcome.status === "found" ? outcome.task : undefined;
  }

  async resolveTask(_projectDir: string, idOrPrefix: string): Promise<TaskResolveOutcome> {
    const boardId = await resolveBoardOnce();
    // Detail-first: a full id costs exactly one request. A value that is
    // not an exact hit falls to the single-listing prefix rule — never a
    // board scan before the detail attempt.
    const detail = await fetchSaasTaskDetail(idOrPrefix);
    if (detail.ok) {
      // Ticket 38f085df: a 200 whose record does not validate is the
      // remote image of a corrupt local file — the `unreadable` outcome,
      // never its stale local copy, never a truncated description. The
      // operation layer answers the same TASK_READ_ERROR the local
      // quarantine produces. Transport/absence refusals keep throwing.
      try {
        return { status: "found", id: detail.data.task.id, task: requireTask(detail.data.task, idOrPrefix) };
      } catch (err) {
        if (err instanceof RemoteReadError && err.code === "REMOTE_MALFORMED_RECORD") {
          return { status: "unreadable", id: idOrPrefix };
        }
        throw err;
      }
    }
    if (detail.error.code !== "TASK_NOT_FOUND") {
      throw toRemoteRefusal(detail.error, "Check the backend is reachable and retry the read.");
    }
    const prefix = await resolvePrefix(boardId, idOrPrefix);
    if (prefix.outcome === "missing") return { status: "missing", id: idOrPrefix };
    if (prefix.outcome === "unreadable") return { status: "unreadable", id: prefix.id };
    return { status: "found", id: prefix.task.id, task: prefix.task };
  }

  /**
   * The minimal board slice the relations view derives from: the task plus
   * stub rows for the children the detail response already names — never a
   * board enumeration. The parent resolves by id only (title reads
   * "(not found)" when the board is not enumerated); the id is always
   * exact, which is what the view's links need.
   */
  async relationScope(_projectDir: string, taskId: string): Promise<Task[]> {
    const boardId = await resolveBoardOnce();
    void boardId;
    const detail = await fetchSaasTaskDetail(taskId);
    if (!detail.ok) {
      throw toRemoteRefusal(detail.error, "Check the backend is reachable and retry the read.");
    }
    const task = requireTask(detail.data.task, taskId);
    const children: Task[] = Array.isArray(detail.data.task.children)
      ? detail.data.task.children
          .filter((c) => typeof c?.id === "string" && c.id.length > 0)
          .map((c) => ({
            id: c.id,
            title: typeof c.title === "string" ? c.title : c.id,
            description: "",
            status: toCliStatus(typeof c.status === "string" ? c.status : "todo") as TaskStatus,
            selector: "/",
            created: task.created,
            links: [{ taskId: task.id, type: "parent" }] as TaskLink[],
          }) as Task)
      : [];
    const parentId = detail.data.task.parentId;
    if (typeof parentId === "string" && parentId.length > 0 && !task.links?.some((l) => l.type === "parent")) {
      task.links = [...(task.links ?? []), { taskId: parentId, type: "parent" } as TaskLink];
    }
    return [task, ...children];
  }

  async listComments(_projectDir: string, taskId: string): Promise<TaskComment[]> {
    const task = await this.getTask(_projectDir, taskId);
    return task?.comments ?? [];
  }

  async listFiles(_projectDir: string, taskId: string): Promise<FileInfo[]> {
    const task = await this.getTask(_projectDir, taskId);
    const files = task?.files ?? [];
    return files.map((f) => ({
      name: f.name,
      size: 0,
      url: "",
    }) as FileInfo);
  }

  async getFileCount(_projectDir: string, taskId: string): Promise<number> {
    const row = (await this.getTask(_projectDir, taskId)) as (Task & { fileCount?: number }) | undefined;
    if (typeof row?.fileCount === "number") return row.fileCount;
    return (row?.files ?? []).length;
  }

  async validateAttachment(): Promise<never> {
    throw new RemoteWriteNotRoutedError("validateAttachment");
  }
  /**
   * THE authoritative remote create (ticket efcd6992, P4): exactly ONE
   * POST carrying the operation-validated fields. Identity is
   * server-stamped — no `author` member rides the body, exactly like the
   * CLI's online `--add` — and the returned task is the server view with
   * the accepted raw stashed alongside it for the CLI's offline clone.
   * A refusal throws before anything local exists; a 201 with an
   * unmappable row refuses rather than presenting it as current.
   */
  async createTask(
    _projectDir: string,
    input: TaskCreateInput,
  ): Promise<Task> {
    const boardId = await resolveBoardOnce();
    // Wire parity with the CLI's proven online `--add` body: title /
    // description / status / boardId / links only. Type/priority/tags/url
    // annotations have no online column on this path — the CLI drops them
    // too — so sending them would invent a contract the server never
    // promised; the operation validates them, the board stamps its own.
    const created = await createSaasTask({
      title: input.title,
      ...(input.description !== undefined
        ? { description: input.description }
        : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(boardId !== undefined ? { boardId } : {}),
      ...(input.links !== undefined ? { links: input.links } : {}),
    });
    if (!created.ok) {
      throw toRemoteWriteRefusal(
        created.error,
        "The task was NOT created — check the message, fix the input, and resend the create.",
      );
    }
    const task = requireTask(created.data, created.data.id);
    // The clone contract: the accepted record travels with the task for
    // the CLI's explicit offline clone — never onto the MCP wire.
    return attachWriteEffects(task, created.data);
  }
  /**
   * THE authoritative remote update (ticket efcd6992, P4): exactly ONE
   * PATCH carrying the operation-computed merge as a whole-set replace —
   * the v0 PATCH replaces `links`, so the clear/merge/remove/parent-last
   * surgery the operation performed above is what the server stores.
   * `verified: undefined` on the input means CLEAR (the operation uses
   * absence for "no change"), sent as explicit null. A 404 is a
   * delete-between-reads race: null, so the operation answers the same
   * TASK_NOT_FOUND it would for a locally vanished record. The board's
   * `warning` passthrough (already-claimed, …) rides the returned task
   * for the CLI renderer — never folded into the notices array.
   */
  async updateTask(
    _projectDir: string,
    taskId: string,
    updates: TaskUpdateInput,
  ): Promise<Task | null> {
    const patch: {
      status?: string;
      title?: string;
      description?: string;
      branchName?: string;
      verified?: boolean | null;
      links?: Array<{ taskId: string; type: string }>;
    } = {};
    if (updates.status !== undefined) patch.status = updates.status;
    if (updates.title !== undefined) patch.title = updates.title;
    if (updates.description !== undefined)
      patch.description = updates.description;
    if (updates.branchName !== undefined)
      patch.branchName = updates.branchName;
    // Tri-state: absent means "no change", present-but-undefined means
    // CLEAR — the operation clears by omitting the key locally, which the
    // server spells as explicit null (see updateSaasTask).
    if ("verified" in updates) patch.verified = updates.verified ?? null;
    // Whole-set replace of the operation's merged set. Present-but-empty
    // clears every link (clearLinks:true with nothing re-added).
    if ("links" in updates) patch.links = updates.links ?? [];
    // Identity is server-stamped: updates.author (claim/backfill) is a
    // local-column attribution the PATCH has no spelling for — dropped,
    // exactly like the CLI's online `--edit`, which never sends it.
    const patched = await updateSaasTask(taskId, patch);
    if (!patched.ok) {
      if (patched.error.code === "TASK_NOT_FOUND") return null;
      throw toRemoteWriteRefusal(
        patched.error,
        "The task was NOT updated — re-read it with get_task, then resend the edit.",
      );
    }
    const task = requireTask(patched.data.task, taskId);
    return attachWriteEffects(task, patched.data.task, patched.data.warning);
  }
  async deleteTask(): Promise<never> {
    throw new RemoteWriteNotRoutedError("deleteTask");
  }
  /**
   * THE authoritative remote comment (ticket efcd6992, P4): exactly ONE
   * POST of `{text}`, awaited before success is reported — the
   * fire-and-forget that answered ok:true with the comment still in flight
   * is what this phase removes. Identity rides the server default, exactly
   * like the CLI's online `--comment` (which posts text only).
   */
  async addComment(
    _projectDir: string,
    taskId: string,
    author: TaskComment["author"],
    text: string,
  ): Promise<TaskComment> {
    void author;
    const posted = await addSaasComment(taskId, text);
    if (!posted.ok) {
      throw toRemoteWriteRefusal(
        posted.error,
        "Confirm the task exists (get_task) and resend the comment — it was NOT saved.",
      );
    }
    return toLocalComment(posted.data);
  }
  async updateComment(): Promise<never> {
    throw new RemoteWriteNotRoutedError("updateComment");
  }
  async deleteComment(): Promise<never> {
    throw new RemoteWriteNotRoutedError("deleteComment");
  }
  async saveFile(): Promise<never> {
    throw new RemoteWriteNotRoutedError("saveFile");
  }
  async deleteFile(): Promise<never> {
    throw new RemoteWriteNotRoutedError("deleteFile");
  }
  /**
   * THE truthful remote claim (ticket 6452504d): exactly ONE versioned
   * agent-claim POST (`agentVersion: 1`) built by `buildAgentClaimRequest`.
   * The server owns selection and the write — this method never lists,
   * never filters, never PATCHes, so a claim can never report success when
   * the remote refused, and two concurrent claimants cannot take the same
   * task. An old server is the specific REMOTE_CLAIM_UNSUPPORTED refusal —
   * never a legacy fallback, never a list-then-PATCH.
   */
  async claimNextTaskAtomic(_p: string, opts?: ClaimOptions): Promise<Task | null> {
    return this.runRemoteClaim(opts, false);
  }
  /**
   * Remote preview through the same versioned endpoint with
   * `dryRun: true`: exactly ONE request, nothing written. A `task: null`
   * answer is the empty success (same as the local preview), never an error.
   */
  async previewClaim(_p: string, opts?: ClaimOptions): Promise<ClaimPreview | null> {
    const task = await this.runRemoteClaim(opts, true);
    if (!task) return null;
    // The versioned preview answers the same record the live claim would
    // write: a claimed child carries its parent link, a root carries none —
    // so the CHILD_CLAIM notice derives from the record, never a second read.
    const parentId = (task.links ?? []).find((l) => l.type === "parent")?.taskId ?? null;
    return { task, childClaim: parentId !== null, parentId };
  }
  private async runRemoteClaim(opts: ClaimOptions | undefined, dryRun: boolean): Promise<Task | null> {
    const boardId = await resolveBoardOnce();
    const claimed = await claimSaasTask(
      boardId,
      buildAgentClaimRequest(
        {
          ...(opts?.type !== undefined ? { type: opts.type } : {}),
          ...(opts?.user !== undefined ? { user: opts.user } : {}),
          ...(opts?.tag !== undefined ? { tag: opts.tag } : {}),
          dryRun,
        },
        boardId !== undefined ? { boardId } : undefined,
      ),
    );
    if (!claimed.ok) throw toRemoteClaimRefusal(claimed.error);
    const row = claimed.data.task;
    if (!row) return null;
    return requireTask(row, row.id);
  }
}

export const remoteTaskStore: TaskStore = new RemoteTaskStore();

/** Narrowing helper so operations forward remote refusals without relabelling. */
export function isRemoteReadError(err: unknown): err is RemoteReadError {
  return err instanceof RemoteReadError;
}

export type { OperationPorts };
