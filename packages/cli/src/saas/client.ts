/**
 * SaaS API client for CLI online mode.
 *
 * When the CLI has a valid token, these functions read/write tasks and
 * comments from the SaaS backend instead of local .proto/ files.
 */
import { readToken } from "../auth/token.js";

export type SaasResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; status?: number } };

// Stryker disable once StringLiteral: default API URL is a configuration constant
const DEFAULT_API_URL = "https://app.vibeflow.tools";

/**
 * Resolve the SaaS API base URL from the environment. Validates that the value
 * is a well-formed http(s) URL and falls back to the production default for
 * anything else — Bearer tokens must never be sent to file://, custom schemes,
 * or malformed hosts (SSRF/credential-leak guard). Also guarantees callers'
 * `new URL(...)` never throws on a bad env value.
 */
function getApiUrl(): string {
  const raw = process.env.VIBEFLOW_API_URL ?? DEFAULT_API_URL;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:")
      return DEFAULT_API_URL;
    return raw.replace(/\/+$/, "");
  } catch {
    return DEFAULT_API_URL;
  }
}

/** Map CLI status values to SaaS DB enum values. */
const CLI_TO_SAAS_STATUS: Record<string, string> = {
  backlog: "backlog",
  todo: "todo",
  "in-progress": "in_progress",
  review: "review",
  done: "done",
};

/** Map SaaS DB enum values back to CLI status values. */
const SAAS_TO_CLI_STATUS: Record<string, string> = {
  backlog: "backlog",
  todo: "todo",
  in_progress: "in-progress",
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
  createdAt: string;
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
  comments?: SaasComment[];
  files?: Array<{
    name: string;
    size?: number;
    url?: string;
    content?: string;
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
 */
export async function fetchSaasTasks(
  boardId?: string,
): Promise<SaasResult<{ tasks: SaasTask[]; boardId: string }>> {
  const headers = await getBearerHeaders();
  if (!headers) return { ok: false, error: { code: "NOT_AUTHENTICATED", message: "Not logged in" } };

  const apiUrl = getApiUrl();
  const url = new URL(`${apiUrl}/api/cli/tasks`);
  if (boardId) url.searchParams.set("boardId", boardId);

  try {
    const res = await fetch(url.toString(), { headers });
    if (!res.ok) {
      return { ok: false, error: { code: "HTTP_ERROR", message: `HTTP ${res.status}`, status: res.status } };
    }
    const data = (await res.json()) as { tasks: SaasTask[]; boardId: string };
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: { code: "NETWORK_ERROR", message: err instanceof Error ? err.message : String(err) } };
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
  },
): Promise<SaasResult<{ task: SaasTask; warning?: string }>> {
  const headers = await getBearerHeaders();
  if (!headers) return { ok: false, error: { code: "NOT_AUTHENTICATED", message: "Not logged in" } };

  const body: Record<string, string> = {};
  if (patch.status !== undefined) body.status = toSaasStatus(patch.status);
  if (patch.title !== undefined) body.title = patch.title;
  if (patch.description !== undefined) body.description = patch.description;
  if (patch.priority !== undefined) body.priority = patch.priority;
  if (patch.branchName !== undefined) body.branchName = patch.branchName;

  try {
    const res = await fetch(
      `${getApiUrl()}/api/cli/tasks/${encodeURIComponent(taskId)}`,
      {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const msg = (errBody.error as string) ?? `HTTP ${res.status}`;
      return { ok: false, error: { code: "HTTP_ERROR", message: msg, status: res.status } };
    }
    const data = (await res.json()) as { task: SaasTask; warning?: string };
    return { ok: true, data: { task: data.task, warning: data.warning } };
  } catch (err) {
    return { ok: false, error: { code: "NETWORK_ERROR", message: err instanceof Error ? err.message : String(err) } };
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
  if (!headers) return { ok: false, error: { code: "NOT_AUTHENTICATED", message: "Not logged in" } };

  try {
    const res = await fetch(
      `${getApiUrl()}/api/cli/tasks/${encodeURIComponent(taskId)}/comments`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const msg = (errBody.error as string) ?? `HTTP ${res.status}`;
      return { ok: false, error: { code: "HTTP_ERROR", message: msg, status: res.status } };
    }
    const data = (await res.json()) as { comment: SaasComment };
    return { ok: true, data: data.comment };
  } catch (err) {
    return { ok: false, error: { code: "NETWORK_ERROR", message: err instanceof Error ? err.message : String(err) } };
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
      `${getApiUrl()}/api/cli/tasks/${encodeURIComponent(taskId)}/comments`,
      { headers },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { comments: SaasComment[] };
    return data.comments;
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
  if (!headers) return { ok: false, error: { code: "NOT_AUTHENTICATED", message: "Not logged in" } };

  try {
    const res = await fetch(`${getApiUrl()}/api/cli/tasks`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const errBody = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      const msg = (errBody.error as string) ?? `HTTP ${res.status}`;
      return { ok: false, error: { code: "HTTP_ERROR", message: msg, status: res.status } };
    }
    const data = (await res.json()) as { task: SaasTask };
    return { ok: true, data: data.task };
  } catch (err) {
    return { ok: false, error: { code: "NETWORK_ERROR", message: err instanceof Error ? err.message : String(err) } };
  }
}
