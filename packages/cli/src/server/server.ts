import { taskReadNotices, type TaskReadFinding } from "../core/task-record-read.js";
import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { join, resolve, basename, extname, dirname } from "node:path";
import { createServer } from "node:http";
import { execSync } from "node:child_process";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import chalk from "chalk";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { mountMcp, disposeMcp } from "../mcp/http.js";
import {
  ChatSessionManager,
  isAgentChatEnabled,
} from "./agent-chat/sessions.js";
import { registerChatRoutes } from "./agent-chat/routes.js";
import { injectScript } from "../core/html-parser.js";
import { createFileWatcher, createTaskWatcher } from "./watcher.js";
import {
  getOverlayScript,
  getOverlaySaasScript,
} from "../client/overlay/index.js";
import {
  getKanbanHtml,
  isKanbanDevMode,
  readKanbanDevBundle,
  resolveKanbanDevBundlePath,
  KANBAN_DEV_BUNDLE_MISSING,
  KANBAN_DEV_BUNDLE_ROUTE,
  KANBAN_RELOAD_MESSAGE_TYPE,
  type KanbanOptions,
} from "./kanban-template.js";
import {
  buildBoardsAndApisLines,
  buildBookmarkletLines,
  buildIntegrateIntoAppLines,
  buildIntegrationGuide,
  buildOnlineAddToHtmlLines,
  guideDivider,
  localhostAltLine,
  printGuideLines,
  resolveDisplayUrl,
  type GuideUrls,
  type IntegrationGuide,
} from "./startup-guide.js";

/** Startup-banner rule + guide construction, re-exported from the guide
 * module so `server.ts` stays the single import site for the banner helpers. */
export {
  localhostAltLine,
  localhostScriptTagAltLine,
} from "./startup-guide.js";
import {
  buildChangelogResponse,
  readChangelogContent,
} from "../core/changelog.js";
import { getProjectName, getCurrentBranch } from "../core/config.js";
import {
  assertSafeProjectDir,
  formatProjectRootAnnouncement,
} from "../core/project-root.js";
import {
  createTask,
  listTasks,
  listTasksWithPaths,
  updateTask,
  deleteTask,
  detachParent,
  getDescendantIds,
  ensureTaskDirs,
  readTaskFile,
  findTaskFilePath,
  markTaskOpened,
  setTaskExpanded,
  getCurrentUserId,
  resolveTaskId,
} from "../core/tasks.js";
import {
  listComments,
  addComment,
  // pi-lens-ignore: no-server-bind-wildcard
  updateComment,
  deleteComment,
} from "../core/comments.js";
import {
  listFiles,
  saveFile,
  deleteFile,
  getFilePath,
  getFileCount,
  isValidFilename,
  isAllowedFileExtension,
  migrateAllLegacyLinkedRefs,
} from "../core/files.js";
import { encryptAuthState } from "../core/auth.js";
import { loadSettings, saveSettings } from "../core/settings.js";
import { readToken } from "../auth/token.js";
import { readWorkspace } from "../auth/workspace.js";
import { createTasksOneByOne } from "../auth/login.js";
import { surfacePath } from "../core/api-url.js";
import { appRouter } from "./trpc.js";
import {
  wasmAssetNames,
  wasmAssetPath,
  type WasmAssetName,
} from "./imageNodeCodecs.js";
import type { ServeOptions, Task } from "../core/types.js";
import { TASK_STATUSES } from "../core/types.js";
import { PROTO_DIR, TASKS_DIR, SCREENSHOTS_DIR } from "../core/types.js";
import { getGitUser } from "../core/git-user.js";
import { OPENAPI_JSON } from "./openapi.gen.js";
import { registerV0ReadAlias } from "./v0.js";
import { registerDocsViewer } from "./docs.js";
import { isLoopbackOrigin } from "../core/loopback.js";
import {
  installCliProcessErrorHandlers,
  registerClientErrorRoute,
  reportCliError,
} from "./cli-error-report.js";
import type { FSWatcher } from "chokidar";

/** Validates task IDs to prevent path traversal attacks. Task IDs are hex strings:
 * 30 chars (15 random bytes, current format) or 8 chars (legacy format that
 * predates this validator — still present in real projects, e.g. `130ed97a`). */
export function isValidTaskId(id: string): boolean {
  return /^[a-f0-9]{8}$/.test(id) || /^[a-f0-9]{30}$/.test(id);
}

/** Validates comment IDs to prevent path traversal attacks. Comment IDs are
 * 16 hex chars (8 random bytes, current `addComment` format) or legacy formats
 * still present in real projects: 10–14 lowercase alphanumerics (SaaS-era IDs
 * such as `mnrrhpi0f9mxv`, including 10-digit numeric ones like `3839427352`)
 * and hand-written slugs containing `-`/`_` (e.g. `fix-comment-1`, `align_impl`).
 * Comment IDs are only JSON lookup keys, never filesystem paths, so the guard
 * only needs to reject separators, dots, and encoding tricks. */
export function isValidCommentId(id: string): boolean {
  return (
    /^[a-f0-9]{16}$/.test(id) ||
    /^[a-z0-9]{10,14}$/.test(id) ||
    /^(?=.*[-_])[A-Za-z0-9_-]{1,64}$/.test(id)
  );
}

/** Rejects POST/DELETE from cross-origin pages. Returns false and sends 403 if origin is disallowed. */
function requireSameOrigin(
  req: express.Request,
  res: express.Response,
): boolean {
  const origin = req.headers.origin;
  if (origin && !isLoopbackOrigin(origin)) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

/** Valid status values accepted when creating a task via POST /api/tasks. */
const VALID_CREATE_STATUSES = TASK_STATUSES;

// Production app origin. `freemium.vibeflow.tools` used to be listed here; that
// host was dropped on 2026-10-16 (Caddy answers 404), so only the host that is
// actually served belongs in this allowlist.
const ALLOWED_WORKSPACE_ORIGINS = new Set(["https://app.vibeflow.tools"]);

/** Validates workspace URL against known production domains to prevent SSRF. */
function sanitizeWorkspaceOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const origin = new URL(url).origin;
    return ALLOWED_WORKSPACE_ORIGINS.has(origin) ? origin : null;
  } catch {
    return null;
  }
}

export interface ServeInstance {
  url: string;
  /** Present (non-null) only when bound to 0.0.0.0 — localhost twin of `url`. */
  localUrl?: string | null;
  /**
   * Every URL and integration snippet for this instance, derived by the ONE
   * guide builder (server/startup-guide.ts). Programmatic callers read the
   * startup guide from here instead of having it printed — see
   * `ServeOptions.quiet`.
   */
  guide: IntegrationGuide;
  close: () => Promise<void>;
}

type BroadcastFn = (data: Record<string, unknown>) => void;

/**
 * Agent chat registration (ticket 0847833f): creates the per-serve chat
 * session manager and mounts the chat REST + MCP endpoints — but ONLY
 * when VIBEFLOW_FEATURES includes CHAT (default OFF). Returns the manager for
 * shutdown cleanup, or null when the flag is off (zero new surface).
 * The pi child always dials localhost: the agent runs on the same
 * machine as `serve`, never across the network.
 */
function maybeRegisterChat(
  app: import("express").Express,
  opts: { projectDir: string; port: number; broadcast: BroadcastFn },
): ChatSessionManager | null {
  if (!isAgentChatEnabled()) return null;
  const manager = new ChatSessionManager({
    projectDir: opts.projectDir,
    serverOrigin: `http://localhost:${opts.port}`,
  });
  registerChatRoutes(app, {
    manager,
    broadcast: opts.broadcast,
    projectDir: opts.projectDir,
  });
  return manager;
}

/** Panel data parts a tasks-updated broadcast invalidates. The open detail
 * panel refetches ONLY the listed parts (coalesced to one round) — absence
 * of `changed` means no panel refetch is needed, just the board list reload.
 * File add/remove also writes a system comment trace, so those broadcasts
 * list both parts; screenshot set/clear only touches task fields (`task`). */
type PanelChangedPart = "comments" | "files" | "task";

/** Broadcast a tasks-updated event, optionally scoped to a specific task. */
function broadcastTaskUpdated(
  broadcast: BroadcastFn,
  taskId?: string,
  changed?: PanelChangedPart[],
): void {
  broadcast({
    type: "tasks-updated",
    ...(taskId && { taskId }),
    ...(changed && { changed }),
  });
}

// Injected at build time by tsup; undefined in raw TypeScript runs.
declare const __VIBEFLOW_CLI_VERSION__: string | undefined;

/** Current CLI version for the kanban "What's New" modal; "" when unknown. */
const CLI_VERSION =
  typeof __VIBEFLOW_CLI_VERSION__ === "undefined"
    ? ""
    : __VIBEFLOW_CLI_VERSION__;

/** The URLs a bound server is reachable on. Delegates to the ONE host→URL
 * rule in the guide module, so `serve()` and the `start_kanban` dry-run
 * preview can never disagree about what URL a host/port pair means. */
export const resolveServeUrls = resolveDisplayUrl;

/** Registers /api/pages — returns the list of HTML pages being served. */
function registerPagesApi(app: express.Application, pages: string[]): void {
  app.get("/api/pages", (_req, res) => {
    res.json({ pages });
  });
}

/** Cache of commit SHAs per project directory (refreshed every 5 minutes). */
const remoteCommitCache = new Map<
  string,
  { shas: Set<string>; fetchedAt: number }
>();

/** Returns the set of commit SHAs currently on the git remote (cached for 5 min). */
function getRemoteCommitShas(projectDir: string): Set<string> {
  const CACHE_TTL_MS = 5 * 60 * 1000;
  const cached = remoteCommitCache.get(projectDir);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.shas;
  }
  try {
    const output = execSync("git log --remotes --format=%H", {
      cwd: projectDir,
      timeout: 5000,
    })
      .toString()
      .trim();
    const shas = new Set(output ? output.split("\n") : []);
    remoteCommitCache.set(projectDir, { shas, fetchedAt: Date.now() });
    return shas;
  } catch {
    return new Set();
  }
}

/** Returns true if the commit SHA is on any remote branch. */
function isCommitPushed(
  sha: string | undefined | null,
  remoteShas: Set<string>,
): boolean | null {
  if (!sha) return null;
  return remoteShas.has(sha);
}

