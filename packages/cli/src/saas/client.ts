/**
 * SaaS API client for CLI online mode.
 *
 * When the CLI has a valid token, these functions read/write tasks and
 * comments from the SaaS backend instead of local .proto/ files.
 */
import { readToken } from "../auth/token.js";
import { peekBoardScope, scopeHeaderFor } from "../auth/board-scope.js";
import { getApiUrl, surfacePath } from "../core/api-url.js";

export type SaasResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        status?: number;
        /**
         * The request path that failed (e.g. `/api/v0/tasks`). Carried so
         * callers can name the actual failure (HTTP status + path, or the
         * transport message) instead of a catch-all "backend is down".
         */
        path?: string;
        /**
         * The backend's own refusal code when the HTTP body carried one
         * (v0 answers `{ error, code }`, e.g. INVALID_LINKS for a dangling
         * parent). Transport/auth failures leave this absent and callers
         * fall back to the mapped `code` (E_BACKEND_UNAVAILABLE, ...).
         */
        serverCode?: string;
      };
    };

/** Map CLI status values to SaaS DB enum values. */
const CLI_TO_SAAS_STATUS: Record<string, string> = {
  backlog: "backlog",
  todo: "todo",
  "in-progress": "in_progress",
  review: "review",
  done: "done",
};

/** Map SaaS DB enum values back to CLI status values.
 *
 * The v0 contract speaks hyphenated statuses on the wire (`in-progress`)
 * while storage (and the deleted legacy surface) used snake_case
 * (`in_progress`) — both spellings must resolve, or every in-progress
 * task reads back as the `?? "todo"` fallback. */
const SAAS_TO_CLI_STATUS: Record<string, string> = {
  backlog: "backlog",
  todo: "todo",
  in_progress: "in-progress",
  "in-progress": "in-progress",
  review: "review",
  done: "done",
  cancelled: "done",
};

export function toCliStatus(saasStatus: string): string {
  return SAAS_TO_CLI_STATUS[saasStatus] ?? "todo";
}

export function toSaasStatus(cliStatus: string): string {
  return CLI_TO_SAAS_STATUS[cliStatus] ?? "todo";
}

export interface SaasComment {
  id: string;
  taskId: string;
  body: string;
  authorId: string;
  /** v0 contract author (user|agent), preserved verbatim (ledger L1). */
  author?: string;
  createdAt: string;
}

/**
 * Map one v0 contract Comment ({ id, author, text }) onto the CLI-internal
 * SaasComment. Rows without contract text are dropped (null) — a comment
 * with no text cannot render, and the list read stays best-effort.
 */
export function toSaasComment(
  row: Record<string, unknown>,
  taskId: string,
): SaasComment | null {
  if (typeof row.id !== "string" || typeof row.createdAt !== "string") {
    return null;
  }
  if (typeof row.text !== "string") return null;
  return {
    id: row.id,
    taskId,
    body: row.text,
    authorId: typeof row.authorId === "string" ? row.authorId : "",
    ...(typeof row.author === "string" ? { author: row.author } : {}),
    createdAt: row.createdAt,
  };
}

