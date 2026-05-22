import type { ProtoConfig } from "./types.js";
declare const PROTO_CONFIG: ProtoConfig;
import type { Task } from "./types.js";
import { state } from "./state.js";

// ── Task API helpers ──────────────────────────────────────────────────────────

export function fetchProjectName(): void {
  // Derives the API base from PROTO_CONFIG.apiUrl: strip "/api/tasks" → use "/api/project"
  const baseUrl = PROTO_CONFIG.apiUrl.replace(/\/api\/tasks$/, "");
  fetch(`${baseUrl}/api/project`)
    .then(r => r.json())
    .then((d: { name?: string }) => { if (d.name) state.projectName = d.name; })
    .catch(() => { /* server may not have endpoint yet in old versions */ });
}

export function fetchTasks(): void {
  const url = PROTO_CONFIG.boardId
    ? `${PROTO_CONFIG.apiUrl}?boardId=${encodeURIComponent(PROTO_CONFIG.boardId)}`
    : PROTO_CONFIG.apiUrl;
  const headers: Record<string, string> = {};
  if (PROTO_CONFIG.overlayApiKey) headers["X-Overlay-Api-Key"] = PROTO_CONFIG.overlayApiKey;
  fetch(url, Object.keys(headers).length > 0 ? { headers } : undefined)
    .then(r => r.json())
    .then((d: { tasks?: Task[] }) => {
      state.tasks = d.tasks ?? [];
      state.onTasksFetched?.(state.tasks);
    })
    .catch(() => { /* server down */ });
}

export interface SubmitTaskSource {
  file?: string;
  line?: number;
  col?: number;
  component?: string;
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
): void {
  fetch(PROTO_CONFIG.apiUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      description,
      selector,
      cssSelector: cssSelector || null,
      url: location.pathname,
      status: status || undefined,
      file: source?.file ?? null,
      line: source?.line ?? null,
      col: source?.col ?? null,
      component: source?.component ?? null,
      type: type || null,
      annotatedElementText: annotatedElementText || null,
      ...(PROTO_CONFIG.boardId ? { boardId: PROTO_CONFIG.boardId } : {}),
    }),
  })
    .then(r => r.json())
    .then((d: { success?: boolean }) => { if (d.success) fetchTasks(); })
    .catch(err => console.error("[Vibeflow Studio]", err));
}

function mutationHeaders(): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (PROTO_CONFIG.overlayApiKey) headers["X-Overlay-Api-Key"] = PROTO_CONFIG.overlayApiKey;
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
    .catch(err => console.error("[Vibeflow Studio]", err));
}

export function removeTask(taskId: string): void {
  const url = PROTO_CONFIG.boardId
    ? `${PROTO_CONFIG.apiUrl}/${taskId}?boardId=${encodeURIComponent(PROTO_CONFIG.boardId)}`
    : `${PROTO_CONFIG.apiUrl}/${taskId}`;
  fetch(url, { method: "DELETE", headers: mutationHeaders() })
    .then(() => fetchTasks())
    .catch(err => console.error("[Vibeflow Studio]", err));
}