/** Registers all /api/tasks routes on the given Express app. */
function registerTaskApi(
  app: express.Application,
  projectDir: string,
  broadcast: BroadcastFn,
): void {
  // Returns project metadata: name derived from package.json or directory name,
  // plus the current git branch. Used by the kanban UI.
  app.get("/api/project", (_req, res) => {
    res.json({
      name: getProjectName(projectDir),
      projectDir,
      branch: getCurrentBranch(projectDir),
      gitUserName: getGitUser(projectDir).name,
    });
  });

  // Health check — used by overlay and kanban clients to poll connection status.
  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  // CLI changelog — powers the kanban "What's New" modal and full-changelog view.
  app.get("/api/changelog", (_req, res) => {
    res.json(buildChangelogResponse(readChangelogContent()));
  });

  app.get("/api/tasks", (req, res) => {
    const reads: TaskReadFinding[] = [];
    let tasks = listTasks(projectDir, reads);
    const remoteShas = getRemoteCommitShas(projectDir);

    // Support ?status=<status> query parameter for filtering
    const statusFilter = req.query.status as string | undefined;
    if (statusFilter && typeof statusFilter === "string") {
      tasks = tasks.filter((t) => t.status === statusFilter);
    }

    // Support ?limit=<n> query parameter for limiting results
    const limitParam = req.query.limit as string | undefined;
    if (limitParam) {
      const limit = parseInt(limitParam, 10);
      if (!isNaN(limit) && limit > 0) {
        tasks = tasks.slice(0, limit);
      }
    }

    // commentCount and fileCount are included for the kanban UI badge without
    // exposing the full embedded arrays in the list response.
    // fileCount uses the same source as the files tab (listFiles) so the badge
    // also counts files on disk that are missing from the task JSON refs.
    const tasksWithMeta = tasks.map((t) => {
      const lastSha = t.commits?.length
        ? t.commits[t.commits.length - 1].sha
        : undefined;
      return {
        ...t,
        createdAt: t.created,
        commentCount: (t.comments ?? []).filter((c) => !c.deleted).length,
        fileCount: getFileCount(projectDir, t.id),
        commitPushed: isCommitPushed(lastSha, remoteShas),
      };
    });
    const notices = taskReadNotices(reads);
    res.json({ tasks: tasksWithMeta, ...(notices.length > 0 ? { notices } : {}) });
  });

  // Reject invalid task IDs at the router level to prevent path traversal on all :id routes.
  app.param("id", (_req, res, next, id: string) => {
    if (!isValidTaskId(id)) {
      res.status(400).json({ error: "Invalid task id" });
      return;
    }
    next();
  });

  // Reject invalid comment IDs at the router level to prevent path traversal on all :commentId routes.
  app.param("commentId", (_req, res, next, commentId: string) => {
    if (!isValidCommentId(commentId)) {
      res.status(400).json({ error: "Invalid comment id" });
      return;
    }
    next();
  });

  app.get("/api/tasks/:id", (req, res) => {
    const { id } = req.params;
    const filePath = findTaskFilePath(projectDir, id);
    const task = filePath ? readTaskFile(filePath) : null;
    if (!task) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const remoteShas = getRemoteCommitShas(projectDir);
    const lastSha = task.commits?.length
      ? task.commits[task.commits.length - 1].sha
      : undefined;
    res.json({ ...task, commitPushed: isCommitPushed(lastSha, remoteShas) });
  });

  app.post("/api/tasks", (req, res) => {
    const {
      title,
      description,
      selector,
      cssSelector,
      url,
      type,
      priority,
      file,
      line,
      col,
      component,
      status: reqStatus,
      agent,
      model,
      screenshot,
      annotatedElementText,
      tags,
      sortKey,
      links,
      parent,
    } = req.body as {
      title?: string;
      description?: string;
      selector?: string;
      cssSelector?: string;
      url?: string;
      type?: string;
      priority?: string;
      file?: string;
      line?: number;
      col?: number;
      component?: string;
      status?: string;
      agent?: string;
      model?: string;
      screenshot?: string;
      annotatedElementText?: string;
      tags?: string[];
      sortKey?: string;
      links?: Array<{ taskId: string; type: string }>;
      parent?: string;
    };

    if (!title || !selector) {
      res
        .status(400)
        .json({ error: "Missing required fields: title, selector" });
      return;
    }

    // Validate links on creation (self/cycle check)
    const validatedLinks = Array.isArray(links)
      ? links
          .filter(
            (l) =>
              l &&
              typeof l.taskId === "string" &&
              l.taskId.length > 0 &&
              typeof l.type === "string" &&
              ["parent", "relates", "blocks"].includes(l.type),
          )
          .map((l) => ({
            taskId: String(l.taskId),
            type: String(l.type) as import("../core/types.js").TaskLinkType,
          }))
      : undefined;

    if (validatedLinks && validatedLinks.length > 0) {
      // Cycle check on parent links (parent can't be the new task itself)
      // and validate target tasks exist
      const allTasks = listTasks(projectDir);
      for (const link of validatedLinks) {
        if (link.type === "parent") {
          // Parent target must exist and must not be a descendant of the
          // new task (impossible at create time since new task has no children)
          const targetExists = allTasks.some((t) => t.id === link.taskId);
          if (!targetExists) {
            res.status(400).json({
              error: `Parent target task ${link.taskId} not found`,
            });
            return;
          }
        }
      }
    }

    // Optional convenience: a single `parent` id (full or prefix) is resolved
    // and merged into the links array, mirroring the CLI `--add --parent` and
    // MCP `create_task` parent field. Dangling targets use the same wording as
    // the --set-parent path.
    let createLinks = validatedLinks;
    if (typeof parent === "string" && parent.length > 0) {
      const allTasks = listTasks(projectDir);
      const resolvedParentId = resolveTaskId(projectDir, parent);
      if (!allTasks.some((t) => t.id === resolvedParentId)) {
        res
          .status(400)
          .json({ error: `Parent task not found: ${resolvedParentId}` });
        return;
      }
      createLinks = [
        ...(validatedLinks ?? []),
        { taskId: resolvedParentId, type: "parent" },
      ];
    }

    const gitUser = getGitUser(projectDir);
    const task = createTask(projectDir, {
      title,
      description: description || "",
      selector,
      cssSelector: cssSelector || undefined,
      links: createLinks,
      url: url || undefined,
      status: (VALID_CREATE_STATUSES.includes(
        reqStatus as (typeof VALID_CREATE_STATUSES)[number],
      )
        ? reqStatus
        : "todo") as (typeof VALID_CREATE_STATUSES)[number],
      file: file || undefined,
      line: line == null ? undefined : Number(line),
      col: col == null ? undefined : Number(col),
      component: component || undefined,
      type: type || undefined,
      priority: priority || undefined,
      author: gitUser.name,
      agent: agent || undefined,
      model: model || undefined,
      annotatedElementText: annotatedElementText
        ? String(annotatedElementText).slice(0, 300)
        : undefined,
      tags: Array.isArray(tags)
        ? tags.filter((t): t is string => typeof t === "string" && t.length > 0)
        : undefined,
      sortKey: sortKey ? String(sortKey) : undefined,
    });

    if (screenshot) {
      const screenshotsDir = join(projectDir, PROTO_DIR, SCREENSHOTS_DIR);
      mkdirSync(screenshotsDir, { recursive: true });
      const filename = `${task.id}.png`;
      writeFileSync(
        join(screenshotsDir, filename),
        Buffer.from(screenshot, "base64"),
      );
      updateTask(projectDir, task.id, {
        screenshot: filename,
      } as Partial<Task>);
      task.screenshot = filename;
    }

    console.log(`[Vibeflow] Task created: "${task.title}" (${task.id})`);
    broadcast({ type: "tasks-updated" });
    res.json({ success: true, task });
  });

  app.patch("/api/tasks/:id", (req, res) => {
    const { id } = req.params;
    // Runtime whitelist: PATCH is the human/UI path — only safe fields allowed.
    // Comment/commit/verify gates are enforced at CLI/MCP surfaces only.
    const ALLOWED_PATCH_KEYS = new Set([
      "status",
      "title",
      "description",
      "type",
      "priority",
      "reportBack",
      "agent",
      "model",
      "tags",
      "sortKey",
      "branchName",
      "links",
    ]);
    const updates = Object.fromEntries(
      Object.entries(req.body as Record<string, unknown>).filter(([k]) =>
        ALLOWED_PATCH_KEYS.has(k),
      ),
    );

    if (
      updates.status !== undefined &&
      !(TASK_STATUSES as readonly string[]).includes(updates.status as string)
    ) {
      res.status(400).json({ error: `Invalid status: ${updates.status}` });
      return;
    }

    // Research gate: research tasks need a .md report to move to review
    if (updates.status === "review") {
      const task = readTaskFile(findTaskFilePath(projectDir, id) ?? "");
      if (task && (task.type ?? "").toLowerCase() === "research") {
        const files = listFiles(projectDir, id);
        const hasMdFile = files.some((f) => /\.md$/i.test(f.name));
        if (!hasMdFile) {
          res.status(422).json({ error: "RESEARCH_REPORT_REQUIRED" });
          return;
        }
      }
    }

    // Validate links if provided
    if (Array.isArray(updates.links)) {
      const linksArr = updates.links as Array<Record<string, unknown>>;
      for (const link of linksArr) {
        if (
          !link ||
          typeof link.taskId !== "string" ||
          link.taskId.length === 0 ||
          typeof link.type !== "string"
        ) {
          res.status(400).json({
            error:
              "Invalid link: each link needs taskId (string) and type (parent|relates|blocks)",
          });
          return;
        }
        if (
          link.type !== "parent" &&
          link.type !== "relates" &&
          link.type !== "blocks"
        ) {
          res.status(400).json({ error: `Invalid link type: ${link.type}` });
          return;
        }
        // Validate self-link (always rejected, even if already present)
        if (link.type === "parent" && link.taskId === id) {
          res.status(400).json({ error: "Cannot link a task to itself" });
          return;
        }
      }
      // Net-new-only validation: PATCH replaces links entirely, but only
      // links that are *new* (not already on the task) need duplicate/cycle
      // checks. This is idempotent — re-applying the same links array is a
      // no-op, not a duplicate error.
      const currentTask = readTaskFile(findTaskFilePath(projectDir, id) ?? "");
      if (currentTask) {
        const existingLinks = currentTask.links ?? [];

        // Reject duplicate entries within the incoming array itself
        const seenIncoming = new Set<string>();
        for (const link of linksArr) {
          const key = `${String(link.taskId)}::${String(link.type)}`;
          if (seenIncoming.has(key)) {
            res.status(409).json({
              error: `Duplicate link in payload: ${String(link.type)} → ${String(link.taskId)}`,
            });
            return;
          }
          seenIncoming.add(key);
        }

        // Parent-link replacement: if incoming has a parent and existing has
        // a different parent, that's allowed (parent swap). Deduplicate:
        // if the new parent == old parent, skip the cycle check.
        const existingParent = existingLinks.find((l) => l.type === "parent");
        const incomingParent = linksArr.find(
          (l) => String(l.type) === "parent",
        );
        if (
          existingParent &&
          incomingParent &&
          String(incomingParent.taskId) === existingParent.taskId
        ) {
          // Same parent — no new parent link, skip cycle check
        } else if (incomingParent) {
          // New or different parent — check for cycles by walking the
          // parent chain from the proposed parent upward (post-merge state).
          const allTasks = listTasks(projectDir);
          const visited = new Set<string>();
          let cur = String(incomingParent.taskId);
          let isCycle = false;
          while (!visited.has(cur)) {
            if (cur === id) {
              isCycle = true;
              break;
            }
            visited.add(cur);
            const task = allTasks.find((t) => t.id === cur);
            // If swapping parent, use the patched links for this task
            const parentLink =
              cur === id
                ? {
                    type: "parent" as const,
                    taskId: String(incomingParent.taskId),
                  }
                : task?.links?.find((l) => l.type === "parent");
            if (!parentLink) break;
            cur = parentLink.taskId;
          }
          if (isCycle) {
            res.status(409).json({
              error: `Cycle detected: setting parent to ${String(incomingParent.taskId)} would create a circular reference`,
            });
            return;
          }
        }
      }
    }

    const updated = updateTask(projectDir, id, updates);
    if (!updated) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    console.log(
      `[Vibeflow] Task updated: "${updated.title}" (${updated.id}) → status:${updated.status}`,
    );

    // Cascade done status: when a parent is moved to done, all descendants
    // are also marked done so the entire subtree completes together.
    const cascadedDescendants: (typeof updated)[] = [];
    if (updates.status === "done") {
      const allTasks = listTasks(projectDir);
      const descendantIds = getDescendantIds(allTasks, id);
      for (const descId of descendantIds) {
        const descUpdated = updateTask(projectDir, descId, { status: "done" });
        if (descUpdated) {
          cascadedDescendants.push(descUpdated);
          console.log(
            `[Vibeflow] Cascade done → "${descUpdated.title}" (${descUpdated.id})`,
          );
        }
      }
    }

    // Broadcast task-changed with the full payload so clients can apply surgical
    // state updates without re-fetching all tasks (avoids full-list re-render).
    // fileCount is computed from the same source as the list endpoints so the
    // live update does not clobber the badge with a refs-only undercount.
    broadcast({
      type: "task-changed",
      taskId: updated.id,
      action: "update",
      task: {
        ...updated,
        fileCount: getFileCount(projectDir, updated.id),
        cascadedDescendants: cascadedDescendants.map((d) => ({
          id: d.id,
          status: d.status,
        })),
      },
    });
    res.json({ success: true, task: updated });
  });

  // POST /api/tasks/:id/opened — record that the current user opened this task.
  // Mirrors `tasks --get`; the board fires it when a card is opened.
  app.post("/api/tasks/:id/opened", (req, res) => {
    const { id } = req.params;
    const filePath = findTaskFilePath(projectDir, id);
    if (!filePath) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    markTaskOpened(projectDir, id, getCurrentUserId());
    const task = readTaskFile(filePath);
    broadcast({
      type: "task-changed",
      taskId: id,
      action: "update",
      task: { ...task!, fileCount: getFileCount(projectDir, id) },
    });
    res.json({ success: true });
  });

  // POST /api/tasks/:id/expanded — persist the current user's expand/collapse
  // choice for a card's inline children (body: { expanded: boolean }).
  app.post("/api/tasks/:id/expanded", (req, res) => {
    const { id } = req.params;
    const updated = setTaskExpanded(
      projectDir,
      id,
      getCurrentUserId(),
      req.body?.expanded === true,
    );
    if (!updated) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    broadcast({
      type: "task-changed",
      taskId: updated.id,
      action: "update",
      task: { ...updated, fileCount: getFileCount(projectDir, updated.id) },
    });
    res.json({ success: true, task: updated });
  });

  app.delete("/api/tasks/:id", (req, res) => {
    const { id } = req.params;
    const unlinkChildren = req.query.unlinkChildren === "true";
    const deleteChildren = req.query.deleteChildren === "true";

    // Recursive delete wins when both flags are passed: remove the whole
    // subtree deepest-first so no child is ever orphaned on disk.
    if (deleteChildren) {
      const descendantIds = getDescendantIds(listTasks(projectDir), id);
      for (const descId of [...descendantIds].reverse()) {
        if (deleteTask(projectDir, descId)) {
          broadcast({ type: "task-deleted", taskId: descId });
        }
      }
    } else if (unlinkChildren) {
      const allTasks = listTasks(projectDir);
      const children = allTasks.filter((t) =>
        t.links?.some((l) => l.type === "parent" && l.taskId === id),
      );
      for (const child of children) {
        const newLinks = (child.links ?? []).filter(
          (l) => !(l.type === "parent" && l.taskId === id),
        );
        const updated = updateTask(projectDir, child.id, { links: newLinks });
        if (updated) {
          broadcast({
            type: "task-changed",
            taskId: updated.id,
            action: "update",
            task: {
              ...updated,
              fileCount: getFileCount(projectDir, updated.id),
            },
          });
        }
      }
    }

    const deleted = deleteTask(projectDir, id);
    if (!deleted) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    console.log(`[Vibeflow] Task deleted: ${id}`);
    // Broadcast task-deleted so clients can surgically remove the card.
    broadcast({ type: "task-deleted", taskId: id });
    res.json({ success: true });
  });

  // POST /api/tasks/:id/detach — unlink task from its parent without deleting it.
  // Only removes the parent link; children move up one level.
  // This is the ONLY unlink surface. Deletion is handled by DELETE /api/tasks/:id.
  app.post("/api/tasks/:id/detach", (req, res) => {
    const { id } = req.params;

    // Snapshot children BEFORE detachParent so we can broadcast affected
    // tasks. After detach: move-up re-parents them (old links gone).
    const preDetachAllTasks = listTasks(projectDir);
    const preDetachChildren = preDetachAllTasks.filter(
      (t) =>
        t?.id && t.links?.some((l) => l?.type === "parent" && l?.taskId === id),
    );

    const updated = detachParent(projectDir, id);
    if (!updated) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    // Broadcast the detached task update
    broadcast({
      type: "task-changed",
      taskId: updated.id,
      action: "update",
      task: { ...updated, fileCount: getFileCount(projectDir, updated.id) },
    });

    // Move-up: re-read children after detachParent (they now have updated
    // parent links pointing at the former parent) and broadcast each.
    const postDetachAllTasks = listTasks(projectDir);
    for (const child of preDetachChildren) {
      if (!child.id) continue;
      const refreshed = postDetachAllTasks.find((t) => t.id === child.id);
      if (refreshed) {
        broadcast({
          type: "task-changed",
          taskId: refreshed.id,
          action: "update",
          task: {
            ...refreshed,
            fileCount: getFileCount(projectDir, refreshed.id),
          },
        });
      }
    }

    console.log(`[Vibeflow] Task unlinked: ${id}`);
    res.json({ success: true, task: updated });
  });

  // Comments API
  app.get("/api/tasks/:id/comments", (req, res) => {
    const { id } = req.params;
    const comments = listComments(projectDir, id);
    res.json({ comments });
  });

  app.post("/api/tasks/:id/comments", async (req, res) => {
    const { id } = req.params;
    const { author, text, files, source } = req.body as {
      author?: string;
      text?: string;
      files?: string[];
      source?: "cli" | "web";
    };
    if (!text || !text.trim()) {
      res.status(400).json({ error: "Missing required field: text" });
      return;
    }
    const validAuthor = author === "agent" ? "agent" : "user";
    const validSource = source === "cli" ? "cli" : "web";
    const comment = await addComment(
      projectDir,
      id,
      validAuthor,
      text.trim(),
      Array.isArray(files) ? files : undefined,
      undefined,
      validSource,
    );
    broadcastTaskUpdated(broadcast, id, ["comments"]);
    res.json({ success: true, comment });
  });

  app.patch("/api/tasks/:id/comments/:commentId", async (req, res) => {
    const { id, commentId } = req.params;
    const { text } = req.body as { text?: string };
    if (!text || !text.trim()) {
      res.status(400).json({ error: "Missing required field: text" });
      return;
    }
    const comment = await updateComment(projectDir, id, commentId, text.trim());
    if (!comment) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }
    broadcastTaskUpdated(broadcast, id, ["comments"]);
    res.json({ success: true, comment });
  });

  app.delete("/api/tasks/:id/comments/:commentId", async (req, res) => {
    const { id, commentId } = req.params;
    const ok = await deleteComment(projectDir, id, commentId);
    if (!ok) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }
    broadcastTaskUpdated(broadcast, id, ["comments"]);
    res.json({ success: true });
  });

  // Files API
  app.get("/api/tasks/:id/files", (req, res) => {
    const { id } = req.params;
    const files = listFiles(projectDir, id);
    res.json({ files });
  });

  app.get("/api/tasks/:id/files/:filename", (req, res) => {
    const { id, filename } = req.params;
    if (!isValidFilename(filename)) {
      res.status(400).json({ error: "Invalid filename" });
      return;
    }
    const filePath = getFilePath(projectDir, id, filename);
    if (!filePath) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    // Path is derived from getFilePath() which sanitizes via basename() and
    // only returns paths that exist on disk — no user-controlled traversal.
    // dotfiles:"allow" is load-bearing: attachments live under the
    // `.vibeflow` data dir, and send@1 (express 5) refuses any path with a
    // dot segment unless this option is set explicitly (200 → 500s).
    // The same explicit option guards the two /screenshots/:filename sites.
    res.sendFile(filePath, { dotfiles: "allow" }); // nosemgrep
  });

  app.post(
    "/api/tasks/:id/files/:filename",
    express.raw({ type: "*/*", limit: "50mb" }),
    async (req, res) => {
      const { id, filename: rawFilename } = req.params;
      if (!isValidFilename(rawFilename)) {
        res.status(400).json({ error: "Invalid filename" });
        return;
      }
      // Any file type is accepted EXCEPT executables (malware-droppoint
      // precaution, same list as the web files route — ticket 6a6ed2b8).
      if (!isAllowedFileExtension(rawFilename)) {
        res.status(415).json({ error: "Executable file type not allowed (zip it first)" });
        return;
      }
      const data = req.body as Buffer;
      if (!Buffer.isBuffer(data) || data.length === 0) {
        res.status(400).json({ error: "Empty file body" });
        return;
      }
      const info = saveFile(projectDir, id, rawFilename, data);
      // Leave the same system trace a removal leaves, so the activity
      // feed records the addition (949e7c0a). Awaited: the broadcast
      // below must not outrun the write, or peers refetch too early.
      await addComment(
        projectDir,
        id,
        "user",
        `📎 File added: \`${rawFilename}\``,
        undefined,
        "system",
        "web",
      );
      // A file op also writes a system comment trace above, so both panel
      // parts are stale (ticket d4c533f9).
      broadcastTaskUpdated(broadcast, id, ["files", "comments"]);
      res.json({ success: true, file: info });
    },
  );

  app.delete("/api/tasks/:id/files/:filename", async (req, res) => {
    const { id, filename } = req.params;
    if (!isValidFilename(filename)) {
      res.status(400).json({ error: "Invalid filename" });
      return;
    }
    const deleted = deleteFile(projectDir, id, filename);
    if (!deleted) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    // Add a system trace so the activity feed records the removal.
    // Awaited for the same broadcast-ordering reason as the add path.
    await addComment(
      projectDir,
      id,
      "user",
      `🗑️ File removed: \`${filename}\``,
      undefined,
      "system",
      "web",
    );
    // The removal trace above is a comment write, so both panel parts
    // are stale (ticket d4c533f9).
    broadcastTaskUpdated(broadcast, id, ["files", "comments"]);
    res.json({ success: true });
  });

  // Screenshot API
  const screenshotsDir = join(projectDir, PROTO_DIR, SCREENSHOTS_DIR);

  app.post("/api/tasks/:id/screenshot", express.json(), (req, res) => {
    const { id } = req.params;
    const { screenshot } = req.body as { screenshot?: string };
    if (!findTaskFilePath(projectDir, id)) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    if (!screenshot) {
      res.status(400).json({ error: "Missing screenshot" });
      return;
    }
    mkdirSync(screenshotsDir, { recursive: true });
    // Never overwrite an existing annotation baseline (b5f90a1e): the
    // `<id>.png` file is the ticket's original annotation image, and a proof
    // attach MUST NOT destroy it. First attach claims the baseline name and
    // repoints task.screenshot; every later attach writes a distinct
    // `<id>-proof-<n>.png` and leaves task.screenshot on the baseline, so
    // the board keeps showing the annotation image. Proof files are evidence
    // on disk (served via the files API, not the screenshot slot).
    const baseline = `${id}.png`;
    if (!existsSync(join(screenshotsDir, baseline))) {
      writeFileSync(
        join(screenshotsDir, baseline),
        Buffer.from(screenshot, "base64"),
      );
      updateTask(projectDir, id, { screenshot: baseline } as Partial<Task>);
      // Screenshot attaches only touch task fields — no comments/files
      // refetch needed (ticket d4c533f9).
      broadcastTaskUpdated(broadcast, id, ["task"]);
      res.json({ success: true, screenshot: baseline });
      return;
    }
    let n = 1;
    while (n <= 10000 && existsSync(join(screenshotsDir, `${id}-proof-${n}.png`))) {
      n++;
    }
    const filename =
      n <= 10000 ? `${id}-proof-${n}.png` : `${id}-proof-${Date.now()}.png`;
    writeFileSync(
      join(screenshotsDir, filename),
      Buffer.from(screenshot, "base64"),
    );
    broadcastTaskUpdated(broadcast, id, ["task"]);
    res.json({ success: true, screenshot: filename, proof: true });
  });

  app.delete("/api/tasks/:id/screenshot", (req, res) => {
    const { id } = req.params;
    if (!findTaskFilePath(projectDir, id)) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const filename = `${id}.png`;
    const filePath = join(screenshotsDir, filename);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
    updateTask(projectDir, id, { screenshot: undefined } as Partial<Task>);
    broadcastTaskUpdated(broadcast, id, ["task"]);
    res.json({ success: true });
  });

  // ── Verification routes (spec §6, §7) ───────────────────────────────────

  // POST /api/tasks/:id/auth-state — store encrypted auth state in task.json (§7)
  app.post("/api/tasks/:id/auth-state", express.json(), async (req, res) => {
    const { id } = req.params;
    const { authState, taskAuthor } = req.body as {
      authState?: import("../core/verification-types.js").AuthState;
      taskAuthor?: string;
    };

    // Validate task exists
    const existing = findTaskFilePath(projectDir, id);
    if (!existing) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    // Validate required fields
    if (!authState || !taskAuthor) {
      res
        .status(400)
        .json({ error: "Missing required fields: authState, taskAuthor" });
      return;
    }

    try {
      const encrypted = encryptAuthState(authState, taskAuthor);
      // Store the serialized encrypted auth state as a string in task.json.
      updateTask(projectDir, id, {
        authStateEnc: JSON.stringify(encrypted),
      } as Partial<Task>);
      console.log(`[Vibeflow] Auth state stored for task ${id}`);
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Vibeflow] Failed to store auth state for ${id}: ${msg}`);
      res.status(500).json({ error: "Failed to store auth state" });
    }
  });

  // POST /api/tasks/:id/baseline — store baseline snapshot as file (§6)
  app.post("/api/tasks/:id/baseline", express.json(), (req, res) => {
    const { id } = req.params;
    const { baseline } = req.body as {
      baseline?: import("../core/verification-types.js").DomSnapshot;
    };

    // Validate task exists
    if (!findTaskFilePath(projectDir, id)) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    // Validate required fields
    if (!baseline || !baseline.selector || !baseline.outerHTML) {
      res.status(400).json({
        error: "Missing required fields: baseline.selector, baseline.outerHTML",
      });
      return;
    }

    try {
      const filename = "baseline-element.json";
      saveFile(
        projectDir,
        id,
        filename,
        Buffer.from(JSON.stringify(baseline, null, 2)),
        { system: true },
      );
      updateTask(projectDir, id, {
        baselineElementFile: filename,
      } as Partial<Task>);
      console.log(
        `[Vibeflow] Baseline snapshot stored for task ${id} (${filename})`,
      );
      res.json({ success: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[Vibeflow] Failed to store baseline for ${id}: ${msg}`);
      res.status(500).json({ error: "Failed to store baseline" });
    }
  });

  // POST /api/tasks/:id/baseline-page — store page-wide baseline snapshot as file
  app.post(
    "/api/tasks/:id/baseline-page",
    express.json({ limit: "10mb" }),
    (req, res) => {
      const { id } = req.params;
      const { page } = req.body as {
        page?: {
          version: number;
          elements: Record<string, unknown>;
          capturedAt: string;
          truncated: boolean;
        };
      };

      // Validate task exists
      if (!findTaskFilePath(projectDir, id)) {
        res.status(404).json({ error: "Task not found" });
        return;
      }

      // Validate required fields
      if (!page || page.version !== 1 || !page.elements) {
        res.status(400).json({
          error: "Missing required fields: page.version, page.elements",
        });
        return;
      }

      try {
        const filename = "baseline-page.json";
        // One style map per element: the capture fills `baseline` and
        // `after` with the SAME values (no "before" exists at annotation
        // time), so storing both doubles the file for zero readers — every
        // consumer reads `.after` (verify.ts step 14, verify-tools
        // readEvidence back-fill, page-diff.ts) and back-fills `.baseline`
        // from it at read time. Stripping here (not at capture) is the single
        // choke point: stale overlay bundles already in the wild still send
        // both maps, and every one of them lands one-map on disk. Compact
        // JSON by owner decision 2026-10-14 (ticket 1caca8cc): size over
        // git-diffability; the file stays plain JSON, just not pretty-printed.
        const elements =
          page.elements && typeof page.elements === "object"
            ? (page.elements as Record<string, Record<string, unknown>>)
            : {};
        const storedElements: Record<string, Record<string, unknown>> = {};
        for (const [key, el] of Object.entries(elements)) {
          if (el && typeof el === "object" && !Array.isArray(el)) {
            const { baseline: _dropped, ...rest } = el;
            storedElements[key] = rest;
          } else {
            storedElements[key] = el as Record<string, unknown>;
          }
        }
        saveFile(
          projectDir,
          id,
          filename,
          Buffer.from(
            JSON.stringify({ ...page, elements: storedElements }),
          ),
          { system: true },
        );
        updateTask(projectDir, id, { baselineFile: filename } as Partial<Task>);
        console.log(
          `[Vibeflow] Page baseline stored for task ${id} (${filename})`,
        );
        res.json({ success: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(
          `[Vibeflow] Failed to store page baseline for ${id}: ${msg}`,
        );
        res.status(500).json({ error: "Failed to store page baseline" });
      }
    },
  );
}

/** Registers /api/user, /api/settings, and related meta endpoints. */
function registerMetaApis(
  app: express.Application,
  projectDir: string,
  broadcast?: (data: Record<string, unknown>) => void,
): void {
  // Returns the git user name and email for the project.
  app.get("/api/user", (_req, res) => {
    res.json(getGitUser(projectDir));
  });

  // Settings API — persists UI preferences to .proto/settings.json
  app.get("/api/settings", (_req, res) => {
    res.json(loadSettings(projectDir));
  });

  app.post("/api/settings", (req, res) => {
    if (!requireSameOrigin(req, res)) return;
    const SETTABLE_KEYS = new Set([
      "visibleCols",
      "viewMode",
      "panelWidth",
      "panelFullscreen",
      "autoCommit",
      "autoComment",
      "autoPush",
      "createBranch",
      "requireVerifyBeforeReview",
    ]);
    const filtered = Object.fromEntries(
      Object.entries(req.body as Record<string, unknown>).filter(([k]) =>
        SETTABLE_KEYS.has(k),
      ),
    );
    const saved = saveSettings(projectDir, filtered);
    res.json({ success: true, settings: saved });
  });

  // ── SaaS push: list available boards ───────────────────────────────────────
  // Used by the kanban OnlineModeOverlay "Push to board" button.
  app.get("/api/push/workspaces", async (_req, res) => {
    const token = await readToken().catch(() => null);
    if (!token) {
      res.status(401).json({ error: "Not logged in" });
      return;
    }
    const apiUrl = process.env.VIBEFLOW_API_URL ?? "http://localhost:3000";
    try {
      // Cloud-only path: apiUrl is the SaaS base (Bearer-authenticated) →
      // always "cloud", so the legacy workspaces path maps to /api/v0/boards.
      const r = await fetch(`${apiUrl}${surfacePath("cloud", "/api/cli/workspaces")}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        const msg = (body.error as string) ?? `HTTP ${r.status} from ${apiUrl}`;
        console.error(`[Vibeflow] GET /api/push/workspaces failed: ${msg}`);
        res.status(r.status).json({ error: msg });
        return;
      }
      res.json(await r.json());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `[Vibeflow] GET /api/push/workspaces network error: ${msg}`,
      );
      res
        .status(502)
        .json({ error: `Network error contacting online API: ${msg}` });
    }
  });

  // ── SaaS push: import local tasks into a board ───────────────────────────────
  app.post("/api/push", express.json(), async (req, res) => {
    const { workspaceId, keepLocalFiles } = req.body as {
      workspaceId?: string;
      keepLocalFiles?: boolean;
    };
    const token = await readToken().catch(() => null);
    if (!token) {
      res.status(401).json({ error: "Not logged in" });
      return;
    }
    const taskList = listTasksWithPaths(projectDir);
    if (taskList.length === 0) {
      res.json({ imported: 0, message: "No local tasks found" });
      return;
    }
    const apiUrl = process.env.VIBEFLOW_API_URL ?? "http://localhost:3000";
    try {
      // No batch import exists in the v0 contract: one POST per task via
      // the shared createTasksOneByOne() loop (same shape as the login
      // flow — cloud-only, so the mode inside is always "cloud").
      // SAFETY: listTasksWithPaths returns parsed task JSON objects plus a
      // filePath string — each entry spreads as a plain record into the
      // JSON create body, so the record cast is representation-preserving.
      const result = await createTasksOneByOne(
        apiUrl,
        token,
        workspaceId,
        taskList as unknown as Array<Record<string, unknown>>,
      );
      if (!keepLocalFiles) {
        for (const task of taskList) {
          try {
            unlinkSync(task.filePath);
          } catch {
            /* ignore — already removed */
          }
        }
        if (broadcast) broadcastTaskUpdated(broadcast);
      }
      res.json({
        imported: result.imported,
        skipped: result.skipped,
        attempted: result.attempted,
        failures: result.failures,
        stoppedEarly: result.stoppedEarly,
        workspaceId,
        boardId: workspaceId,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[Vibeflow] POST /api/push network error: ${msg}`);
      res
        .status(502)
        .json({ error: `Network error contacting online API: ${msg}` });
    }
  });

  // Returns the GitHub commit URL base for this repo (parsed from git remote origin).
  // Converts git@github.com:user/repo.git and https://github.com/user/repo.git
  // to https://github.com/user/repo so the frontend can build commit diff links.
  app.get("/api/github-url", (_req, res) => {
    try {
      const remote = execSync("git remote get-url origin", {
        cwd: projectDir,
        timeout: 3000,
      })
        .toString()
        .trim();
      // git@github.com:owner/repo.git → https://github.com/owner/repo
      const sshMatch = remote.match(/^git@github\.com:(.+?)(?:\.git)?$/);
      if (sshMatch) {
        res.json({ githubUrl: `https://github.com/${sshMatch[1]}` });
        return;
      }
      // https://github.com/owner/repo.git → https://github.com/owner/repo
      const httpsMatch = remote.match(
        /^(https?:\/\/github\.com\/[^/]+\/[^/]+?)(?:\.git)?$/,
      );
      if (httpsMatch) {
        res.json({ githubUrl: httpsMatch[1] });
        return;
      }
    } catch {
      /* git not available or no remote */
    }
    res.json({ githubUrl: null });
  });
}

/**
 * Serves the checked-in /api/v0 contract at GET /api/openapi.json.
 *
 * Phase 0 addition (fully revertible): serves the generated OPENAPI_JSON
 * string verbatim — the same bytes as docs/api/openapi.json. No existing
 * endpoint is touched. Gives the Phase 1 docs viewer a drift-proof source.
 */
function registerOpenApiRoute(app: express.Application): void {
  app.get("/api/openapi.json", (_req, res) => {
    res.type("application/json").send(OPENAPI_JSON);
  });
}

/**
 * Serves the image-codec wasm binaries (`/__vibeflow__/codecs/<name>`) that
 * the browser bundles fetch lazily on first image transform. Pure wasm,
 * immutable versioned binaries — long-cacheable. The allowlist rejects
 * everything else (no directory listing, no traversal).
 */
function registerCodecRoute(app: express.Application): void {
  app.get("/__vibeflow__/codecs/:name", (req, res) => {
    const { name } = req.params;
    if (!(wasmAssetNames() as string[]).includes(name)) {
      res.status(404).end();
      return;
    }
    let filePath: string;
    try {
      filePath = wasmAssetPath(name as WasmAssetName);
    } catch {
      res.status(404).end();
      return;
    }
    // Path is allowlisted to the three known binaries resolved by
    // wasmAssetPath() — no user-controlled traversal (nosemgrep).
    res.set("Content-Type", "application/wasm");
    res.set("Cache-Control", "public, max-age=31536000, immutable");
    res.sendFile(filePath);
  });
}

/**
 * Dev-mode kanban bundle asset (ticket 7e85c338): serves the freshly built
 * `kanban-browser.js` from disk with `Cache-Control: no-store`, so a dev
 * board picks up `tsup --watch` rebuilds with NO server restart.
 *
 * Bundler note (locked decision): the rebuild mechanism stays `tsup
 * --watch` (current 8.x) — this ticket changes SERVING architecture
 * (inlined-at-build vs asset-in-dev + reload trigger), which is
 * bundler-agnostic, and tsup already rebuilds correctly. A bundler switch
 * would touch the atomic build, every gen script, and all four gates for
 * zero functional gain toward live reload.
 *
 * Loud refusal: when no built bundle exists on disk the route answers 500
 * with the fix (`tsup --watch`) instead of an empty/dated script — dev must
 * never serve old code silently.
 */
function registerKanbanDevRoute(app: express.Application): void {
  app.get(KANBAN_DEV_BUNDLE_ROUTE, (_req, res) => {
    const found = readKanbanDevBundle();
    if (!found) {
      console.error(KANBAN_DEV_BUNDLE_MISSING);
      res.status(500).type("text/plain").send(`${KANBAN_DEV_BUNDLE_MISSING}\n`);
      return;
    }
    res.set("Cache-Control", "no-store");
    res.type("application/javascript").send(found.bytes);
  });
}

/**
 * Broadcasts the dev-mode code-reload signal (ticket 7e85c338). The single
 * choke point the bundle watcher calls after a rebuild lands — unit tests
 * assert THIS signal shape, not just the watcher config.
 */
export function notifyKanbanBundleRebuilt(
  broadcast: (data: Record<string, unknown>) => void,
): void {
  broadcast({ type: KANBAN_RELOAD_MESSAGE_TYPE });
}

/**
 * Watches the on-disk dev bundle and broadcasts the reload signal whenever
 * `tsup --watch` rewrites it (ticket 7e85c338). `null` bundle path means no
 * built bundle yet: watch the parent dir for its creation instead, so a
 * dev server booted BEFORE the first build still live-reloads into existence.
 * The caller owns the returned watcher (closed with the server instance).
 */
export function watchKanbanBundleForReload(
  broadcast: (data: Record<string, unknown>) => void,
  bundlePath: string | null = resolveKanbanDevBundlePath(),
): FSWatcher | null {
  try {
    const target = bundlePath ?? join(process.cwd(), "dist", "client");
    const watcher = createFileWatcher(target, {
      onChange: () => notifyKanbanBundleRebuilt(broadcast),
      onAdd: () => notifyKanbanBundleRebuilt(broadcast),
    });
    return watcher;
  } catch {
    return null;
  }
}

/**
 * Registers /kanban (the board) and /overview (the read-only aggregates
 * page, ticket 717d6335) — both serve the SAME inlined single-file shell
 * (production packaging: no second asset), and the client routes by
 * pathname. The overview aggregates client-side from GET /api/tasks, so
 * no new API was added. Both responses carry `no-store`: the bundle is
 * inlined at process start, and a cached copy would outlive a restart.
 */
function registerKanbanRoute(
  app: express.Application,
  port: number,
  opts: { broadcast?: BroadcastFn; dev?: boolean } = {},
): FSWatcher | null {
  const dev = isKanbanDevMode(opts.dev);
  if (dev) registerKanbanDevRoute(app);
  // The reload watcher lives as long as the server: the close() of each
  // serve path below shuts it down (no orphaned chokidar handles).
  const reloadWatcher =
    dev && opts.broadcast
      ? watchKanbanBundleForReload(opts.broadcast)
      : null;
  const devFlag = dev;
  const adminEmail = process.env.VIBEFLOW_ADMIN_EMAIL ?? "";
  const apiUrl = process.env.VIBEFLOW_API_URL ?? "http://localhost:3000";

  app.get(["/kanban", "/overview"], async (_req, res) => {
    // The client bundle is inlined into this HTML at process start — a cached
    // copy would outlive a board restart and keep serving the old JavaScript.
    res.set("Cache-Control", "no-store");
    const token = await readToken().catch(() => null);
    if (!token) {
      res
        .type("html")
        .send(getKanbanHtml({ port, cliVersion: CLI_VERSION, dev: devFlag }));
      return;
    }
    const workspace = await readWorkspace().catch(() => null);

    // Always fetch profile from API to determine admin status — never use cached email.
    let isAdmin = false;
    if (adminEmail) {
      try {
        // Cloud-only path: apiUrl is the SaaS base (Bearer-authenticated) →
        // always "cloud", so the legacy profile path maps to /api/v0/me.
        const profileRes = await fetch(`${apiUrl}${surfacePath("cloud", "/api/cli/profile")}`, {
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => null);
        if (profileRes?.ok) {
          const profile = (await profileRes.json()) as { email?: string };
          isAdmin = profile.email === adminEmail;
        }
      } catch {
        /* non-critical — isAdmin stays false */
      }
    }

    const kanbanOpts: KanbanOptions = {
      port,
      cliVersion: CLI_VERSION,
      saasMode: true,
      boardUrl: workspace?.url ?? `${apiUrl}/kanban`,
      boardName: workspace?.name,
      isAdmin,
      dev: devFlag,
    };
    res.type("html").send(getKanbanHtml(kanbanOpts));
  });
  return reloadWatcher;
}

const INJECT_PAGE_CSS = `*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;padding:32px;max-width:700px;margin:0 auto}
h1{font-size:22px;font-weight:700;color:#f1f5f9;margin-bottom:6px}
h2{font-size:14px;font-weight:600;color:#94a3b8;margin:24px 0 8px;text-transform:uppercase;letter-spacing:.06em}
p{font-size:13px;color:#94a3b8;line-height:1.6}
.card{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:16px;margin-bottom:16px}
code{font-family:monospace;font-size:12px;color:#a5b4fc;word-break:break-all}
.bookmarklet{display:inline-flex;align-items:center;gap:8px;padding:8px 16px;background:#1d4ed8;color:#fff;text-decoration:none;border-radius:8px;font-size:13px;font-weight:600;cursor:grab;margin-top:8px}
.bookmarklet:hover{background:#2563eb}
.bookmarklet-icon{width:18px;height:18px;flex-shrink:0}
.badge{display:inline-block;padding:2px 8px;background:rgba(59,130,246,.15);border:1px solid rgba(59,130,246,.3);border-radius:10px;font-size:11px;color:#60a5fa;margin-left:6px}
.badge.green{background:rgba(34,197,94,.15);border-color:rgba(34,197,94,.3);color:#4ade80}
pre{background:#050d1a;border:1px solid #1e293b;border-radius:6px;padding:12px;overflow-x:auto;font-family:monospace;font-size:12px;color:#a5b4fc;margin-top:8px}
.note{font-size:11px;color:#64748b;margin-top:8px;padding:8px 10px;background:#0a0f1e;border-radius:6px;border-left:3px solid #334155}`;

function escapeHtml(s: string): string {
  return s.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const VIBEFLOW_FAVICON = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' fill='none'%3E%3Crect width='32' height='32' rx='7' fill='%232563eb'/%3E%3Crect x='7' y='13' width='3.5' height='10' rx='1.5' fill='white' opacity='.75'/%3E%3Crect x='12.25' y='8.5' width='3.5' height='15' rx='1.5' fill='white'/%3E%3Crect x='17.5' y='14.5' width='3.5' height='8' rx='1.5' fill='white' opacity='.75'/%3E%3Crect x='22.5' y='11' width='2.5' height='11' rx='1.25' fill='white' opacity='.85'/%3E%3C/svg%3E`;

function buildInjectPageHtml(subtitle: string, sections: string[]): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Vibeflow — Inject Overlay</title><link rel="icon" type="image/svg+xml" href="${VIBEFLOW_FAVICON}"><style>${INJECT_PAGE_CSS}</style></head>
<body>
  <h1>Vibeflow — Inject Overlay</h1>
  <p style="margin-top:6px">${subtitle}</p>
${sections.join("\n")}
</body></html>`;
}

/** Serves /inject — helper page with bookmarklet and instructions for adding
 * the overlay to an existing app without modifying its source code.
 *
 * Every URL and copy-pasteable snippet on the page comes from the ONE guide
 * builder (server/startup-guide.ts); this function supplies the HTML around
 * them, so the page can never drift from the console guide. */
function registerInjectPage(
  app: express.Application,
  urls: GuideUrls,
  boardId?: string,
  saasUrl?: string,
  needsBoard = false,
): void {
  // Strip all chars that are not alphanumeric, underscore, or hyphen to prevent
  // HTML attribute injection and JS string injection via a crafted workspace file.
  const safeBoardId = boardId
    ? boardId.replace(/[^a-zA-Z0-9_-]/g, "")
    : undefined;
  if (needsBoard) {
    app.get("/inject", (_req, res) => {
      res.type("html").send(buildInjectPageHtml(
        "No board selected — run vibeflow auth login to pick a board, then re-run.",
        [],
      ));
    });
    return;
  }
  if (saasUrl) {
    const saasGuide = buildIntegrationGuide(urls, {
      boardId: safeBoardId,
      overlayBaseUrl: saasUrl,
      online: true,
    });
    const bookmarkletCode = saasGuide.bookmarkletCode;
    const consoleSaasSnippet = saasGuide.consoleSnippet;
    const saasScriptTag = saasGuide.scriptTag;

    app.get("/inject", (_req, res) => {
      res.type("html").send(
        buildInjectPageHtml(
          `Add the Vibeflow overlay to any page to annotate and create tasks.${safeBoardId ? `<br><span style="font-size:12px;color:#64748b">Connected to board <code style="background:#1e293b;padding:2px 6px;border-radius:4px">${safeBoardId}</code> (online).</span>` : ""}`,
          [
            `<h2>Option 1 — Bookmarklet <span class="badge">recommended</span></h2>
  <div class="card"><p>Drag this link to your bookmarks bar, then click it on any page to activate the overlay:</p>
    <a class="bookmarklet" href="${escapeHtml(bookmarkletCode.replace(/&/g, "&amp;")).replace(/"/g, "&quot;")}"><svg class='bookmarklet-icon' viewBox='0 0 32 32' fill='none' xmlns='http://www.w3.org/2000/svg'><rect x='7' y='13' width='3.5' height='10' rx='1.5' fill='white' opacity='.75'/><rect x='12.25' y='8.5' width='3.5' height='15' rx='1.5' fill='white'/><rect x='17.5' y='14.5' width='3.5' height='8' rx='1.5' fill='white' opacity='.75'/><rect x='22.5' y='11' width='2.5' height='11' rx='1.25' fill='white' opacity='.85'/></svg>Vibeflow annotate</a>
    <div class="note">Tries an external script, then fetch + blob. Requires the overlay origin in <code>connect-src</code> and either that origin or <code>blob:</code> in <code>script-src</code>.<br>⚠️ Do not click the link here — drag it to your bookmarks bar first, then use it on your target page.</div></div>`,
            `<h2>Option 2 — Browser console</h2>
  <div class="card"><p>Open browser DevTools console on your target page and paste:</p>
    <pre>${escapeHtml(consoleSaasSnippet)}</pre>
    <div class="note">The blob fallback works with policies such as <code>script-src blob:</code>; an inline bootstrap also needs <code>unsafe-inline</code> (which alone does not permit blob scripts). Nonce-only / <code>strict-dynamic</code> policies may block the bootstrap itself: use the browser extension or ask the site owner to adjust CSP. A blocked bootstrap cannot display an error.</div></div>`,
            `<h2>Option 3 — Script tag</h2>
  <div class="card"><p>Add this tag to your HTML (before <code>&lt;/body&gt;</code>):</p>
    <pre>${escapeHtml(saasScriptTag)}</pre>
    <div class="note">Requires your CSP to allow loading scripts from <code>${saasUrl}</code>. Suitable when you control the page's HTML.</div></div>`,
          ],
        ),
      );
    });
    return;
  }

  // The local guide has always linked the overlay at `http://localhost:<port>`
  // (NOT the LAN url) — the overlay resolves its own API from window.location,
  // so the localhost link is what a same-machine dev wants to drag.
  // urls.url is built internally by resolveServeUrls and always parses, but
  // new URL throws on malformed input — fall back to 80 rather than 500ing
  // the guide on an unexpected value.
  let port = "80";
  try {
    port = new URL(urls.url).port || "80";
  } catch {
    port = "80";
  }
  const localGuide = buildIntegrationGuide(urls, {
    boardId: safeBoardId,
    overlayBaseUrl: `http://localhost:${port}`,
  });
  const snippet = localGuide.scriptTag;
  const bookmarkletCode = localGuide.bookmarkletCode;

  app.get("/inject", (_req, res) => {
    res.type("html").send(
      buildInjectPageHtml(
        "Add the Vibeflow overlay to any page without modifying source code.",
        [
          `<h2>Option 1 — Bookmarklet <span class="badge">recommended</span></h2>
  <div class="card"><p>Drag this link to your bookmarks bar, then click it on any page to activate the overlay:</p>
    <a class="bookmarklet" href="${escapeHtml(bookmarkletCode.replace(/&/g, "&amp;")).replace(/"/g, "&quot;")}"><svg class='bookmarklet-icon' viewBox='0 0 32 32' fill='none' xmlns='http://www.w3.org/2000/svg'><rect x='7' y='13' width='3.5' height='10' rx='1.5' fill='white' opacity='.75'/><rect x='12.25' y='8.5' width='3.5' height='15' rx='1.5' fill='white'/><rect x='17.5' y='14.5' width='3.5' height='8' rx='1.5' fill='white' opacity='.75'/><rect x='22.5' y='11' width='2.5' height='11' rx='1.25' fill='white' opacity='.85'/></svg>Vibeflow annotate</a>
    <div class="note">⚠️ Do not click the link here — drag it to your bookmarks bar first, then use it on your target page.</div></div>`,
          `<h2>Option 2 — Script tag</h2>
  <div class="card"><p>Add this tag to your HTML (before <code>&lt;/body&gt;</code>):</p>
    <pre>${escapeHtml(snippet)}</pre>
    <div class="note">Requires the Vibeflow server to be running at port ${port}.</div></div>`,
          `<h2>Option 3 — Browser console</h2>
  <div class="card"><p>Open browser DevTools console and paste:</p>
    <pre>${escapeHtml(localGuide.consoleSnippet)}</pre></div>`,
          `<div class="note" style="margin-top:20px">⚙️ <strong>CSP note:</strong> If your app sets a strict Content-Security-Policy, add <code>http://localhost:${port}</code> to your page's <code>script-src</code> and <code>connect-src</code> — no <code>unsafe-eval</code> and no extension needed. That is a build-time change to your app, so redeploy it afterwards. The bookmarklet and console loader also try fetch + <code>blob:</code> when external scripts are blocked; this requires <code>blob:</code> in <code>script-src</code> and the overlay origin in <code>connect-src</code>. <code>unsafe-inline</code> alone is not enough for blob scripts. Nonce-only / <code>strict-dynamic</code> policies can block the bootstrap itself, before it can display an error: use the browser extension or ask the site owner to adjust CSP.</div>`,
        ],
      ),
    );
  });
}

