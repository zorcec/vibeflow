/**
 * SaaS API client for CLI online mode.
 *
 * When the CLI has a valid token, these functions read/write tasks and
 * comments from the SaaS backend instead of local .proto/ files.
 */
import { readToken } from "../auth/token.js";
import { getApiUrl, surfacePath } from "../core/api-url.js";

export type SaasResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; status?: number } };

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
  comments?: SaasComment[];
  files?: Array<{
    name: string;
    size?: number;
    url?: string;
    content?: string;
    /** True when written by the engine. Round-trips through push/import. */
    system?: boolean;
  }>;
}
async function getBearerHeaders(): Promise<Record<string, string> | null> {
  const token = await readToken();
  if (!token) return null;
  return { Authorization: `Bearer ${token}` };
}

/**
 * Fetch tasks from the SaaS for the given board (or the user's default board).
 * Returns null if not authenticated or the request fails.
 *
 * v0 envelope: `GET /api/v0/tasks` answers `{ items, nextCursor }` (NOT the
 * legacy `{ tasks, boardId }` the deleted `/api/cli/tasks` surface spoke).
 * Pages are followed via `?cursor=` until `nextCursor` is null so a large
 * board still reads back whole. The v0 items carry neither comments nor
 * files (only `commentCount`/`fileCount`), so each task is hydrated with
 * its comments + file list (+ inlined text content for small `.md`/`.txt`,
 * mirroring the legacy list shape) — best-effort per task, never fatal.
 */
export async function fetchSaasTasks(
  boardId?: string,
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
    const items: SaasTask[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page++) {
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
    const tasks = await Promise.all(
      items.map((t) => hydrateSaasTask(apiUrl, headers, t)),
    );
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
 * Best-effort per-task hydration: comments + files (+ text content) onto a
 * v0 list item. Anything missing/failed degrades to `[]`/absent content —
 * a hydration failure must never fail the whole list read. Items that
 * already carry the legacy inlined shape keep it (no refetch).
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
  const [comments, files] = await Promise.all([
    hasComments
      ? Promise.resolve(item.comments as SaasComment[])
      : fetchV0Comments(apiUrl, headers, base, taskId),
    hasFiles
      ? Promise.resolve(item.files)
      : fetchV0FilesWithContent(apiUrl, headers, base),
  ]);
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
    return await Promise.all(
      rows
        .filter((f) => typeof f.name === "string" && f.name.length > 0)
        .map(async (f) => {
          const name = f.name as string;
          const rawUrl = typeof f.url === "string" ? f.url : undefined;
          const url =
            rawUrl !== undefined && /^https?:\/\//.test(rawUrl)
              ? rawUrl
              : rawUrl !== undefined
                ? `${apiUrl}${rawUrl}`
                : undefined;
          const size =
            typeof f.size === "number" ? f.size : undefined;
          let content: string | undefined;
          if (
            isInlineableText(name) &&
            url !== undefined &&
            size !== undefined &&
            size <= TEXT_INLINE_SIZE_LIMIT
          ) {
            content = await downloadTextFile(apiUrl, url, headers);
          }
          return {
            name,
            size,
            url,
            content,
            system: f.system === true,
          };
        }),
    );
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
 * Fetch a single task from the SaaS by ID.
 * Returns null if not authenticated, not found, or the request fails.
 */
export async function fetchSaasTask(taskId: string): Promise<SaasTask | null> {
  const result = await fetchSaasTasks();
  if (!result.ok) return null;
  return result.data.tasks.find((t) => t.id === taskId) ?? null;
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
      const msg = (errBody.error as string) ?? `HTTP ${res.status}`;
      return {
        ok: false,
        error: { code: "HTTP_ERROR", message: msg, status: res.status },
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
      const msg = (errBody.error as string) ?? `HTTP ${res.status}`;
      return {
        ok: false,
        error: { code: "HTTP_ERROR", message: msg, status: res.status },
      };
    }
    // v0 answers the bare created task (contract Task), status 201.
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