export interface SaasTask {
  id: string;
  title: string;
  description: string | null;
  annotatedElementText?: string | null;
  status: string;
  author?: string | null;
  priority: string | null;
  type: string | null;
  boardId: string;
  createdAt: string;
  updatedAt: string;
  branchName?: string | null;
  /** Tri-state agent attestation: true/false = verdict, null/absent = not assessed. */
  verified?: boolean | null;
  /**
   * Parent/relates/blocks links as the v0 wire carries them
   * (`links: [{ taskId, type }]`). Present on reads; the online board CAN
   * express parent links, so the CLI-online list applies the same root-only
   * default the hosted MCP surface does.
   */
  links?: Array<{ taskId: string; type: string }>;
  comments?: SaasComment[];
  /**
   * Server-computed counts the v0 list answers alongside each item.
   * Present on list reads; absent on older/legacy shapes — callers must
   * fall back to the hydrated array lengths when these are missing.
   */
  commentCount?: number;
  fileCount?: number;
  files?: Array<{
    name: string;
    size?: number;
    url?: string;
    content?: string;
    /** True when written by the engine. Round-trips through push/import. */
    system?: boolean;
  }>;
  /**
   * The ACCEPTED raw record the server stored (ticket 4efaa878 clone mode).
   * Present on create responses from servers that advertise it: the verbatim
   * `raw` (client body plus backfilled id/links, sanitized — no merged
   * column defaults), which the CLI persists as the local clone byte-for-byte.
   * Absent on older servers — the CLI falls back to the response-view mapper
   * and warns loudly that the clone is reconstructed, not exact.
   */
  record?: Record<string, unknown>;
}
async function getBearerHeaders(): Promise<Record<string, string> | null> {
  const token = await readToken();
  if (!token) return null;
  // Every v0 request carries X-Vibeflow-Scope when a board is known
  // (ticket dabd2fb7): the server answers 422 SCOPE_REQUIRED to an
  // unscoped request on a multi-board account. The peek is fs-only — the
  // command entries (tasks/push) run resolveBoardScope first, so
  // auto-selection and the 2+ board refusal happen before any request.
  return { Authorization: `Bearer ${token}`, ...scopeHeaderFor(await peekBoardScope()) };
}

/**
 * Upper bound on concurrent hydration requests. The default read path used
 * to `Promise.all` one hydration per task over the whole board (2+ requests
 * per task) — on a large board thousands of in-flight requests exhausted
 * sockets and the entire read failed even though the backend was healthy.
 * Hydration now runs through a worker pool of this size with strictly
 * sequential sub-requests inside each task, so in-flight requests never
 * exceed this bound no matter how large the board is.
 */
export const SAAS_HYDRATE_CONCURRENCY = 5;

/**
 * Upper bound on v0 list pages per `fetchSaasTasks` read. The pages are
 * followed to completion (cursor until null) so a large board still reads
 * back whole — but a server that keeps answering a cursor forever would
 * spin the CLI forever, so a cursor that REMAINS at this cap FAILS the
 * read instead of returning a partial board. A partial board is the
 * dangerous outcome: prefix resolution and the delete child guard would
 * silently resolve against half the board (an older child reparented to a
 * newer task can fall outside any fixed window), so truncation is a loud
 * BOARD_TRUNCATED refusal, never a quiet short list.
 */
export const SAAS_LIST_MAX_PAGES = 500;

/**
 * Fetch tasks from the SaaS for the given board (or the user's default board).
 * Returns null if not authenticated or the request fails.
 *
 * Hydration is OPT-IN (`{ hydrate: true }`): the v0 list items already
 * carry `commentCount`/`fileCount`, which is all listings need. Passing
 * `hydrate: true` additionally fetches each task's comments + file list
 * (+ inlined text content for small `.md`/`.txt`, mirroring the legacy
 * list shape) — best-effort per task, never fatal, and bounded by
 * SAAS_HYDRATE_CONCURRENCY in flight.
 *
 * v0 envelope: `GET /api/v0/tasks` answers `{ items, nextCursor }` (NOT the
 * legacy `{ tasks, boardId }` the deleted `/api/cli/tasks` surface spoke).
 * Pages are followed via `?cursor=` until `nextCursor` is null so a large
 * board still reads back whole.
 */