/** Mounts the tRPC router at /trpc, exposing all task/comment/file operations. */
function registerTrpcApi(
  app: express.Application,
  projectDir: string,
  broadcast: BroadcastFn,
): void {
  app.use(
    "/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext: () => ({ projectDir, broadcast }),
    }),
  );
}

/**
 * Generic error handler middleware. Must be registered AFTER all routes.
 * Returns a plain JSON error without stack traces to prevent information disclosure.
 *
 * Ticket 5087f5e3: also reports the throw ONCE through the CLI error path
 * (gated by the existing telemetry flag, message scrubbed) so a thrown
 * route handler is never silent. The response is unchanged.
 */
function useErrorHandler(app: express.Application): void {
  app.use(
    (
      err: Error,
      req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      reportCliError(err, {
        source: "server",
        route: req.path,
        statusCode: 500,
      });
      console.error("[Vibeflow] Unhandled error:", err.message);
      res.status(500).json({ error: "Internal server error" });
    },
  );
}

/**
 * CORS middleware: allow cross-origin requests so the overlay running inside an
 * existing app (different port/origin) can call the Vibeflow Studio task API.
 * Safe for a localhost development tool.
 */
function useCors(app: express.Application): void {
  app.use(
    (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      const origin = req.headers.origin ?? "*";
      // Loopback dev tool: reflect any origin so the overlay works from pages
      // on any host (localhost, LAN IP, or remote https). Tradeoff: any site
      // in the browser can reach the local task API.
      // pi-lens-ignore: no-server-bind-wildcard
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader(
        "Access-Control-Allow-Methods",
        "GET, POST, PATCH, DELETE, OPTIONS",
      );
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, X-Overlay-Api-Key",
      );
      // Private Network Access: Chrome requires this on the preflight
      // response when a public https page fetches from a localhost server.
      if (req.headers["access-control-request-private-network"] === "true") {
        res.setHeader("Access-Control-Allow-Private-Network", "true");
      }
      if (req.method === "OPTIONS") {
        res.status(204).end();
        return;
      }
      next();
    },
  );
}

