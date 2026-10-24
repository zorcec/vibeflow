import type {
  Task,
  Comment,
  FileEntry,
  KanbanApi,
} from "@vibeflow-tools/ui/kanban";

/**
 * Per-user read state calls the CLI board issues on top of the shared
 * KanbanApi. The shared components never call these themselves — the board
 * shell wires them to card events.
 */
export interface KanbanReadStateApi {
  /** Records the current user as having opened a task (persistent read state). */
  markOpened(taskId: string): Promise<void>;
  removeTagFromAll(tag: string): Promise<number>;
  /** Adds/removes the current user from the task's persisted expanded set. */
  setTaskExpanded(taskId: string, expanded: boolean): Promise<void>;
}

const BASE = window.location.origin;
const API = `${BASE}/api/tasks`;

// Last-known panel data per task (ticket d4c533f9): a 304/empty body
// carries no payload, so the honest result is the unchanged data —
// returning a bare empty list would wipe the pane on a normal
// revalidation path.
const commentsCache = new Map<string, Comment[]>();
const filesCache = new Map<string, FileEntry[]>();

/** Parse a JSON response honestly (ticket d4c533f9): a 304 or an empty
 * body has no payload — return the fallback instead of throwing inside
 * `r.json()`. Unexpected statuses surface as Errors; every caller already
 * routes those to its error state, so nothing rejects unhandled. */
async function readJson<T>(r: Response, fallback: T, what: string): Promise<T> {
  if (r.status === 304) return fallback;
  if (!r.ok) throw new Error(`${what} failed: HTTP ${r.status}`);
  const text = await r.text();
  if (!text.trim()) return fallback;
  return JSON.parse(text) as T;
}

export const api: KanbanApi & KanbanReadStateApi = {
  async getTasks(): Promise<{ tasks: Task[] }> {
    const r = await fetch(`${API}?_=${Date.now()}`, { cache: "no-store" });
    return readJson(r, { tasks: [] }, "GET /api/tasks");
  },

  async removeTagFromAll(tag: string): Promise<number> {
    const r = await fetch(`${API}/remove-tag`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag }),
    });
    const data = await r.json() as { removed: number; error?: string };
    if (!r.ok) throw new Error(data.error ?? "Could not remove the tag.");
    return data.removed;
  },

  async createTask(
    data: Partial<Task>,
  ): Promise<{ success: boolean; task?: Task }> {
    const r = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    return readJson(r, { success: false }, "POST /api/tasks");
  },

  async updateTask(
    id: string,
    data: Partial<Task>,
  ): Promise<{ success: boolean; task?: Task }> {
    const r = await fetch(`${API}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    return readJson(r, { success: false }, `PATCH /api/tasks/${id}`);
  },

  async deleteTask(
    id: string,
    unlinkChildren?: boolean,
    deleteChildren?: boolean,
  ): Promise<void> {
    const params = new URLSearchParams();
    // Recursive delete wins when both flags are passed.
    if (deleteChildren) params.set("deleteChildren", "true");
    else if (unlinkChildren) params.set("unlinkChildren", "true");
    const qs = params.size > 0 ? `?${params}` : "";
    await fetch(`${API}/${encodeURIComponent(id)}${qs}`, {
      method: "DELETE",
    });
  },

  /** Unlink a child task from its parent — only removes the parent link, never deletes. */
  async detachTask(id: string): Promise<void> {
    await fetch(`${API}/${encodeURIComponent(id)}/detach`, {
      method: "POST",
    });
  },

  /** Record the current user as having opened a task (persistent read state). */
  async markOpened(taskId: string): Promise<void> {
    await fetch(`${API}/${encodeURIComponent(taskId)}/opened`, {
      method: "POST",
    });
  },

  /** Persist the current user's expand/collapse choice for a card. */
  async setTaskExpanded(taskId: string, expanded: boolean): Promise<void> {
    await fetch(`${API}/${encodeURIComponent(taskId)}/expanded`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expanded }),
    });
  },

  async getComments(taskId: string): Promise<{ comments: Comment[] }> {
    const r = await fetch(`${API}/${taskId}/comments`);
    const data = await readJson<{ comments: Comment[] }>(
      r,
      { comments: commentsCache.get(taskId) ?? [] },
      `GET /api/tasks/${taskId}/comments`,
    );
    commentsCache.set(taskId, data.comments ?? []);
    return data;
  },

  async addComment(taskId: string, text: string): Promise<void> {
    await fetch(`${API}/${taskId}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ author: "user", text, source: "web" }),
    });
  },

  async updateComment(
    taskId: string,
    commentId: string,
    text: string,
  ): Promise<void> {
    await fetch(`${API}/${taskId}/comments/${commentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
  },

  async deleteComment(taskId: string, commentId: string): Promise<void> {
    await fetch(`${API}/${taskId}/comments/${commentId}`, { method: "DELETE" });
  },

  async getFiles(taskId: string): Promise<{ files: FileEntry[] }> {
    const r = await fetch(`${API}/${taskId}/files`);
    const data = await readJson<{ files: FileEntry[] }>(
      r,
      { files: filesCache.get(taskId) ?? [] },
      `GET /api/tasks/${taskId}/files`,
    );
    filesCache.set(taskId, data.files ?? []);
    return data;
  },

  async uploadFile(taskId: string, file: File): Promise<void> {
    const buf = await file.arrayBuffer();
    await fetch(`${API}/${taskId}/files/${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: buf,
    });
  },

  async deleteFile(taskId: string, filename: string): Promise<void> {
    await fetch(`${API}/${taskId}/files/${encodeURIComponent(filename)}`, {
      method: "DELETE",
    });
  },

  async getProject(): Promise<{
    name?: string;
    gitUserName?: string;
    branch?: string | null;
  }> {
    const r = await fetch(`${BASE}/api/project`);
    return readJson(r, {}, "GET /api/project");
  },

  async getSettings(): Promise<Record<string, unknown>> {
    const r = await fetch(`${BASE}/api/settings`, { cache: "no-store" });
    return readJson(r, {}, "GET /api/settings");
  },

  async saveSettings(settings: Record<string, unknown>): Promise<void> {
    await fetch(`${BASE}/api/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
  },

  wsUrl(): string {
    const wsScheme = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${wsScheme}//${window.location.host}`;
  },
};