export async function fetchSaasTasks(
  boardId?: string,
  opts?: { hydrate?: boolean },
): Promise<SaasResult<{ tasks: SaasTask[]; boardId: string }>> {
  const headers = await getBearerHeaders();
  if (!headers)
    return {
      ok: false,
      error: { code: "NOT_AUTHENTICATED", message: "Not logged in" },
    };

  const apiUrl = getApiUrl();
  try {
    // Cloud-only path: apiUrl is the getApiUrl() SaaS base → always "cloud".
    const listPath = surfacePath("cloud", "/api/cli/tasks");
    // The route (no query string) is reported on HTTP failures so the
    // message names the actual failure — status + path, not a catch-all.
    const listRoute = listPath.split("?")[0] as string;
    const items: SaasTask[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < SAAS_LIST_MAX_PAGES; page++) {
      const url = new URL(`${apiUrl}${listPath}`);
      if (boardId) url.searchParams.set("boardId", boardId);
      if (cursor) url.searchParams.set("cursor", cursor);
      const res = await fetch(url.toString(), { headers });
      if (!res.ok) {
        return {
          ok: false,
          error: {
            code: "HTTP_ERROR",
            message: `HTTP ${res.status}`,
            status: res.status,
            path: listRoute,
          },
        };
      }
      const data = (await res.json()) as {
        items?: SaasTask[];
        nextCursor?: string | null;
        // Legacy fallback: the deleted `/api/cli/tasks` surface (and test
        // fakes predating the cutover) answered `{ tasks, boardId }` with
        // comments/files already inlined.
        tasks?: SaasTask[];
      };
      const pageItems = Array.isArray(data.items)
        ? data.items
        : (Array.isArray(data.tasks) ? data.tasks : []);
      items.push(...pageItems);
      cursor =
        typeof data.nextCursor === "string" && data.nextCursor.length > 0
          ? data.nextCursor
          : null;
      if (!cursor) break;
    }
    // A cursor that survives the whole cap means the board did not fit:
    // report truncation instead of resolving against a partial board
    // (prefix resolution and the delete child guard would silently
    // resolve against half the board).
    if (cursor) {
      return {
        ok: false,
        error: {
          code: "BOARD_TRUNCATED",
          message: `Online board read hit the ${SAAS_LIST_MAX_PAGES}-page list cap with more pages remaining — refusing a partial board rather than resolving against it.`,
          path: listRoute,
        },
      };
    }
    // Hydration is explicit opt-in: a listing over a large board must cost
    // only the paginated list reads (the items already carry
    // commentCount/fileCount). When requested, a bounded worker pool caps
    // in-flight requests at SAAS_HYDRATE_CONCURRENCY — never `Promise.all`
    // over the whole board.
    const tasks =
      opts?.hydrate === true
        ? await mapWithConcurrency(items, SAAS_HYDRATE_CONCURRENCY, (t) =>
            hydrateSaasTask(apiUrl, headers, t),
          )
        : items;
    return { ok: true, data: { tasks, boardId: boardId ?? "" } };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "NETWORK_ERROR",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/** v0 file-list row shape (`GET /api/v0/tasks/:id/files` → `{ files }`). */
interface V0FileRow {
  name?: string;
  mimeType?: string | null;
  size?: number | null;
  system?: boolean;
  createdAt?: string;
  url?: string;
}

/** Legacy parity: only small text artifacts travelled with inlined content. */
const TEXT_INLINE_SIZE_LIMIT = 50_000;

function isInlineableText(name: string): boolean {
  return /\.(md|txt)$/i.test(name);
}

/**
 * Run `fn` over `items` with at most `limit` workers in flight — the
 * bounded replacement for `Promise.all(items.map(fn))`. Order is
 * preserved. A worker takes the next index synchronously between awaits,
 * so no two workers share an index.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  });
  await Promise.all(workers);
  return results as R[];
}

/**
 * Best-effort per-task hydration: comments + files (+ text content) onto a
 * v0 list item. Anything missing/failed degrades to `[]`/absent content —
 * a hydration failure must never fail the whole list read. Items that
 * already carry the legacy inlined shape keep it (no refetch).
 *
 * Sub-requests run SEQUENTIALLY inside one task (comments, then files,
 * then each text download in turn): callers bound whole-board hydration
 * with a worker pool, and sequential interiors keep total in-flight
 * requests at or under that pool size no matter the file mix.
 */
async function hydrateSaasTask(
  apiUrl: string,
  headers: Record<string, string>,
  item: SaasTask,
): Promise<SaasTask> {
  const hasComments = Array.isArray(item.comments);
  const hasFiles = Array.isArray(item.files);
  if (hasComments && hasFiles) return item;
  const taskId = item.id;
  const base = surfacePath("cloud", `/api/cli/tasks/${encodeURIComponent(taskId)}`);
  const comments = hasComments
    ? (item.comments as SaasComment[])
    : await fetchV0Comments(apiUrl, headers, base, taskId);
  const files = hasFiles
    ? item.files
    : await fetchV0FilesWithContent(apiUrl, headers, base);
  return { ...item, comments, files };
}

async function fetchV0Comments(
  apiUrl: string,
  headers: Record<string, string>,
  taskBase: string,
  taskId: string,
): Promise<SaasComment[]> {
  try {
    const res = await fetch(`${apiUrl}${taskBase}/comments`, { headers });
    if (!res.ok) return [];
    const data = (await res.json()) as { comments?: Array<Record<string, unknown>> };
    if (!Array.isArray(data.comments)) return [];
    // v0 comment rows carry no `taskId` — fill it so renderers keep working.
    const out: SaasComment[] = [];
    for (const row of data.comments) {
      if (typeof row !== "object" || row === null) continue;
      const mapped = toSaasComment(row, taskId);
      if (mapped) out.push(mapped);
    }
    return out;
  } catch {
    return [];
  }
}

async function fetchV0FilesWithContent(
  apiUrl: string,
  headers: Record<string, string>,
  taskBase: string,
): Promise<SaasTask["files"]> {
  try {
    const res = await fetch(`${apiUrl}${taskBase}/files`, { headers });
    if (!res.ok) return [];
    const data = (await res.json()) as { files?: V0FileRow[] };
    const rows = Array.isArray(data.files) ? data.files : [];
    // Sequential text downloads: this helper runs inside the bounded
    // hydration pool, so parallel downloads here would multiply past the
    // pool cap (one slot per task must mean one request in flight).
    const out: NonNullable<SaasTask["files"]> = [];
    for (const f of rows) {
      if (typeof f.name !== "string" || f.name.length === 0) continue;
      const name = f.name;
      const rawUrl = typeof f.url === "string" ? f.url : undefined;
      const url =
        rawUrl !== undefined && /^https?:\/\//.test(rawUrl)
          ? rawUrl
          : rawUrl !== undefined
            ? `${apiUrl}${rawUrl}`
            : undefined;
      const size = typeof f.size === "number" ? f.size : undefined;
      let content: string | undefined;
      if (
        isInlineableText(name) &&
        url !== undefined &&
        size !== undefined &&
        size <= TEXT_INLINE_SIZE_LIMIT
      ) {
        content = await downloadTextFile(apiUrl, url, headers);
      }
      out.push({
        name,
        size,
        url,
        content,
        system: f.system === true,
      });
    }
    return out;
  } catch {
    return [];
  }
}

async function downloadTextFile(
  apiUrl: string,
  url: string,
  headers: Record<string, string>,
): Promise<string | undefined> {
  // SSRF guard: only ever download from the SaaS base the token belongs
  // to — the file URL is server-supplied (relative, absolutized above),
  // so anything off-origin is refused instead of fetched with a Bearer.
  if (!url.startsWith(apiUrl)) return undefined;
  try {
    // `identity` forces the plain-bytes branch server-side (no brotli
    // transfer framing to decode) — the bytes arrive as stored-plain.
    const res = await fetch(url, {
      headers: { ...headers, "Accept-Encoding": "identity" },
    });
    if (!res.ok) return undefined;
    return await res.text();
  } catch {
    return undefined;
  }
}

/**
 * Fetch a single task from the SaaS by ID — exactly ONE detail request
 * (`GET /api/v0/tasks/:id`), never a whole-board listing. The returned
 * task still carries its comments/files: the single item is hydrated with
 * the same best-effort helper the (opt-in) board hydration uses.
 *
 * Failures name the actual failure: 404 answers `TASK_NOT_FOUND`, other
 * HTTP refusals carry status + path, and transport failures carry the
 * network message — never a catch-all.
 */
export async function fetchSaasTaskDetail(
  taskId: string,
): Promise<SaasResult<{ task: SaasTask }>> {
  const headers = await getBearerHeaders();
  if (!headers)
    return {
      ok: false,
      error: { code: "NOT_AUTHENTICATED", message: "Not logged in" },
    };

  const apiUrl = getApiUrl();
  // Cloud-only path: apiUrl is the getApiUrl() SaaS base → always "cloud".
  const detailPath = surfacePath(
    "cloud",
    `/api/tasks/${encodeURIComponent(taskId)}`,
  );
  try {
    const res = await fetch(`${apiUrl}${detailPath}`, { headers });
    if (!res.ok) {
      if (res.status === 404) {
        return {
          ok: false,
          error: {
            code: "TASK_NOT_FOUND",
            message: `Task not found: ${taskId}`,
            status: 404,
            path: detailPath,
          },
        };
      }
      const errBody = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const serverMessage =
        typeof errBody.error === "string" ? errBody.error : undefined;
      return {
        ok: false,
        error: {
          code: "HTTP_ERROR",
          message: serverMessage ?? `HTTP ${res.status}`,
          status: res.status,
          path: detailPath,
          ...(typeof errBody.code === "string" && errBody.code
            ? { serverCode: errBody.code }
            : {}),
        },
      };
    }
    // v0 answers the bare task (contract Task).
    const item = (await res.json()) as SaasTask;
    const task = await hydrateSaasTask(apiUrl, headers, item);
    return { ok: true, data: { task } };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "NETWORK_ERROR",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * The online answer to a user-supplied id-like value, resolved against the
 * board listing the write goes to — the SaaS twin of the local
 * `resolveTaskId` rule (`matchesIdOrPrefix`): exact id wins first (an exact
 * id that is also a prefix of others still resolves to itself), then a
 * unique prefix, then refusal. Ambiguity and unknown values are refusals
 * with codes the CLI maps to exits — never a silent first-match, so a
 * link flag can never attach to a task the caller did not name.
 */
export type SaasIdResolution =
  | { ok: true; id: string }
  | { ok: false; code: "TASK_NOT_FOUND"; message: string }
  | {
      ok: false;
      code: "E_AMBIGUOUS";
      message: string;
      candidates: string[];
    };

export function resolveSaasTaskId(
  tasks: Array<{ id: string; title?: string | null }>,
  raw: string,
): SaasIdResolution {
  if (raw.length === 0) {
    return {
      ok: false,
      code: "TASK_NOT_FOUND",
      message: `Task not found: ${raw}`,
    };
  }
  const exact = tasks.find((t) => t.id === raw);
  if (exact) return { ok: true, id: exact.id };
  const matches = tasks.filter((t) => t.id.startsWith(raw));
  if (matches.length === 0) {
    return {
      ok: false,
      code: "TASK_NOT_FOUND",
      message: `Task not found: ${raw}`,
    };
  }
  if (matches.length === 1) return { ok: true, id: matches[0].id };
  const named = matches
    .map((m) => (m.title ? `${m.id} "${m.title}"` : m.id))
    .join(", ");
  return {
    ok: false,
    code: "E_AMBIGUOUS",
    message: `Ambiguous task id prefix "${raw}" matches ${matches.length} tasks: ${named}`,
    candidates: matches.map((m) => m.id),
  };
}

/**
 * Fetch a single task from the SaaS by ID.
 * Returns null if not authenticated, not found, or the request fails.
 *
 * Single detail request (see fetchSaasTaskDetail) — never a board listing.
 */
export async function fetchSaasTask(taskId: string): Promise<SaasTask | null> {
  const result = await fetchSaasTaskDetail(taskId);
  if (!result.ok) return null;
  return result.data.task;
}

/**
 * Update a task in the SaaS.
 * Returns the updated task or null on failure / not authenticated.
 */
export async function updateSaasTask(
  taskId: string,
  patch: {
    status?: string;
    title?: string;
    description?: string;
    priority?: string;
    branchName?: string;
    /** Tri-state attestation: true/false = verdict, null = clear to absent. */
    verified?: boolean | null;
    /**
     * Whole link set (v0 PATCH `links` replaces). The caller computes the
     * merge (set/replace/clear parent) from the task it read first — the
     * server validates (exists, not self, no cycle) and refuses INVALID_LINKS.
     */
    links?: Array<{ taskId: string; type: string }>;
  },
): Promise<SaasResult<{ task: SaasTask; warning?: string }>> {
  const headers = await getBearerHeaders();
  if (!headers)
    return {
      ok: false,
      error: { code: "NOT_AUTHENTICATED", message: "Not logged in" },
    };

  const body: Record<string, unknown> = {};
  if (patch.status !== undefined) body.status = toSaasStatus(patch.status);
  if (patch.title !== undefined) body.title = patch.title;
  if (patch.description !== undefined) body.description = patch.description;
  if (patch.priority !== undefined) body.priority = patch.priority;
  if (patch.branchName !== undefined) body.branchName = patch.branchName;
  // Send `null` explicitly to clear — undefined means "no change".
  if (patch.verified !== undefined) body.verified = patch.verified;
  if (patch.links !== undefined) body.links = patch.links;

  try {
    const res = await fetch(
      // Cloud-only path: getApiUrl() is the SaaS base → always "cloud".
      `${getApiUrl()}${surfacePath("cloud", `/api/cli/tasks/${encodeURIComponent(taskId)}`)}`,
      {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const msg =
        typeof errBody.error === "string"
          ? errBody.error
          : `HTTP ${res.status}`;
      return {
        ok: false,
        error: {
          code: "HTTP_ERROR",
          message: msg,
          status: res.status,
          ...(typeof errBody.code === "string" && errBody.code
            ? { serverCode: errBody.code }
            : {}),
        },
      };
    }
    // v0 answers the bare task (contract Task) with an optional `warning`
    // alongside it on the already-claimed path — never a `{ task }` envelope.
    const data = (await res.json()) as SaasTask & { warning?: string };
    const { warning, ...task } = data;
    return { ok: true, data: { task, warning } };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "NETWORK_ERROR",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Delete a task from the SaaS by its FULL id (callers resolve prefixes
 * with `resolveSaasTaskId` first — this function never guesses). Exactly
 * one DELETE request (`DELETE /api/v0/tasks/:id`).
 *
 * The v0 DELETE CASCADES: the server deletes the task's whole descendant
 * cone and answers `{ success, deletedIds }` (root first). The caller
 * detects children beforehand from the board listing — not to refuse (the
 * server would delete them anyway), but to WARN explicitly that they go
 * with the parent — and reports the returned `deletedIds` so the outcome
 * is auditable. A 404 answers `TASK_NOT_FOUND` (deleted between the
 * listing read and this request); other HTTP refusals carry status + path,
 * and transport failures the network message. Fakes predating the cascade
 * answer `{}`/`{ success }` with no ids — that shape resolves to the
 * requested id alone, never to an empty set.
 */
export async function deleteSaasTask(
  taskId: string,
): Promise<SaasResult<{ id: string; deletedIds: string[] }>> {
  const headers = await getBearerHeaders();
  if (!headers)
    return {
      ok: false,
      error: { code: "NOT_AUTHENTICATED", message: "Not logged in" },
    };

  const apiUrl = getApiUrl();
  // Cloud-only path: apiUrl is the getApiUrl() SaaS base → always "cloud".
  const deletePath = surfacePath(
    "cloud",
    `/api/cli/tasks/${encodeURIComponent(taskId)}`,
  );
  try {
    const res = await fetch(`${apiUrl}${deletePath}`, {
      method: "DELETE",
      headers,
    });
    if (!res.ok) {
      if (res.status === 404) {
        return {
          ok: false,
          error: {
            code: "TASK_NOT_FOUND",
            message: `Task not found: ${taskId}`,
            status: 404,
            path: deletePath,
          },
        };
      }
      const errBody = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const serverMessage =
        typeof errBody.error === "string" ? errBody.error : undefined;
      return {
        ok: false,
        error: {
          code: "HTTP_ERROR",
          message: serverMessage ?? `HTTP ${res.status}`,
          status: res.status,
          path: deletePath,
          ...(typeof errBody.code === "string" && errBody.code
            ? { serverCode: errBody.code }
            : {}),
        },
      };
    }
    const data = (await res.json().catch(() => ({}))) as {
      deletedIds?: unknown;
    };
    const deletedIds =
      Array.isArray(data.deletedIds) &&
      data.deletedIds.length > 0 &&
      data.deletedIds.every((d) => typeof d === "string")
        ? (data.deletedIds as string[])
        : [taskId];
    return { ok: true, data: { id: taskId, deletedIds } };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "NETWORK_ERROR",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * What the task-files endpoint answers for one stored file. The local
 * board answers `{ success, file: { name, size, url } }` and the cloud
 * answers `{ success, file: { id, name, sizeBytes, url, ... } }` — every
 * field but `name` is optional here so both shapes map onto one reader
 * instead of each caller re-deriving it.
 */
export interface SaasUploadedFile {
  /** Server file id when the backend mints one — otherwise the filename. */
  id: string;
  name: string;
  size: number;
  url?: string;
}

/**
 * Upload one file's bytes to a task in the SaaS (online attach). Exactly
 * one request: `POST /api/v0/tasks/:id/files` (the legacy
 * `/api/tasks/:id/files` spelling mapped through `surfacePath`) with a
 * multipart `file` field — the same contract the web kanban `uploadFile`
 * client speaks. The server mints a fresh file id per upload (it does NOT
 * dedupe by name), so callers check the file list first and never upload
 * the same (taskId, name) twice — one name, one row.
 *
 * Failures name the actual failure: 404 answers `TASK_NOT_FOUND`, other
 * HTTP refusals carry status + path, and transport failures carry the
 * network message.
 */
export async function uploadSaasFile(
  taskId: string,
  filename: string,
  data: Uint8Array,
): Promise<SaasResult<SaasUploadedFile>> {
  const headers = await getBearerHeaders();
  if (!headers)
    return {
      ok: false,
      error: { code: "NOT_AUTHENTICATED", message: "Not logged in" },
    };

  const apiUrl = getApiUrl();
  // Cloud-only path: apiUrl is the SaaS base → always "cloud".
  const uploadPath = surfacePath(
    "cloud",
    `/api/tasks/${encodeURIComponent(taskId)}/files`,
  );
  // Multipart `file` field, byte-for-byte the web kanban upload: the v0
  // route reads `formData.get("file")` (raw bodies need an `x-filename`
  // header instead, so multipart is the one spelling every server takes).
  // SAFETY: undici's FormData/Blob accept any ArrayBufferView at runtime;
  // the shared copy keeps the caller's buffer alive past the send.
  const shared = new Uint8Array(data.length);
  shared.set(data);
  const form = new FormData();
  form.append(
    "file",
    new Blob([shared], { type: "application/octet-stream" }),
    filename,
  );
  try {
    const res = await fetch(`${apiUrl}${uploadPath}`, {
      method: "POST",
      headers,
      body: form,
    });
    if (!res.ok) {
      if (res.status === 404) {
        return {
          ok: false,
          error: {
            code: "TASK_NOT_FOUND",
            message: `Task not found: ${taskId}`,
            status: 404,
            path: uploadPath,
          },
        };
      }
      const errBody = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const serverMessage =
        typeof errBody.error === "string" ? errBody.error : undefined;
      return {
        ok: false,
        error: {
          code: "HTTP_ERROR",
          message: serverMessage ?? `HTTP ${res.status}`,
          status: res.status,
          path: uploadPath,
          ...(typeof errBody.code === "string" && errBody.code
            ? { serverCode: errBody.code }
            : {}),
        },
      };
    }
    const body = (await res.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    // Local shape `{ success, file: { name, size } }`, cloud shape
    // `{ success, file: { id, name, sizeBytes, url } }` — read every
    // spelling in one place so the CLI never branches on the backend.
    const row =
      body.file && typeof body.file === "object"
        ? (body.file as Record<string, unknown>)
        : body;
    const name = typeof row.name === "string" ? row.name : filename;
    const size =
      typeof row.sizeBytes === "number"
        ? row.sizeBytes
        : typeof row.size === "number"
          ? row.size
          : data.length;
    const id =
      typeof row.id === "string"
        ? row.id
        : typeof body.id === "string"
          ? (body.id as string)
          : typeof body.fileId === "string"
            ? (body.fileId as string)
            : name;
    const url = typeof row.url === "string" ? row.url : undefined;
    return { ok: true, data: { id, name, size, ...(url ? { url } : {}) } };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "NETWORK_ERROR",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Add a comment to a task in the SaaS.
 * Returns the created comment or null on failure / not authenticated.
 */
export async function addSaasComment(
  taskId: string,
  body: string,
): Promise<SaasResult<SaasComment>> {
  const headers = await getBearerHeaders();
  if (!headers)
    return {
      ok: false,
      error: { code: "NOT_AUTHENTICATED", message: "Not logged in" },
    };

  try {
    const res = await fetch(
      // Cloud-only path: getApiUrl() is the SaaS base → always "cloud".
      `${getApiUrl()}${surfacePath("cloud", `/api/cli/tasks/${encodeURIComponent(taskId)}/comments`)}`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        // Contract CommentInput: `text` required, `author` preserved.
        // The CLI posts human-authored text; the server defaults author.
        body: JSON.stringify({ text: body }),
      },
    );
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const msg = (errBody.error as string) ?? `HTTP ${res.status}`;
      return {
        ok: false,
        error: { code: "HTTP_ERROR", message: msg, status: res.status },
      };
    }
    // v0 answers the bare contract Comment (status 200).
    const data = (await res.json()) as Record<string, unknown>;
    const mapped = toSaasComment(data, taskId);
    if (!mapped) {
      return {
        ok: false,
        error: { code: "HTTP_ERROR", message: "Malformed comment response" },
      };
    }
    return { ok: true, data: mapped };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "NETWORK_ERROR",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

/**
 * Fetch comments for a task from the SaaS.
 * Returns null on failure / not authenticated.
 */
export async function fetchSaasComments(
  taskId: string,
): Promise<SaasComment[] | null> {
  const headers = await getBearerHeaders();
  if (!headers) return null;

  try {
    const res = await fetch(
      // Cloud-only path: getApiUrl() is the SaaS base → always "cloud".
      `${getApiUrl()}${surfacePath("cloud", `/api/cli/tasks/${encodeURIComponent(taskId)}/comments`)}`,
      { headers },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { comments?: Array<Record<string, unknown>> };
    if (!Array.isArray(data.comments)) return [];
    // v0 comment rows carry no `taskId` — fill it so renderers keep working.
    const out: SaasComment[] = [];
    for (const row of data.comments) {
      if (typeof row !== "object" || row === null) continue;
      const mapped = toSaasComment(row, taskId);
      if (mapped) out.push(mapped);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Create a new task in the SaaS.
 * Returns the created task or null on failure / not authenticated.
 */
export async function createSaasTask(params: {
  id?: string;
  title: string;
  description?: string;
  annotatedElementText?: string;
  status?: string;
  priority?: string;
  type?: string;
  boardId?: string;
  /**
   * Links to write with the new task (v0 POST `links`). A
   * `{ taskId, type: "parent" }` entry is the online spelling of the
   * local `--parent` flag — the server validates the target exists.
   */
  links?: Array<{ taskId: string; type: string }>;
}): Promise<SaasResult<SaasTask>> {
  const headers = await getBearerHeaders();
  if (!headers)
    return {
      ok: false,
      error: { code: "NOT_AUTHENTICATED", message: "Not logged in" },
    };

  try {
    // Cloud-only path: getApiUrl() is the SaaS base → always "cloud".
    const res = await fetch(`${getApiUrl()}${surfacePath("cloud", "/api/cli/tasks")}`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      const msg =
        typeof errBody.error === "string"
          ? errBody.error
          : `HTTP ${res.status}`;
      return {
        ok: false,
        error: {
          code: "HTTP_ERROR",
          message: msg,
          status: res.status,
          ...(typeof errBody.code === "string" && errBody.code
            ? { serverCode: errBody.code }
            : {}),
        },
      };
    }
    // v0 answers the created task (contract Task), status 201 — newer
    // servers carry the accepted raw on an explicit `record` member alongside
    // the view (ticket 4efaa878: the clone persists that member verbatim).
    const data = (await res.json()) as SaasTask;
    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      error: {
        code: "NETWORK_ERROR",
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}