/**
 * Adds HTTP security headers recommended by OWASP. Suppresses Express fingerprinting
 * and sets CSP, Permissions-Policy headers so that ZAP / security scanners pass.
 *
 * NOTE: CSP connect-src uses 'self' to support both localhost and --host 0.0.0.0 remote access.
 * The overlay JavaScript uses window.location.host to dynamically determine the server URL,
 * which allows the CSP 'self' directive to work correctly regardless of the access method.
 */
function useSecurityHeaders(app: express.Application): void {
  app.disable("x-powered-by");
  app.use(
    (
      _req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      // CSP: allow inline scripts/styles for the kanban React UI, data URIs for screenshots.
      // External CDN scripts in overlay-showcase.html (tailwind, lucide) require cdn.tailwindcss.com
      // and unpkg.com in script-src. font-src allows Google Fonts for the demo page.
      res.setHeader(
        "Content-Security-Policy",
        [
          "default-src 'self'",
          "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: https://cdn.tailwindcss.com https://unpkg.com",
          "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
          "font-src 'self' https://fonts.gstatic.com",
          "img-src 'self' data: blob:",
          // connect-src: 'self' allows WebSocket and fetch to any origin this page was loaded from.
          // This supports localhost access and remote access via --host 0.0.0.0 (LAN IP).
          // Additional explicit localhost patterns for compatibility.
          "connect-src 'self' ws://localhost:* ws://127.0.0.1:* wss://localhost:* wss://127.0.0.1:*",
          "frame-ancestors 'none'",
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
          "worker-src 'self' blob:",
        ].join("; "),
      );
      res.setHeader(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=()",
      );
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
      // COEP: unsafe-none is required for the kanban UI which loads resources from same origin
      // and for the overlay-showcase.html demo which uses cross-origin CDN resources.
      res.setHeader("Cross-Origin-Embedder-Policy", "unsafe-none");
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      next();
    },
  );
}

