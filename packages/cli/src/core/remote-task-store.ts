/**
 * Remote read adapter (ticket d7b9dc13, parent e7482da5).
 *
 * The READ half of the `TaskStore` ports, backed by the online board instead
 * of the local files. Local MCP operations running under `mode: "saas"` read
 * through here, so they see the same source of truth the CLI's online paths
 * read — a stale local copy can never look current, and a remote failure
 * refuses instead of falling back to local files.
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
 * - Writes are not routed here (P3/P4 own remote mutations): every
 *   mutating method throws `RemoteWriteNotRoutedError`, loudly, so a
 *   misrouted write fails instead of landing on the wrong backend.
 */
import {
  fetchSaasTaskDetail,
  fetchSaasTasks,
  resolveSaasTaskId,
  toCliStatus,
  type SaasTask,
} from "../saas/client.js";
import { resolveBoardScope } from "../auth/board-scope.js";
import type {
  ClaimOptions,
  ClaimPreview,
  OperationPorts,
  TaskResolveOutcome,
  TaskStore,
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
      `Remote writes are not routed yet (P3/P4 own them) — ${method} must run against the local ports`,
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
    return new RemoteReadError("E_NOT_AUTHENTICATED", error.message, {
      suggestion: "Run 'vibeflow auth login' and retry.",
      retryable: false,
    });
  }
  if (error.status === 401 || error.status === 403) {
    return new RemoteReadError("E_NOT_AUTHENTICATED", error.message, {
      suggestion: "The token was rejected — run 'vibeflow auth login' and retry.",
      retryable: false,
    });
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
  return new RemoteReadError("E_BACKEND_UNAVAILABLE", error.message, {
    suggestion: fallbackSuggestion,
    retryable: error.code === "NETWORK_ERROR",
  });
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
  } as Task;
}

/** A detail response whose record does not map is unreadable, never empty. */
function requireTask(row: SaasTask, taskId: string): Task {
  const mapped = toLocalTask(row);
  if (!mapped) {
    throw new RemoteReadError(
      "REMOTE_MALFORMED_RECORD",
      `The board answered task ${taskId} with a record that does not parse — refusing rather than presenting it as current.`,
      { retryable: false },
    );
  }
  return mapped;
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
): Promise<{ outcome: "resolved"; task: Task } | { outcome: "missing"; id: string }> {
  const board = await fetchSaasTasks(boardId, { hydrate: false });
  if (!board.ok) {
    throw toRemoteRefusal(board.error, "Check the backend is reachable and retry the read.");
  }
  const rows = board.data.tasks;
  const valid = rows.filter((r) => toLocalTask(r) !== null);
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
  return { outcome: "resolved", task: requireTask(detail.data.task, resolved.id) };
}

/**
 * READ-only remote `TaskStore`. Every method that would write throws
 * `RemoteWriteNotRoutedError`; every read resolves the board once and
 * refuses loudly on any failure — local files are never consulted here.
 */
class RemoteTaskStore implements TaskStore {
  async listTasks(): Promise<Task[]> {
    const boardId = await resolveBoardOnce();
    const board = await fetchSaasTasks(boardId, { hydrate: false });
    if (!board.ok) {
      throw toRemoteRefusal(board.error, "Check the backend is reachable and retry the read.");
    }
    const out: Task[] = [];
    for (const row of board.data.tasks) {
      const mapped = toLocalTask(row);
      // A list row that does not map is SKIPPED, not fatal: one malformed
      // row must not hide the whole board (detail reads stay strict —
      // presenting one current record demands a parseable answer).
      if (mapped) out.push(mapped);
    }
    return out;
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
    if (detail.ok) return { status: "found", id: detail.data.task.id, task: requireTask(detail.data.task, idOrPrefix) };
    if (detail.error.code !== "TASK_NOT_FOUND") {
      throw toRemoteRefusal(detail.error, "Check the backend is reachable and retry the read.");
    }
    const prefix = await resolvePrefix(boardId, idOrPrefix);
    if (prefix.outcome === "missing") return { status: "missing", id: idOrPrefix };
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
  async createTask(): Promise<never> {
    throw new RemoteWriteNotRoutedError("createTask");
  }
  async updateTask(): Promise<never> {
    throw new RemoteWriteNotRoutedError("updateTask");
  }
  async deleteTask(): Promise<never> {
    throw new RemoteWriteNotRoutedError("deleteTask");
  }
  async addComment(): Promise<never> {
    throw new RemoteWriteNotRoutedError("addComment");
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
  async claimNextTaskAtomic(_p: string, _o?: ClaimOptions): Promise<never> {
    throw new RemoteWriteNotRoutedError("claimNextTaskAtomic");
  }
  async previewClaim(_p: string, _o?: ClaimOptions): Promise<ClaimPreview | null> {
    throw new RemoteWriteNotRoutedError("previewClaim");
  }
}

export const remoteTaskStore: TaskStore = new RemoteTaskStore();

/** Narrowing helper so operations forward remote refusals without relabelling. */
export function isRemoteReadError(err: unknown): err is RemoteReadError {
  return err instanceof RemoteReadError;
}

export type { OperationPorts };
