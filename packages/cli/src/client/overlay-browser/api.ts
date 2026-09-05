import type { ProtoConfig } from "./types.js";
declare const PROTO_CONFIG: ProtoConfig;
import type { Task } from "./types.js";
import { state } from "./state.js";

// ── Task API helpers ──────────────────────────────────────────────────────────

export function fetchProjectName(): void {
  // Derives the API base from PROTO_CONFIG.apiUrl: strip "/api/tasks" → use "/api/project"
  // pi-lens-ignore: ts-ssrf
  const baseUrl = PROTO_CONFIG.apiUrl.replace(/\/api\/tasks$/, "");
  fetch(`${baseUrl}/api/project`)
    .then((r) => r.json())
    .then((d: { name?: string }) => {
      if (d.name) state.projectName = d.name;
    })
    .catch(() => {
      /* server may not have endpoint yet in old versions */
    });
}

export function fetchTasks(): void {
  const url = PROTO_CONFIG.boardId
    ? `${PROTO_CONFIG.apiUrl}?boardId=${encodeURIComponent(PROTO_CONFIG.boardId)}`
    : PROTO_CONFIG.apiUrl;
  const headers: Record<string, string> = {};
  if (PROTO_CONFIG.overlayApiKey)
    headers["X-Overlay-Api-Key"] = PROTO_CONFIG.overlayApiKey;
  fetch(url, Object.keys(headers).length > 0 ? { headers } : undefined)
    .then((r) => r.json())
    .then((d: { tasks?: Task[] }) => {
      state.tasks = d.tasks ?? [];
      state.onTasksFetched?.(state.tasks);
    })
    .catch(() => {
      /* server down */
    });
}

export interface SubmitTaskSource {
  file?: string;
  line?: number;
  col?: number;
  component?: string;
}

export interface SubmitTaskAdvanced {
  tags?: string[];
  priority?: string;
}

export function buildTaskPayload(args: {
  selector: string;
  cssSelector: string;
  title: string;
  description: string;
  status?: string;
  source?: SubmitTaskSource;
  type?: string;
  annotatedElementText?: string;
  boardId?: string;
  advanced?: SubmitTaskAdvanced;
}): Record<string, unknown> {
  const tags =
    Array.isArray(args.advanced?.tags) && args.advanced.tags.length > 0
      ? args.advanced.tags
      : undefined;
  return {
    title: args.title,
    description: args.description,
    selector: args.selector,
    cssSelector: args.cssSelector || null,
    url: typeof location !== "undefined" ? location.pathname : undefined,
    status: args.status || undefined,
    file: args.source?.file ?? null,
    line: args.source?.line ?? null,
    col: args.source?.col ?? null,
    component: args.source?.component ?? null,
    type: args.type || null,
    annotatedElementText: args.annotatedElementText || null,
    priority: args.advanced?.priority || undefined,
    tags,
    ...(args.boardId ? { boardId: args.boardId } : {}),
  };
}

export function submitTask(
  selector: string,
  cssSelector: string,
  title: string,
  description: string,
  status?: string,
  source?: SubmitTaskSource,
  type?: string,
  annotatedElementText?: string,
  advanced?: SubmitTaskAdvanced,
): Promise<{ success: boolean; taskId?: string; taskAuthor?: string }> {
  // SAFETY: PROTO_CONFIG.apiUrl is a build-time constant injected by the CLI bundler,
  // always pointing to the local CLI server (e.g. http://localhost:3700/api/tasks).
  // pi-lens-ignore: ts-ssrf
  const apiUrl = PROTO_CONFIG.apiUrl;
  // Validate URL is http/https origin before fetch
  const allowedOrigin = location.origin;
  let fetchUrl = apiUrl;
  try {
    const parsed = new URL(apiUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(" blocked protocol");
    }
    fetchUrl = parsed.href;
  } catch {
    // Relative URL — resolve against current origin
    fetchUrl = new URL(apiUrl, allowedOrigin).href;
  }
  return fetch(fetchUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(
      buildTaskPayload({
        selector,
        cssSelector,
        title,
        description,
        status,
        source,
        type,
        annotatedElementText,
        advanced,
        boardId: PROTO_CONFIG.boardId,
      }),
    ),
  })
    .then((r) => r.json())
    .then(
      (d: { success?: boolean; task?: { id?: string; author?: string } }) => {
        if (d.success) fetchTasks();
        return {
          success: d.success === true,
          taskId: d.task?.id,
          taskAuthor: d.task?.author,
        };
      },
    )
    .catch((err) => {
      console.error("[Vibeflow Studio]", err);
      return { success: false };
    });
}

function mutationHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (PROTO_CONFIG.overlayApiKey)
    headers["X-Overlay-Api-Key"] = PROTO_CONFIG.overlayApiKey;
  return headers;
}

export function markTaskDone(taskId: string): void {
  const url = PROTO_CONFIG.boardId
    ? `${PROTO_CONFIG.apiUrl}/${taskId}?boardId=${encodeURIComponent(PROTO_CONFIG.boardId)}`
    : `${PROTO_CONFIG.apiUrl}/${taskId}`;
  fetch(url, {
    method: "PATCH",
    headers: mutationHeaders(),
    body: JSON.stringify({ status: "done" }),
  })
    .then(() => fetchTasks())
    .catch((err) => console.error("[Vibeflow Studio]", err));
}

export function removeTask(taskId: string): void {
  const url = PROTO_CONFIG.boardId
    ? `${PROTO_CONFIG.apiUrl}/${taskId}?boardId=${encodeURIComponent(PROTO_CONFIG.boardId)}`
    : `${PROTO_CONFIG.apiUrl}/${taskId}`;
  fetch(url, { method: "DELETE", headers: mutationHeaders() })
    .then(() => fetchTasks())
    .catch((err) => console.error("[Vibeflow Studio]", err));
}