/**
 * API-only mode: starts the task API server without serving any HTML files.
 * Intended for use with existing hosted/served projects — the overlay
 * connects to this server to read and write tasks while you browse your app.
 */
/** Shared Express app + HTTP server + WebSocket setup used by both serve modes.
 * Extracted to eliminate ~20 lines of duplication between serveApiOnly and serve (S3). */
function createBaseServer(): {
  app: express.Express;
  httpServer: import("node:http").Server;
  wss: import("ws").WebSocketServer;
  broadcast: (data: Record<string, unknown>) => void;
} {
  const app = express();
  useCors(app);
  useSecurityHeaders(app);
  app.use(express.json({ limit: "10mb" }));
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer });
  // `WebSocketServer({server})` subscribes to the HTTP server's `error` event
  // and re-emits it on itself. An EventEmitter `error` with no listener THROWS,
  // so before this handler a port collision surfaced as an unhandled
  // 'error' event that crashed the process instead of rejecting the promise
  // returned by serve() — `start_kanban` could then never report EADDRINUSE as
  // a tool-level refusal, and the CLI hung instead of exiting. The HTTP
  // server's own `error` handler (below, in each serve path) still does the
  // rejecting; this only stops the re-emit from throwing.
  wss.on("error", () => {
    /* surfaced through httpServer's 'error' handler */
  });
  const broadcast = (data: Record<string, unknown>) => {
    const msg = JSON.stringify(data);
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      // A socket can close between the readyState check and send() (a client
      // that just disconnected). That is a normal condition, not a server
      // fault: drop that socket's frame and keep delivering to the rest.
      // Letting one dead socket abort the loop would starve every client
      // after it, and the throw would escape into the mutation handler and
      // surface as a spurious "Failed to broadcast task event" warning.
      try {
        client.send(msg, () => {
          /* async send failure means a dead socket — already skipped above */
        });
      } catch {
        /* sync send failure means a dead socket — keep broadcasting */
      }
    }
  };
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
      } catch {
        /* ignore non-JSON */
      }
    });
  });
  return { app, httpServer, wss, broadcast };
}

