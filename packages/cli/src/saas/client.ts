/**
 * SaaS API client for CLI online mode.
 *
 * When the CLI has a valid token, these functions read/write tasks and
 * comments from the SaaS backend instead of local .proto/ files.
 */
import { readToken } from "../auth/token.js";

// Stryker disable once StringLiteral: default API URL is a configuration constant
const DEFAULT_API_URL = "https://app.vibeflow.tools";

function getApiUrl(): string {
  return process.env.VIBEFLOW_API_URL ?? DEFAULT_API_URL;
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
  comments?: SaasComment[];
  files?: Array<{ name: string; size?: number; url?: string; content?: string }>;
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
): Promise<{ tasks: SaasTask[]; boardId: string } | null> {
  const headers = await getBearerHeaders();
  if (!headers) return null;

  const url = new URL(`${getApiUrl()}/api/cli/tasks`);
  if (boardId) url.searchParams.set("boardId", boardId);

  try {
    const res = await fetch(url.toString(), { headers });
    if (!res.ok) return null;
    return res.json() as Promise<{ tasks: SaasTask[]; boardId: string }>;
  } catch {
    return null;
  }
}

/**
 * Fetch a single task from the SaaS by ID.
 * Returns null if not authenticated, not found, or the request fails.
 */
export async function fetchSaasTask(taskId: string): Promise<SaasTask | null> {
  const result = await fetchSaasTasks();
  if (!result) return null;
  return result.tasks.find(t => t.id === taskId) ?? null;
}

/**
 * Update a task in the SaaS.
 * Returns the updated task or null on failure / not authenticated.
 */
export async function updateSaasTask(
  taskId: string,
  patch: { status?: string; title?: string; description?: string; priority?: string },
): Promise<{ task: SaasTask; warning?: string } | null> {
  const headers = await getBearerHeaders();
  if (!headers) return null;

  const body: Record<string, string> = {};
  if (patch.status !== undefined) body.status = toSaasStatus(patch.status);
  if (patch.title !== undefined) body.title = patch.title;
  if (patch.description !== undefined) body.description = patch.description;
  if (patch.priority !== undefined) body.priority = patch.priority;

  try {
    const res = await fetch(
      `${getApiUrl()}/api/cli/tasks/${encodeURIComponent(taskId)}`,
      {
        method: "PATCH",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) return null;
    const data = await res.json() as { task: SaasTask; warning?: string };
    return { task: data.task, warning: data.warning };
  } catch {
    return null;
  }
}

/**
 * Add a comment to a task in the SaaS.
 * Returns the created comment or null on failure / not authenticated.
 */
export async function addSaasComment(
  taskId: string,
  body: string,
): Promise<SaasComment | null> {
  const headers = await getBearerHeaders();
  if (!headers) return null;

  try {
    const res = await fetch(
      `${getApiUrl()}/api/cli/tasks/${encodeURIComponent(taskId)}/comments`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      },
    );
    if (!res.ok) return null;
    const data = await res.json() as { comment: SaasComment };
    return data.comment;
  } catch {
    return null;
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
    const data = await res.json() as { comments: SaasComment[] };
    return data.comments;
  } catch {
    return null;
  }
}

/**
 * Create a new task in the SaaS.
 * Returns the created task or null on failure / not authenticated.
 */
export async function createSaasTask(
  params: { id?: string; title: string; description?: string; annotatedElementText?: string; status?: string; priority?: string; type?: string; boardId?: string },
): Promise<SaasTask | null> {
  const headers = await getBearerHeaders();
  if (!headers) return null;

  try {
    const res = await fetch(`${getApiUrl()}/api/cli/tasks`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    if (!res.ok) return null;
    const data = await res.json() as { task: SaasTask };
    return data.task;
  } catch {
    return null;
  }
}

