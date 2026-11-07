import type { Task } from "./types";

/**
 * Merge a WebSocket `task-changed` payload into the client's stored task.
 *
 * Every `task-changed` broadcast carries a COMPLETE task (audited at every
 * `broadcast({ type: "task-changed", ... })` call site in the CLI server), so
 * each mapped field prefers the payload and falls back to `existing`.
 *
 * Two fields are deliberate exceptions:
 * - `commitPushed` is GET-only: `server.ts` computes it from git remotes and it
 *   never appears in a WS payload. It must be preserved from `existing` —
 *   mapping it from the payload would blank it on every frame.
 * - `verified` uses strict-boolean semantics: absence is a MEANINGFUL state
 *   (the "no verdict" state). `--set-verify cannot` writes `verified =
 *   undefined` and JSON.stringify drops the key, so a frame with no `verified`
 *   key must CLEAR a stored verdict, not preserve it. Falling back to
 *   `existing?.verified` here would leave a stale badge after `--set-verify
 *   cannot` and after claiming a task (which resets the verdict).
 *
 * The `satisfies` guard fails the build if a `Task` field is missing from the
 * mapped object — this is the structural fix for the allowlist bug class
 * (fields patched in one at a time: links, openedBy/expandedBy, verified).
 */
export function mergeTaskFromPayload(
  incoming: Record<string, unknown>,
  existing: Task | undefined,
): Task {
  const id = String(incoming.id ?? "");
  if (!id) {
    throw new Error("mergeTaskFromPayload: payload is missing a task id");
  }
  const incomingCreated = incoming.created ?? incoming.createdAt;
  const updated = incoming.updated ? String(incoming.updated) : undefined;
  const commentCount = Array.isArray(incoming.comments)
    ? (incoming.comments as Array<{ deleted?: boolean }>).filter(
        (c) => !c.deleted,
      ).length
    : undefined;
  // Prefer the server-computed fileCount (listFiles source, includes
  // unregistered files on disk) over the refs-only files array length.
  const fileCount =
    typeof incoming.fileCount === "number"
      ? incoming.fileCount
      : Array.isArray(incoming.files)
        ? incoming.files.length
        : undefined;
  const newStatus = incoming.status
    ? (String(incoming.status) as Task["status"])
    : undefined;

  return {
    id,
    title: incoming.title
      ? String(incoming.title)
      : (existing?.title ?? "Untitled"),
    description:
      incoming.description == null
        ? (existing?.description ?? "")
        : String(incoming.description),
    status: (newStatus ?? existing?.status ?? "todo") as Task["status"],
    type: incoming.type
      ? (String(incoming.type) as Task["type"])
      : existing?.type,
    priority: incoming.priority
      ? (String(incoming.priority) as Task["priority"])
      : existing?.priority,
    agent: incoming.agent ? String(incoming.agent) : existing?.agent,
    model: incoming.model ? String(incoming.model) : existing?.model,
    selector: incoming.selector
      ? String(incoming.selector)
      : existing?.selector,
    cssSelector: incoming.cssSelector
      ? String(incoming.cssSelector)
      : existing?.cssSelector,
    file: incoming.file ? String(incoming.file) : existing?.file,
    line: typeof incoming.line === "number" ? incoming.line : existing?.line,
    col: typeof incoming.col === "number" ? incoming.col : existing?.col,
    component: incoming.component
      ? String(incoming.component)
      : existing?.component,
    url: incoming.url ? String(incoming.url) : existing?.url,
    reportBack: incoming.reportBack === true || existing?.reportBack === true,
    commit: incoming.commit ? String(incoming.commit) : existing?.commit,
    commits: Array.isArray(incoming.commits)
      ? (incoming.commits as {
          sha: string;
          message: string;
          timestamp: string;
        }[])
      : existing?.commits,
    // GET-only server-computed field: never present in a WS payload, so it
    // must be preserved from existing rather than mapped from the payload.
    commitPushed: existing?.commitPushed,
    commentCount: commentCount ?? existing?.commentCount,
    fileCount: fileCount ?? existing?.fileCount,
    files: Array.isArray(incoming.files)
      ? (incoming.files as Task["files"])
      : existing?.files,
    createdAt: incomingCreated
      ? String(incomingCreated)
      : (existing?.createdAt ?? new Date().toISOString()),
    updatedAt: updated ?? existing?.updatedAt,
    authorName: incoming.authorName
      ? String(incoming.authorName)
      : existing?.authorName,
    author: incoming.author ? String(incoming.author) : existing?.author,
    assigneeName: incoming.assigneeName
      ? String(incoming.assigneeName)
      : existing?.assigneeName,
    // Ephemeral agent-involvement flag (0b7c45c5): carried through live
    // patches like other per-user state, never stored — absent stays absent.
    assigneeIsAgent:
      typeof incoming.assigneeIsAgent === "boolean"
        ? incoming.assigneeIsAgent
        : existing?.assigneeIsAgent,
    annotatedElementText: incoming.annotatedElementText
      ? String(incoming.annotatedElementText)
      : existing?.annotatedElementText,
    sortKey: incoming.sortKey
      ? String(incoming.sortKey)
      : existing?.sortKey,
    tags: Array.isArray(incoming.tags)
      ? (incoming.tags as string[])
      : existing?.tags,
    branchName: incoming.branchName
      ? String(incoming.branchName)
      : existing?.branchName,
    // Absence is the "no verdict" state — never fall back to existing here.
    verified:
      typeof incoming.verified === "boolean" ? incoming.verified : undefined,
    // Needs-attention flag (ticket 0752d55c): same absence rule — a live
    // payload without the key means "not flagged", never a stale badge.
    needsAttention:
      typeof incoming.needsAttention === "boolean"
        ? incoming.needsAttention
        : undefined,
    // Reason-comment link (ticket 0752d55c, reason-link fix): same
    // absence rule — a payload without a non-empty id means "no link",
    // and the feed falls back to the proxy (older records / online).
    attentionReasonId:
      typeof incoming.attentionReasonId === "string" &&
      incoming.attentionReasonId.length > 0
        ? incoming.attentionReasonId
        : undefined,
    links: Array.isArray(incoming.links)
      ? (incoming.links as Task["links"])
      : (existing?.links ?? []),
    // Per-user state — carried through WS updates, never dropped.
    openedBy: Array.isArray(incoming.openedBy)
      ? (incoming.openedBy as string[])
      : existing?.openedBy,
    expandedBy: Array.isArray(incoming.expandedBy)
      ? (incoming.expandedBy as string[])
      : existing?.expandedBy,
  } satisfies Record<keyof Task, unknown>;
}

/**
 * Stable signature of a task-like's embedded comment list (ticket 0752d55c,
 * round 2). A CLI/MCP `--set-attention --comment` writes the flag AND the
 * reason comment straight to the task file, so the file-watcher
 * `task-changed` frame carries both but no `changed` parts — the board
 * cannot tell from the frame type that the open panel's comment list is
 * stale. Comparing this signature before/after the merge tells the host
 * exactly when to refetch comments, so the reason reaches the feed live
 * next to its tinted flag row. Deleted entries count (a delete changes the
 * visible feed), text is included (an edit keeps the id), order is
 * preserved (a reorder is a visible change).
 */
export function commentListSignature(taskLike: unknown): string {
  const list =
    typeof taskLike === "object" && taskLike !== null && "comments" in taskLike
      ? taskLike.comments
      : undefined;
  if (!Array.isArray(list)) return "";
  return list
    .map((c) => {
      const row = typeof c === "object" && c !== null ? c : null;
      const id = row !== null && "id" in row ? String(row.id) : "";
      const live =
        row !== null && "deleted" in row && row.deleted === true ? "0" : "1";
      const text = row !== null && "text" in row ? String(row.text) : "";
      return [id, live, text].join(":");
    })
    .join("\n");
}