async function serveApiOnly(
  projectDir: string,
  options: ServeOptions,
): Promise<ServeInstance> {
  // Server-layer backstop (W1): never create a task store at / or $HOME,
  // even for programmatic callers that bypass the CLI validation. The full
  // git/`.vibeflow` rule lives at the CLI boundary (core/project-root.ts).
  assertSafeProjectDir(projectDir);

  // Ticket 5087f5e3: process-level error reporting (idempotent — safe if
  // both serve entrypoints run in one process, e.g. under tests).
  installCliProcessErrorHandlers();

  // Check auth before registering any routes — online mode must never expose local task API.
  const token =
    options._testToken === undefined
      ? await readToken().catch(() => null)
      : options._testToken;
  const workspace =
    options._testWorkspace === undefined
      ? token
        ? await readWorkspace().catch(() => null)
        : null
      : options._testWorkspace;
  const isOnline = !!(token && workspace);

  const { app, httpServer, wss, broadcast } = createBaseServer();

  // Derive SaaS base URL from workspace.url origin — validated against known production domains to prevent SSRF.
  // Falls back to VIBEFLOW_API_URL env var for custom servers or testing.
  const saasApiUrl =
    sanitizeWorkspaceOrigin(workspace?.url) ??
    process.env.VIBEFLOW_API_URL ??
    "http://localhost:3000";

  if (isOnline) {
    // Online mode: local task API is intentionally blocked. Any accidental call to /api/tasks
    // or /trpc will return 503 so problems surface immediately instead of silently writing local files.
    app.use(["/api/tasks", "/api/push", "/trpc"], (_req, res) => {
      res.status(503).json({
        error:
          "Online mode active — local task API is disabled. All task operations go through the online backend.",
      });
    });

    // Serve overlay configured to post tasks to the SaaS backend (not local API).
    const saasOverlayScript = getOverlaySaasScript(saasApiUrl);
    app.get("/vibeflow-overlay.js", (_req, res) => {
      res.type("application/javascript").send(saasOverlayScript);
    });
  } else {
    // Offline mode: register all local task APIs.
    ensureTaskDirs(projectDir);
    // One-shot backfill for tasks that never see another write (e.g. the
    // system-flag migration): runs once at startup, never per request.
    // Fire-and-forget — a failed sweep must not block serving.
    migrateAllLegacyLinkedRefs(projectDir).catch(() => {});

    const overlayScript = getOverlayScript(options.port);
    app.get("/vibeflow-overlay.js", (_req, res) => {
      res.type("application/javascript").send(overlayScript);
    });
    const screenshotsDirOffline = join(projectDir, PROTO_DIR, SCREENSHOTS_DIR);
    app.get("/screenshots/:filename", (req, res) => {
      const { filename } = req.params;
      const taskId = basename(filename as string, ".png");
      if (!isValidTaskId(taskId)) {
        res.status(400).end();
        return;
      }
      const filePath = join(screenshotsDirOffline, `${taskId}.png`);
      if (!existsSync(filePath)) {
        res.status(404).end();
        return;
      }
      // dotfiles:"allow" — screenshots live under `.vibeflow/`; without
      // it send@1 (express 5) refuses the dot segment (see files route).
      res.sendFile(filePath, { dotfiles: "allow" }); // nosemgrep: javascript.express.security.audit.express-res-sendfile.express-res-sendfile
    });

    registerPagesApi(app, []);
    // P1: the /api/v0 read alias + docs viewer mount BEFORE the legacy
    // registrations — the alias rewrites to legacy paths and continues down
    // the stack, so its layers must precede the handlers they delegate to.
    // Rollback is removing these two lines; legacy routes are untouched.
    registerV0ReadAlias(
      app,
      options._testResolvePrincipal
        ? { resolvePrincipal: options._testResolvePrincipal }
        : undefined,
    );
    registerDocsViewer(app);
    registerTaskApi(app, projectDir, broadcast);
    registerTrpcApi(app, projectDir, broadcast);
    registerMetaApis(app, projectDir, broadcast);
    registerOpenApiRoute(app);

    // Mount MCP server (StreamableHTTP transport)
    mountMcp(app, projectDir, "local");

    // Ticket 0847833f: agent chat (flag-gated, default OFF). Null when
    // the flag is off — zero new surface, zero new processes.
    var chatManager: ChatSessionManager | null = maybeRegisterChat(app, {
      projectDir,
      port: options.port,
      broadcast,
    });
  }
  // Returns the bundle reload watcher (null in prod) — closed with the
  // instance so no chokidar handle survives the server.
  const kanbanReloadWatcher = registerKanbanRoute(app, options.port, {
    broadcast,
    dev: options.dev,
  });
  registerCodecRoute(app);
  // Ticket 5087f5e3: browser error forwarding (flag-gated, 204 when off).
  // Registered for online AND offline — the board is served in both.
  registerClientErrorRoute(app);
  const serveUrls = resolveServeUrls(options.host ?? "localhost", options.port);
  registerInjectPage(
    app,
    serveUrls,
    isOnline ? workspace?.id : undefined,
    isOnline ? saasApiUrl : undefined,
    !!token && !workspace,
  );
  // Board-server root: the bare `/` is otherwise Express's default 404, so
  // redirect EXACT `/` → `/kanban` (owner ruling on 34938eda). Express
  // matches "/" literally, so no other route is shadowed. The Location
  // carries no fragment, so browsers re-attach any `#task-<id>` fragment
  // across the redirect and board deep links keep working.
  app.get("/", (_req, res) => {
    res.redirect(302, "/kanban");
  });

  const taskWatcher = isOnline
    ? null
    : createTaskWatcher(join(projectDir, PROTO_DIR, TASKS_DIR), {
        onChanged: (filePath) => {
          const task = readTaskFile(filePath);
          if (task)
            broadcast({
              type: "task-changed",
              taskId: task.id,
              action: "update",
              task,
              source: "cli",
            });
          else broadcast({ type: "tasks-updated" });
        },
        onDeleted: (filePath) => {
          const taskId = basename(filePath, ".json");
          broadcast({ type: "task-deleted", taskId });
        },
      });

  useErrorHandler(app);

  return new Promise<ServeInstance>((resolvePromise, reject) => {
    const bindHost = options.host ?? "localhost";
    const { url, localUrl } = serveUrls;
    // Owner-request, ticket pending (multi-board scope bug): a production page
    // loaded localhost:3700 and hit ERR_CONNECTION_REFUSED. Online copy targets
    // must use the cloud origin and board id, not the visitor's local machine.
    // The local proxy still works while this CLI runs; retain it as a labelled
    // alternative, and leave unauthenticated local development unchanged.
    const localGuide = buildIntegrationGuide({ url, localUrl });
    const guide = isOnline
      ? buildIntegrationGuide({ url, localUrl }, {
          online: true, boardId: workspace!.id, overlayBaseUrl: saasApiUrl,
        })
      : localGuide;
    httpServer.listen(options.port, bindHost, () => {
      const divider = guideDivider();

      // `quiet` is the programmatic-caller switch: the MCP tools own stdout
      // (under the stdio transport it IS the JSON-RPC channel), and the guide
      // they need is on `instance.guide`. The human CLI path leaves it unset
      // and gets these exact lines, in this exact order, as before.
      if (options.quiet) {
        resolvePromise(makeInstance());
        return;
      }

      printGuideLines([
        "",
        chalk.green("  ✓ Vibeflow running") +
          chalk.dim(" · ") +
          chalk.cyan(url),
        ...(localUrl
          ? [chalk.dim("  Local:          ") + chalk.cyan(localUrl)]
          : []),
        divider,
        ...(isOnline
          ? [
              chalk.dim("  Mode:  ") +
                chalk.green("● Online") +
                chalk.dim(" — connected to Vibeflow Online"),
              chalk.dim("  Board: ") +
                chalk.white(workspace!.name ?? "your board"),
              chalk.dim("  Web:   ") + chalk.cyan(workspace!.url),
              divider,
              chalk.dim("  Overlay script:  ") +
                chalk.cyan(guide.overlayScriptUrl),
              chalk.dim("  Local proxy (works only while this CLI is running): ") +
                chalk.cyan(localGuide.overlayScriptUrl),
              "",
              ...buildOnlineAddToHtmlLines(guide),
            ]
          : token
            ? [
                chalk.yellow("  No board selected — run vibeflow auth login to pick a board, then re-run."),
              ]
            : [
              chalk.dim("  Mode:  ") +
                chalk.yellow("◎ Local") +
                chalk.dim(" — no account needed"),
              divider,
              ...buildBoardsAndApisLines(guide),
              ...buildIntegrateIntoAppLines(guide),
              ...buildBookmarkletLines(guide),
            ]),
        "",
        ...(options.noCtrlCHint
          ? []
          : [chalk.dim("  Press Ctrl+C to stop"), ""]),
      ]);

      resolvePromise(makeInstance());
    });

    function makeInstance(): ServeInstance {
      return {
        url,
        localUrl,
        guide,
        close: async () => {
          if (taskWatcher) await taskWatcher.close();
          if (kanbanReloadWatcher) await kanbanReloadWatcher.close();
          disposeMcp();
          // Ticket 0847833f: stop pi children before the sockets go away.
          if (typeof chatManager !== "undefined" && chatManager) {
            await chatManager.closeAll();
          }
          wss.close();
          await new Promise<void>((r) => httpServer.close(() => r()));
        },
      };
    }

    // A refused bind (EADDRINUSE) must not leak the watchers and sockets
    // created above: a failed start leaves no listener behind, so a retry
    // starts clean and no file watcher survives a server that never served.
    // Best-effort — cleanup failures never mask the bind error. NOTE: no
    // disposeMcp() here — MCP sessions and the reaper are module-global and
    // may belong to a LIVE server (e.g. the session delivering this very
    // refusal); a failed boot creates no sessions of its own, so there is
    // nothing of MCP's to clean.
    httpServer.on("error", (err) => {
      void (async () => {
        try {
          if (taskWatcher) await taskWatcher.close();
        } catch {
          /* best-effort — the bind error below is what matters */
        }
        try {
          if (kanbanReloadWatcher) await kanbanReloadWatcher.close();
        } catch {
          /* best-effort — the bind error below is what matters */
        }
        try {
          wss.close();
        } catch {
          /* best-effort — the bind error below is what matters */
        }
      })().then(
        () => reject(err),
        () => reject(err),
      );
    });
  });
}

export async function serve(
  target: string | undefined,
  options: ServeOptions,
): Promise<ServeInstance> {
  // API-only mode: no target provided
  if (!target) {
    // Defence in depth (b5f90a1e): a programmatic caller that passes no
    // projectDir from a repo cwd would otherwise read/write the repo's real
    // `.vibeflow/` store. $VIBEFLOW_PROJECT_DIR redirects such boots at a
    // scratch store; an explicit projectDir always wins.
    const envDir = process.env.VIBEFLOW_PROJECT_DIR?.trim();
    return serveApiOnly(
      options.projectDir ?? (envDir ? envDir : process.cwd()),
      options,
    );
  }

  // Proxy mode was removed. Only API-only mode and static file serving are supported.
  if (target.startsWith("http://") || target.startsWith("https://")) {
    throw new Error(
      "Proxy mode is no longer supported.\n" +
        "To annotate an existing app, run: vibeflow serve  (API-only mode)\n" +
        "Then open the /inject page to get the bookmarklet, script tag, or console snippet for your app.",
    );
  }

  const absTarget = resolve(target);
  const stat = statSync(absTarget);
  const isDir = stat.isDirectory();
  const htmlFiles = isDir
    ? readdirSync(absTarget)
        .filter((f) => extname(f) === ".html")
        .map((f) => join(absTarget, f))
    : [absTarget];

  if (htmlFiles.length === 0) {
    throw new Error("No HTML files found at " + target);
  }

  // Project root is where .proto/ lives (directory itself, or parent of file)
  const projectDir = isDir ? absTarget : dirname(absTarget);
  // Backstop first, then announce, then create — never the other way around.
  assertSafeProjectDir(projectDir);
  console.log(
    chalk.green(
      formatProjectRootAnnouncement({
        projectDir,
        name: getProjectName(projectDir),
        branch: getCurrentBranch(projectDir),
      }),
    ),
  );
  ensureTaskDirs(projectDir);
  // Same one-shot sweep as API-only mode (see above): covers boards opened
  // with an HTML target.
  migrateAllLegacyLinkedRefs(projectDir).catch(() => {});

  const { app, httpServer, wss, broadcast } = createBaseServer();

  // Ticket 5087f5e3: process-level error reporting (idempotent).
  installCliProcessErrorHandlers();

  const overlayScript = options.noOverlay
    ? null
    : getOverlayScript(options.port);

  // ── Serve overlay as a standalone JS file ────────────────────────────────
  if (overlayScript) {
    app.get("/vibeflow-overlay.js", (_req, res) => {
      res.type("application/javascript").send(overlayScript);
    });
  }

  // ── Serve screenshots ─────────────────────────────────────────────────────
  const screenshotsDirHtml = join(projectDir, PROTO_DIR, SCREENSHOTS_DIR);
  app.get("/screenshots/:filename", (req, res) => {
    const { filename } = req.params;
    const taskId = basename(filename as string, ".png");
    if (!isValidTaskId(taskId)) {
      res.status(400).end();
      return;
    }
    const filePath = join(screenshotsDirHtml, `${taskId}.png`);
    if (!existsSync(filePath)) {
      res.status(404).end();
      return;
    }
    // dotfiles:"allow" — screenshots live under `.vibeflow/`; without
    // it send@1 (express 5) refuses the dot segment (see files route).
    res.sendFile(filePath, { dotfiles: "allow" }); // nosemgrep: javascript.express.security.audit.express-res-sendfile.express-res-sendfile
  });

  // ── Serve HTML files ─────────────────────────────────────────────────────
  if (isDir) {
    app.get("/", (_req, res) => {
      const links = htmlFiles
        .map((f) => {
          const name = basename(f);
          return `<li><a href="/${name}">${name}</a></li>`;
        })
        .join("\n");
      res.send(`<!DOCTYPE html><html><head><title>Vibeflow Studio</title>
<style>body{font-family:system-ui;max-width:600px;margin:40px auto;padding:0 20px}
a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}
li{margin:8px 0}</style></head>
<body><h1>Vibeflow Studio</h1>
<p>Select a prototype to review:</p>
<ul>${links}</ul></body></html>`);
    });
  }

  for (const file of htmlFiles) {
    const route = isDir ? `/${basename(file)}` : "/";
    app.get(route, (_req, res) => {
      const html = readFileSync(file, "utf-8");
      const content = overlayScript ? injectScript(html, overlayScript) : html;
      res.type("html").send(content);
    });
  }

  const serveUrls = resolveServeUrls(
    options.host ?? "localhost",
    options.port,
  );

  // ── Task API ─────────────────────────────────────────────────────────────
  const pageRoutes = htmlFiles.map((f) => `/${basename(f)}`);
  registerPagesApi(app, isDir ? pageRoutes : []);
  // P1: same read-alias + docs mount as the API-only branch (see above) —
  // the alias layers must precede the legacy handlers they delegate to.
  registerV0ReadAlias(
    app,
    options._testResolvePrincipal
      ? { resolvePrincipal: options._testResolvePrincipal }
      : undefined,
  );
  registerDocsViewer(app);
  registerTaskApi(app, projectDir, broadcast);
  registerTrpcApi(app, projectDir, broadcast);
  registerMetaApis(app, projectDir, broadcast);
  registerOpenApiRoute(app);
  // Ticket 0847833f: agent chat (flag-gated, default OFF). Null when the
  // flag is off — zero new surface, zero new processes.
  const chatManager = maybeRegisterChat(app, {
    projectDir,
    port: options.port,
    broadcast,
  });
  // Dev mode (ticket 7e85c338) — same explicit opt-in as the API-only path.
  const kanbanReloadWatcher = registerKanbanRoute(app, options.port, {
    broadcast,
    dev: options.dev,
  });
  registerCodecRoute(app);
  registerInjectPage(app, serveUrls);
  // Ticket 5087f5e3: browser error forwarding (flag-gated, 204 when off).
  registerClientErrorRoute(app);

  // ── File watcher ─────────────────────────────────────────────────────────
  let watcher: FSWatcher | null = null;
  watcher = createFileWatcher(absTarget, {
    onChange: (changedPath) => {
      const name = basename(changedPath);
      console.log(chalk.dim(`  File changed: ${name}`));
      broadcast({ type: "reload", file: name });
    },
  });

  // Watch .proto/tasks/ for external file-system changes (e.g. agent edits).
  const tasksDir = join(projectDir, PROTO_DIR, TASKS_DIR);
  const taskWatcher = createTaskWatcher(tasksDir, {
    onChanged: (filePath) => {
      const task = readTaskFile(filePath);
      if (task)
        broadcast({
          type: "task-changed",
          taskId: task.id,
          action: "update",
          task,
          source: "cli",
        });
      else broadcast({ type: "tasks-updated" });
    },
    onDeleted: (filePath) => {
      const taskId = basename(filePath, ".json");
      broadcast({ type: "task-deleted", taskId });
    },
  });

  useErrorHandler(app);

  return new Promise<ServeInstance>((resolvePromise, reject) => {
    const bindHost2 = options.host ?? "localhost";
    const { url, localUrl } = serveUrls;
    const guide = buildIntegrationGuide({ url, localUrl });
    httpServer.listen(options.port, bindHost2, () => {
      // `quiet` is for programmatic callers only — see ServeOptions.quiet.
      if (!options.quiet) {
        const lines: string[] = [
          "",
          chalk.green("  ✓ Vibeflow running") +
            chalk.dim(" · ") +
            chalk.cyan(url),
          ...(localUrl
            ? [chalk.dim("  Local:         ") + chalk.cyan(localUrl)]
            : []),
          guideDivider(),
        ];
        for (const f of htmlFiles) {
          const route = isDir ? `/${basename(f)}` : "/";
          lines.push(
            chalk.dim("  File:          ") +
              chalk.cyan(`${url}${route}`) +
              chalk.dim(`  (${basename(f)})`),
          );
          const fileAlt = localhostAltLine(localUrl, route, 17);
          if (fileAlt) lines.push(fileAlt);
        }
        lines.push(
          chalk.dim("  Kanban board:  ") + chalk.cyan(guide.kanbanUrl),
        );
        const kanbanAlt = localhostAltLine(localUrl, "/kanban", 17);
        if (kanbanAlt) lines.push(kanbanAlt);
        lines.push(
          chalk.dim("  Task API:      ") + chalk.cyan(guide.taskApiUrl),
        );
        const taskApiAlt = localhostAltLine(localUrl, "/api/tasks", 17);
        if (taskApiAlt) lines.push(taskApiAlt);
        lines.push(...buildIntegrateIntoAppLines(guide));
        lines.push("", chalk.dim("  Press Ctrl+C to stop"), "");
        printGuideLines(lines);
      }

      if (options.open) {
        import("open").then((mod) => mod.default(url)).catch(() => {});
      }

      resolvePromise({
        url,
        localUrl,
        guide,
        close: async () => {
          disposeMcp();
          if (watcher) await watcher.close();
          await taskWatcher.close();
          if (kanbanReloadWatcher) await kanbanReloadWatcher.close();
          // Ticket 0847833f: stop pi children before the sockets go away.
          if (chatManager) await chatManager.closeAll();
          wss.close();
          await new Promise<void>((r) => httpServer.close(() => r()));
        },
      });
    });

    // Same refused-bind cleanup as the API-only path above: a failed start
    // leaves no listener or watcher behind, so a retry starts clean
    // (and, like there, no disposeMcp() — MCP state is process-global).
    httpServer.on("error", (err) => {
      void (async () => {
        try {
          if (watcher) await watcher.close();
        } catch {
          /* best-effort — the bind error below is what matters */
        }
        try {
          await taskWatcher.close();
        } catch {
          /* best-effort — the bind error below is what matters */
        }
        try {
          if (kanbanReloadWatcher) await kanbanReloadWatcher.close();
        } catch {
          /* best-effort — the bind error below is what matters */
        }
        try {
          wss.close();
        } catch {
          /* best-effort — the bind error below is what matters */
        }
      })().then(
        () => reject(err),
        () => reject(err),
      );
    });
  });
}
