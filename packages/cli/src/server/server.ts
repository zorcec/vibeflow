import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve, basename, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { spawn, execSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import chalk from "chalk";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { injectScript } from "../core/html-parser.js";
import { createFileWatcher, createTaskWatcher } from "./watcher.js";
import { getOverlayScript, getOverlaySaasScript } from "../client/overlay/index.js";
import { getKanbanHtml, type KanbanOptions } from "./kanban-template.js";
import { getProjectName, readConfig } from "../core/config.js";
import {
  createTask,
  listTasks,
  listTasksWithPaths,
  updateTask,
  deleteTask,
  ensureTaskDirs,
  readTaskFile,
  findTaskFilePath,
  renderTaskForAgent,
  renderAgentInstructions,
} from "../core/tasks.js";
import { listComments, addComment, updateComment, deleteComment } from "../core/comments.js";
import { listFiles, saveFile, deleteFile, getFilePath } from "../core/files.js";
import { getCopilotAuthStatus, isGhCliAvailable } from "../core/copilot-auth.js";
import { loadSettings, saveSettings } from "../core/settings.js";
import { readToken } from "../auth/token.js";
import { readWorkspace } from "../auth/workspace.js";
import { appRouter } from "./trpc.js";
import type { ServeOptions, Task } from "../core/types.js";
import { PROTO_DIR, TASKS_DIR, SCREENSHOTS_DIR } from "../core/types.js";
import { getGitUser } from "../core/git-user.js";
import type { FSWatcher } from "chokidar";

/** Validates task IDs to prevent path traversal attacks. Task IDs are hex strings (30 chars, 15 random bytes). */
function isValidTaskId(id: string): boolean {
  return /^[a-f0-9]{30}$/.test(id);
}

/** Rejects POST/DELETE from cross-origin pages. Returns false and sends 403 if origin is disallowed. */
function requireSameOrigin(req: express.Request, res: express.Response): boolean {
  const origin = req.headers.origin;
  if (origin && !origin.startsWith("http://localhost")) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

const ALLOWED_WORKSPACE_ORIGINS = new Set([
  "https://app.vibeflow.tools",
  "https://vibeflow.tools",
  "https://app.vibeflow.dev",
  "https://vibeflow.dev",
  "https://app.vibeflow.ai",
  "https://vibeflow.ai",
]);

/** Validates workspace URL against known production domains to prevent SSRF. */
function sanitizeWorkspaceOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const origin = new URL(url).origin;
    return ALLOWED_WORKSPACE_ORIGINS.has(origin) ? origin : null;
  } catch { return null; }
}

export interface ServeInstance {
  url: string;
  close: () => Promise<void>;
}

type BroadcastFn = (data: object) => void;

const _require = createRequire(import.meta.url);

/** Returns the first non-loopback IPv4 LAN address for display when bound to 0.0.0.0. */
function getLanIp(): string | null {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const iface of ifaces ?? []) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return null;
}

/** Registers /api/pages — returns the list of HTML pages being served. */
function registerPagesApi(
  app: express.Application,
  pages: string[],
): void {
  app.get("/api/pages", (_req, res) => {
    res.json({ pages });
  });
}

/** Cache of commit SHAs per project directory (refreshed every 5 minutes). */
const remoteCommitCache = new Map<string, { shas: Set<string>; fetchedAt: number }>();

/** Returns the set of commit SHAs currently on the git remote (cached for 5 min). */
function getRemoteCommitShas(projectDir: string): Set<string> {
  const CACHE_TTL_MS = 5 * 60 * 1000;
  const cached = remoteCommitCache.get(projectDir);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.shas;
  }
  try {
    const output = execSync("git log --remotes --format=%H", { cwd: projectDir, timeout: 5000 }).toString().trim();
    const shas = new Set(output ? output.split("\n") : []);
    remoteCommitCache.set(projectDir, { shas, fetchedAt: Date.now() });
    return shas;
  } catch {
    return new Set();
  }
}

/** Returns true if the commit SHA is on any remote branch. */
function isCommitPushed(sha: string | undefined | null, remoteShas: Set<string>): boolean | null {
  if (!sha) return null;
  return remoteShas.has(sha);
}

/** Registers all /api/tasks routes on the given Express app. */
function registerTaskApi(
  app: express.Application,
  projectDir: string,
  broadcast: BroadcastFn,
): void {
  // Returns project metadata: name derived from package.json or directory name.
  // Used by the Chrome extension popup and sidebar to show the connected project.
  app.get("/api/project", (_req, res) => {
    res.json({ name: getProjectName(projectDir), projectDir });
  });

  app.get("/api/tasks", (_req, res) => {
    const tasks = listTasks(projectDir);
    const remoteShas = getRemoteCommitShas(projectDir);
    // commentCount and fileCount are included for the kanban UI badge without
    // exposing the full embedded arrays in the list response.
    const tasksWithMeta = tasks.map((t) => {
      const lastSha = t.commits?.length ? t.commits[t.commits.length - 1].sha : undefined;
      return {
        ...t,
        createdAt: t.created,
        commentCount: (t.comments ?? []).filter((c) => !c.deleted).length,
        fileCount: t.files?.length ?? 0,
        commitPushed: isCommitPushed(lastSha, remoteShas),
      };
    });
    res.json({ tasks: tasksWithMeta });
  });

  // Reject invalid task IDs at the router level to prevent path traversal on all :id routes.
  app.param("id", (_req, res, next, id: string) => {
    if (!isValidTaskId(id)) {
      res.status(400).json({ error: "Invalid task id" });
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
    const lastSha = task.commits?.length ? task.commits[task.commits.length - 1].sha : undefined;
    res.json({ ...task, commitPushed: isCommitPushed(lastSha, remoteShas) });
  });

  app.post("/api/tasks", (req, res) => {
    const { title, description, selector, cssSelector, url, type, priority, file, line, col, component, status: reqStatus, agent, model, screenshot, annotatedElementText, tags, sortKey } =
      req.body as {
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
      };

    if (!title || !selector) {
      res.status(400).json({ error: "Missing required fields: title, selector" });
      return;
    }

    const gitUser = getGitUser(projectDir);
    const VALID_CREATE_STATUSES = ["backlog", "todo", "in-progress", "review", "done"] as const;
    const task = createTask(projectDir, {
      title,
      description: description || "",
      selector,
      cssSelector: cssSelector || undefined,
      url: url || undefined,
      status: (VALID_CREATE_STATUSES.includes(reqStatus as typeof VALID_CREATE_STATUSES[number]) ? reqStatus : "todo") as typeof VALID_CREATE_STATUSES[number],
      file: file || undefined,
      line: line != null ? Number(line) : undefined,
      col: col != null ? Number(col) : undefined,
      component: component || undefined,
      type: type || undefined,
      priority: priority || undefined,
      author: gitUser.name,
      agent: agent || undefined,
      model: model || undefined,
      annotatedElementText: annotatedElementText ? String(annotatedElementText).slice(0, 300) : undefined,
      tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string' && t.length > 0) : undefined,
      sortKey: sortKey ? String(sortKey) : undefined,
    });

    if (screenshot) {
      const screenshotsDir = join(projectDir, PROTO_DIR, SCREENSHOTS_DIR);
      mkdirSync(screenshotsDir, { recursive: true });
      const filename = `${task.id}.png`;
      writeFileSync(join(screenshotsDir, filename), Buffer.from(screenshot, "base64"));
      updateTask(projectDir, task.id, { screenshot: filename } as Partial<Task>);
      task.screenshot = filename;
    }

    console.log(`[Proto] Task created: "${task.title}" (${task.id})`);
    broadcast({ type: "tasks-updated" });
    res.json({ success: true, task });
  });

  app.patch("/api/tasks/:id", (req, res) => {
    const { id } = req.params;
    const updates = req.body as Partial<
      Pick<Task, "status" | "title" | "description" | "type" | "priority" | "reportBack" | "agent" | "model" | "tags" | "sortKey">
    >;

    const VALID_PATCH_STATUSES = ["backlog", "todo", "in-progress", "review", "done"] as const;
    if (updates.status !== undefined && !VALID_PATCH_STATUSES.includes(updates.status as typeof VALID_PATCH_STATUSES[number])) {
      res.status(400).json({ error: `Invalid status: ${updates.status}` });
      return;
    }

    const updated = updateTask(projectDir, id, updates);
    if (!updated) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    console.log(`[Proto] Task updated: "${updated.title}" (${updated.id}) → status:${updated.status}`);
    // Broadcast task-changed with the full payload so clients can apply surgical
    // state updates without re-fetching all tasks (avoids full-list re-render).
    broadcast({ type: "task-changed", taskId: updated.id, action: "update", task: updated });
    res.json({ success: true, task: updated });
  });

  app.delete("/api/tasks/:id", (req, res) => {
    const { id } = req.params;
    const deleted = deleteTask(projectDir, id);
    if (!deleted) {
      res.status(404).json({ error: "Task not found" });
      return;
    }

    console.log(`[Proto] Task deleted: ${id}`);
    // Broadcast task-deleted so clients can surgically remove the card.
    broadcast({ type: "task-deleted", taskId: id });
    res.json({ success: true });
  });

  // Comments API
  app.get("/api/tasks/:id/comments", (req, res) => {
    const { id } = req.params;
    const comments = listComments(projectDir, id);
    res.json({ comments });
  });

  app.post("/api/tasks/:id/comments", (req, res) => {
    const { id } = req.params;
    const { author, text, files, source } = req.body as { author?: string; text?: string; files?: string[]; source?: 'cli' | 'web' };
    if (!text || !text.trim()) {
      res.status(400).json({ error: "Missing required field: text" });
      return;
    }
    const validAuthor = author === "agent" ? "agent" : "user";
    const validSource = source === 'cli' ? 'cli' : 'web';
    const comment = addComment(projectDir, id, validAuthor, text.trim(), Array.isArray(files) ? files : undefined, undefined, validSource);
    broadcast({ type: "tasks-updated" });
    res.json({ success: true, comment });
  });

  app.patch("/api/tasks/:id/comments/:commentId", (req, res) => {
    const { id, commentId } = req.params;
    const { text } = req.body as { text?: string };
    if (!text || !text.trim()) {
      res.status(400).json({ error: "Missing required field: text" });
      return;
    }
    const comment = updateComment(projectDir, id, commentId, text.trim());
    if (!comment) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }
    res.json({ success: true, comment });
  });

  app.delete("/api/tasks/:id/comments/:commentId", (req, res) => {
    const { id, commentId } = req.params;
    const ok = deleteComment(projectDir, id, commentId);
    if (!ok) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }
    broadcast({ type: "tasks-updated" });
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
    const filePath = getFilePath(projectDir, id, filename);
    if (!filePath) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    // Path is derived from getFilePath() which sanitizes via basename() and
    // only returns paths that exist on disk — no user-controlled traversal.
    res.sendFile(filePath); // nosemgrep
  });

  const ALLOWED_FILE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".txt", ".md", ".json", ".csv", ".svg", ".mp4", ".mov", ".zip"]);

  app.post(
    "/api/tasks/:id/files/:filename",
    express.raw({ type: "*/*", limit: "50mb" }),
    (req, res) => {
      const { id, filename: rawFilename } = req.params;
      // Reject path-traversal filenames
      if (!rawFilename || rawFilename.includes("/") || rawFilename.includes("\\")) {
        res.status(400).json({ error: "Invalid filename" });
        return;
      }
      const ext = extname(decodeURIComponent(rawFilename)).toLowerCase();
      if (!ALLOWED_FILE_EXTENSIONS.has(ext)) {
        res.status(415).json({ error: "File type not allowed" });
        return;
      }
      const data = req.body as Buffer;
      if (!Buffer.isBuffer(data) || data.length === 0) {
        res.status(400).json({ error: "Empty file body" });
        return;
      }
      const info = saveFile(projectDir, id, decodeURIComponent(rawFilename), data);
      broadcast({ type: "tasks-updated" });
      res.json({ success: true, file: info });
    },
  );

  app.delete("/api/tasks/:id/files/:filename", (req, res) => {
    const { id, filename } = req.params;
    const deleted = deleteFile(projectDir, id, filename);
    if (!deleted) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    // Add a system trace so the activity feed records the removal.
    addComment(projectDir, id, "user", `🗑️ File removed: \`${filename}\``, undefined, "system", "web");
    broadcast({ type: "tasks-updated" });
    res.json({ success: true });
  });

  // Screenshot API
  const screenshotsDir = join(projectDir, PROTO_DIR, SCREENSHOTS_DIR);

  app.post("/api/tasks/:id/screenshot", express.json(), (req, res) => {
    const { id } = req.params;
    const { screenshot } = req.body as { screenshot?: string };
    if (!findTaskFilePath(projectDir, id)) { res.status(404).json({ error: "Task not found" }); return; }
    if (!screenshot) { res.status(400).json({ error: "Missing screenshot" }); return; }
    mkdirSync(screenshotsDir, { recursive: true });
    const filename = `${id}.png`;
    writeFileSync(join(screenshotsDir, filename), Buffer.from(screenshot, "base64"));
    updateTask(projectDir, id, { screenshot: filename } as Partial<Task>);
    broadcast({ type: "tasks-updated" });
    res.json({ success: true, screenshot: filename });
  });

  app.delete("/api/tasks/:id/screenshot", (req, res) => {
    const { id } = req.params;
    if (!findTaskFilePath(projectDir, id)) { res.status(404).json({ error: "Task not found" }); return; }
    const filename = `${id}.png`;
    const filePath = join(screenshotsDir, filename);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
    updateTask(projectDir, id, { screenshot: undefined } as Partial<Task>);
    broadcast({ type: "tasks-updated" });
    res.json({ success: true });
  });
}

/** Registers /api/copilot/status, /api/user, /api/settings, and related meta endpoints. */
function registerMetaApis(
  app: express.Application,
  projectDir: string,
  broadcast?: (data: object) => void,
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
    const SETTABLE_KEYS = new Set(["visibleCols", "viewMode", "panelWidth", "autoCommit", "autoComment", "autoPush", "createBranch", "defaultModel", "defaultAgent", "perTypeModels", "defaultModelBug", "defaultModelResearch", "defaultModelTask", "experimentalAgents"]);
    const filtered = Object.fromEntries(
      Object.entries(req.body as Record<string, unknown>).filter(([k]) => SETTABLE_KEYS.has(k)),
    );
    const saved = saveSettings(projectDir, filtered);
    res.json({ success: true, settings: saved });
  });

  // ── SaaS push: list available boards ───────────────────────────────────────
  // Used by the kanban OnlineModeOverlay "Push to board" button.
  app.get("/api/push/workspaces", async (_req, res) => {
    const token = await readToken().catch(() => null);
    if (!token) { res.status(401).json({ error: "Not logged in" }); return; }
    const apiUrl = process.env.VIBEFLOW_API_URL ?? "http://localhost:3000";
    try {
      const r = await fetch(`${apiUrl}/api/cli/workspaces`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({})) as Record<string, unknown>;
        const msg = (body.error as string) ?? `HTTP ${r.status} from ${apiUrl}`;
        console.error(`[Proto] GET /api/push/workspaces failed: ${msg}`);
        res.status(r.status).json({ error: msg }); return;
      }
      res.json(await r.json());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[Proto] GET /api/push/workspaces network error: ${msg}`);
      res.status(502).json({ error: `Network error contacting SaaS API: ${msg}` });
    }
  });

  // ── SaaS push: import local tasks into a board ───────────────────────────────
  app.post("/api/push", express.json(), async (req, res) => {
    const { workspaceId, keepLocalFiles } = req.body as { workspaceId?: string; keepLocalFiles?: boolean };
    const token = await readToken().catch(() => null);
    if (!token) { res.status(401).json({ error: "Not logged in" }); return; }
    const taskList = listTasksWithPaths(projectDir);
    if (taskList.length === 0) { res.json({ imported: 0, message: "No local tasks found" }); return; }
    const apiUrl = process.env.VIBEFLOW_API_URL ?? "http://localhost:3000";
    const requestBody: { tasks: unknown[]; workspaceId?: string } = { tasks: taskList };
    try {
      const r = await fetch(`${apiUrl}/api/cli/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(requestBody),
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({})) as Record<string, unknown>;
        res.status(r.status).json({ error: (err.error as string) ?? "Import failed" });
        return;
      }
      const result = await r.json() as { imported: number; skipped?: number; workspaceId: string; boardId: string };
      if (!keepLocalFiles) {
        for (const task of taskList) {
          try { unlinkSync(task.filePath); } catch { /* ignore — already removed */ }
        }
        broadcast?.({ type: "tasks-updated" });
      }
      res.json({ imported: result.imported, skipped: result.skipped ?? 0, workspaceId: result.workspaceId, boardId: result.boardId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[Proto] POST /api/push network error: ${msg}`);
      res.status(502).json({ error: `Network error contacting SaaS API: ${msg}` });
    }
  });

  // Returns GitHub Copilot authentication status.
  app.get("/api/copilot/status", (_req, res) => {
    getCopilotAuthStatus(projectDir)
      .then((status) => res.json(status))
      .catch((e: unknown) => {
        console.error(`[Proto] GET /api/copilot/status error: ${e instanceof Error ? e.message : String(e)}`);
        res.json({ authenticated: false, source: null, tokenHint: null, username: null });
      });
  });

  app.post("/api/copilot/login", async (req, res) => {
    if (!requireSameOrigin(req, res)) return;
    try {
      const status = await getCopilotAuthStatus(projectDir);
      if (status.authenticated) {
        res.json({ launched: false, alreadyAuthenticated: true, username: status.username ?? null });
        return;
      }
      if (!isGhCliAvailable()) {
        res.status(400).json({
          launched: false,
          error: "GitHub CLI is not installed. Install gh and authenticate with 'gh auth login'.",
        });
        return;
      }

      const child = spawn(
        "gh",
        [
          "auth",
          "login",
          "--web",
          "--hostname",
          "github.com",
          "--git-protocol",
          "https",
          "--scopes",
          "read:user,copilot",
        ],
        {
          cwd: projectDir,
          detached: true,
          stdio: "ignore",
        },
      );
      child.unref();
      res.json({ launched: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[Proto] POST /api/copilot/login error: ${msg}`);
      res.status(500).json({
        launched: false,
        error: msg,
      });
    }
  });

  // Agent status: lightweight single-value store so the GH Copilot CLI agent
  // can push its current activity and the Kanban board can display it.
  let agentStatus: { message: string; active: boolean; updatedAt: string } | null = null;

  app.get("/api/agent-status", (_req, res) => {
    res.json(agentStatus ?? { message: "", active: false, updatedAt: null });
  });

  app.post("/api/agent-status", (req, res) => {
    if (!requireSameOrigin(req, res)) return;
    const { message, active } = req.body as { message?: string; active?: boolean };
    agentStatus = {
      message: (message ?? "").slice(0, 200),
      active: active !== false,
      updatedAt: new Date().toISOString(),
    };
    broadcast?.({ type: "agent-status", ...agentStatus });
    res.json({ ok: true });
  });

  app.delete("/api/agent-status", (req, res) => {
    if (!requireSameOrigin(req, res)) return;
    agentStatus = null;
    broadcast?.({ type: "agent-status", message: "", active: false, updatedAt: null });
    res.json({ ok: true });
  });

  // ── Agent run: spawn opencode with task context ────────────────────────────
  const activeAgentRuns = new Map<string, import("node:child_process").ChildProcess>();
  /** Accumulated session metadata per active run (tokens, cost from opencode JSON output) */
  const activeRunMeta = new Map<string, { inputTokens: number; outputTokens: number; totalTokens: number; reasoningTokens: number; cost: number }>();

  function accumulateRunMeta(taskId: string, line: string) {
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      if (event.type === "step_finish" && typeof event.part === "object" && event.part) {
        const part = event.part as Record<string, unknown>;
        const tokens = part.tokens as Record<string, number> | undefined;
        const cost = typeof part.cost === "number" ? part.cost : 0;
        if (tokens) {
          const prev = activeRunMeta.get(taskId) ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cost: 0 };
          activeRunMeta.set(taskId, {
            inputTokens: prev.inputTokens + (tokens.input ?? 0),
            outputTokens: prev.outputTokens + (tokens.output ?? 0),
            totalTokens: prev.totalTokens + (tokens.total ?? 0),
            reasoningTokens: prev.reasoningTokens + (tokens.reasoning ?? 0),
            cost: prev.cost + cost,
          });
        }
      }
    } catch { /* not JSON or unexpected shape — ignore */ }
  }

  app.post("/api/agent/run", express.json(), async (req, res) => {
    if (!requireSameOrigin(req, res)) return;
    const { taskId, model, agent } = req.body as { taskId?: string; model?: string; agent?: string };
    if (!taskId) { res.status(400).json({ error: "taskId is required" }); return; }
    if (!isValidTaskId(taskId)) { res.status(400).json({ error: "Invalid task ID" }); return; }

    // Read the task to build a meaningful message for opencode
    const taskFilePath = findTaskFilePath(projectDir, taskId);
    if (!taskFilePath) { res.status(404).json({ error: "Task not found" }); return; }
    const task = readTaskFile(taskFilePath);
    if (!task) { res.status(404).json({ error: "Task not found" }); return; }

    // Build comprehensive task context for the agent.
    // Uses the same shared formatter as `vibeflow tasks --get` so agents
    // always receive identical instructions regardless of entry point.
    const comments = listComments(projectDir, taskId).filter((c) => !c.deleted);
    const config = readConfig(projectDir);
    const linkedFiles = listFiles(projectDir, taskId).map((f) => ({
      ...f,
      url: `http://localhost:${config.port}${f.url}`,
    }));
    const settings = loadSettings(projectDir);
    const isResearch = (task.type ?? "").toLowerCase() === "research";
    const isBug = (task.type ?? "").toLowerCase() === "bug";
    const taskMessage = renderTaskForAgent(task, taskFilePath, comments, linkedFiles, projectDir);
    const instructions = renderAgentInstructions({
      hasResearchTasks: isResearch,
      hasBugTasks: isBug,
      autoCommit: settings.autoCommit,
      autoPush: settings.autoPush,
      autoComment: settings.autoComment,
      createBranch: settings.createBranch,
    });
    const message = `${taskMessage}\n\n${instructions}`;

    // Check if opencode is available
    try {
      execSync("which opencode", { timeout: 5000 });
    } catch {
      res.status(500).json({ error: "opencode is not installed. Install it to run agents." });
      return;
    }

    // Prevent duplicate runs for the same task
    if (activeAgentRuns.has(taskId)) {
      res.status(409).json({ error: "Agent already running for this task" });
      return;
    }

    const args = ["run", "--dangerously-skip-permissions", "--format", "json", "--", message];
    if (model) args.splice(2, 0, "--model", model);
    if (agent) args.splice(2, 0, "--agent", agent);

    broadcast?.({
      type: "agent-run-started",
      taskId,
      model,
      agent,
      command: `opencode ${args.join(" ")}`,
    });

    const child = spawn("opencode", args, {
      cwd: projectDir,
      env: { ...process.env, FORCE_COLOR: "0" },
    });

    activeAgentRuns.set(taskId, child);
    activeRunMeta.set(taskId, { inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cost: 0 });

    let output = "";
    child.stdout?.on("data", (data: Buffer) => {
      const text = data.toString();
      output += text;
      // Parse JSON lines to accumulate token/cost metadata
      for (const line of text.split("\n")) {
        if (line.trim()) accumulateRunMeta(taskId, line.trim());
      }
      broadcast?.({ type: "agent-run-log", taskId, log: text });
    });

    child.stderr?.on("data", (data: Buffer) => {
      const text = data.toString();
      output += text;
      broadcast?.({ type: "agent-run-log", taskId, log: text });
    });

    child.on("close", (code) => {
      activeAgentRuns.delete(taskId);
      const meta = activeRunMeta.get(taskId);
      activeRunMeta.delete(taskId);
      broadcast?.({
        type: "agent-run-finished",
        taskId,
        exitCode: code,
        success: code === 0,
        ...(meta ?? {}),
      });
    });

    child.on("error", (err) => {
      activeAgentRuns.delete(taskId);
      const meta = activeRunMeta.get(taskId);
      activeRunMeta.delete(taskId);
      broadcast?.({
        type: "agent-run-finished",
        taskId,
        exitCode: 1,
        success: false,
        error: err.message,
        ...(meta ?? {}),
      });
    });

    res.json({ ok: true, taskId, command: `opencode ${args.join(" ")}` });
  });

  app.post("/api/agent/stop", express.json(), (req, res) => {
    if (!requireSameOrigin(req, res)) return;
    const { taskId } = req.body as { taskId?: string };
    if (!taskId) { res.status(400).json({ error: "taskId is required" }); return; }

    const child = activeAgentRuns.get(taskId);
    if (!child) {
      res.status(404).json({ error: "No active agent run for this task" });
      return;
    }

    child.kill("SIGINT");
    res.json({ ok: true, taskId });
  });

  // ── List available opencode agents ─────────────────────────────────────────
  app.get("/api/agent/agents", (_req, res) => {
    try {
      const output = execSync("opencode agent list", { cwd: projectDir, timeout: 10000, env: { ...process.env, FORCE_COLOR: "0" } }).toString();
      // Parse "AgentName (scope)" lines from the output
      const agents = output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => /^[A-Za-z][A-Za-z0-9_-]+ \(/.test(line))
        .map((line) => {
          const match = line.match(/^([A-Za-z][A-Za-z0-9_-]+)\s+\((.+)\)$/);
          return match ? { id: match[1], name: match[1], scope: match[2] } : null;
        })
        .filter(Boolean) as Array<{ id: string; name: string; scope: string }>;
      res.json({ agents });
    } catch {
      res.json({ agents: [] });
    }
  });

  // ── List available opencode models ─────────────────────────────────────────
  app.get("/api/agent/models", async (_req, res) => {
    try {
      const output = execSync("opencode models", { cwd: projectDir, timeout: 15000, env: { ...process.env, FORCE_COLOR: "0" } }).toString();
      // Parse model entries — opencode outputs them as "provider/model-id  Model Label"
      const models: Array<{ id: string; label: string; provider: string }> = [];
      for (const line of output.split("\n")) {
        const trimmed = line.trim();
        // Match lines like "openai/gpt-4o  GPT-4o" or "anthropic/claude-sonnet-4-20250514  Claude Sonnet 4"
        const match = trimmed.match(/^([a-z0-9-]+)\/([a-z0-9._-]+)\s+(.+)$/i);
        if (match) {
          models.push({ id: `${match[1]}/${match[2]}`, label: match[3].trim(), provider: match[1] });
        }
      }
      res.json({ models });
    } catch {
      res.json({ models: [] });
    }
  });

  // Returns the GitHub commit URL base for this repo (parsed from git remote origin).
  // Converts git@github.com:user/repo.git and https://github.com/user/repo.git
  // to https://github.com/user/repo so the frontend can build commit diff links.
  app.get("/api/github-url", (_req, res) => {
    try {
      const remote = execSync("git remote get-url origin", { cwd: projectDir, timeout: 3000 }).toString().trim();
      // git@github.com:owner/repo.git → https://github.com/owner/repo
      const sshMatch = remote.match(/^git@github\.com:(.+?)(?:\.git)?$/);
      if (sshMatch) { res.json({ githubUrl: `https://github.com/${sshMatch[1]}` }); return; }
      // https://github.com/owner/repo.git → https://github.com/owner/repo
      const httpsMatch = remote.match(/^(https?:\/\/github\.com\/[^/]+\/[^/]+?)(?:\.git)?$/);
      if (httpsMatch) { res.json({ githubUrl: httpsMatch[1] }); return; }
    } catch { /* git not available or no remote */ }
    res.json({ githubUrl: null });
  });

}

/** Registers /kanban — a live Kanban board that connects to the task API. */
function registerKanbanRoute(app: express.Application, port: number): void {
  const adminEmail = process.env.VIBEFLOW_ADMIN_EMAIL ?? "";
  const apiUrl = process.env.VIBEFLOW_API_URL ?? "http://localhost:3000";

  app.get("/kanban", async (_req, res) => {
    const token = await readToken().catch(() => null);
    if (!token) {
      res.type("html").send(getKanbanHtml({ port }));
      return;
    }
    const workspace = await readWorkspace().catch(() => null);

    // Always fetch profile from API to determine admin status — never use cached email.
    let isAdmin = false;
    if (adminEmail) {
      try {
        const profileRes = await fetch(`${apiUrl}/api/cli/profile`, {
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => null);
        if (profileRes?.ok) {
          const profile = (await profileRes.json()) as { email?: string };
          isAdmin = profile.email === adminEmail;
        }
      } catch { /* non-critical — isAdmin stays false */ }
    }

    const opts: KanbanOptions = {
      port,
      saasMode: true,
      boardUrl: workspace?.url ?? `${apiUrl}/kanban`,
      boardName: workspace?.name,
      isAdmin,
    };
    res.type("html").send(getKanbanHtml(opts));
  });
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

function escapeHtml(s: string): string { return s.replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

const VIBEFLOW_FAVICON = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32' fill='none'%3E%3Crect width='32' height='32' rx='7' fill='%232563eb'/%3E%3Crect x='7' y='13' width='3.5' height='10' rx='1.5' fill='white' opacity='.75'/%3E%3Crect x='12.25' y='8.5' width='3.5' height='15' rx='1.5' fill='white'/%3E%3Crect x='17.5' y='14.5' width='3.5' height='8' rx='1.5' fill='white' opacity='.75'/%3E%3Crect x='22.5' y='11' width='2.5' height='11' rx='1.25' fill='white' opacity='.85'/%3E%3C/svg%3E`;

function buildInjectPageHtml(subtitle: string, sections: string[]): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Vibeflow — Inject Overlay</title><link rel="icon" type="image/svg+xml" href="${VIBEFLOW_FAVICON}"><style>${INJECT_PAGE_CSS}</style></head>
<body>
  <h1>Vibeflow — Inject Overlay</h1>
  <p style="margin-top:6px">${subtitle}</p>
${sections.join('\n')}
</body></html>`;
}

/** Serves /inject — helper page with bookmarklet and instructions for adding
 * the overlay to an existing app without modifying its source code. */
function registerInjectPage(app: express.Application, port: number, boardId?: string, saasUrl?: string): void {
  // Strip all chars that are not alphanumeric, underscore, or hyphen to prevent
  // HTML attribute injection and JS string injection via a crafted workspace file.
  const safeBoardId = boardId ? boardId.replace(/[^a-zA-Z0-9_-]/g, "") : undefined;
  if (saasUrl) {
    const saasOverlayUrl = `${saasUrl}/api/overlay.js`;
    const boardIdSetup = safeBoardId ? `window.__PROTO_BOARD_ID='${safeBoardId}';` : '';
    const bookmarkletCode = `javascript:(function(){if(document.getElementById('vibeflow-studio-root')){alert('Vibeflow overlay is already active.')}else{${boardIdSetup}fetch('${saasOverlayUrl}').then(function(r){return r.text()}).then(function(code){eval(code)}).catch(function(){alert('Failed to load Vibeflow overlay')})}})()`;
    const consoleSaasSnippet = `${boardIdSetup}fetch('${saasOverlayUrl}').then(r=>r.text()).then(code=>eval(code));`;
    const saasScriptTag = safeBoardId
      ? `<script src="${saasOverlayUrl}" data-vibeflow-overlay data-board-id="${safeBoardId}"></script>`
      : `<script src="${saasOverlayUrl}" data-vibeflow-overlay></script>`;

    app.get("/inject", (_req, res) => {
      res.type("html").send(buildInjectPageHtml(
        `Add the Vibeflow overlay to any page to annotate and create tasks.${safeBoardId ? `<br><span style="font-size:12px;color:#64748b">Connected to board <code style="background:#1e293b;padding:2px 6px;border-radius:4px">${safeBoardId}</code> via SaaS.</span>` : ''}`,
        [
          `<h2>Option 1 — Bookmarklet <span class="badge green">CSP-safe</span> <span class="badge">recommended</span></h2>
  <div class="card"><p>Drag this link to your bookmarks bar, then click it on any page to activate the overlay:</p>
    <a class="bookmarklet" href="${bookmarkletCode}"><svg class='bookmarklet-icon' viewBox='0 0 32 32' fill='none' xmlns='http://www.w3.org/2000/svg'><rect x='7' y='13' width='3.5' height='10' rx='1.5' fill='white' opacity='.75'/><rect x='12.25' y='8.5' width='3.5' height='15' rx='1.5' fill='white'/><rect x='17.5' y='14.5' width='3.5' height='8' rx='1.5' fill='white' opacity='.75'/><rect x='22.5' y='11' width='2.5' height='11' rx='1.25' fill='white' opacity='.85'/></svg>Vibeflow annotate</a>
    <div class="note">✅ Works on pages with strict Content-Security-Policy (uses fetch + eval instead of &lt;script src&gt;).<br>⚠️ Do not click the link here — drag it to your bookmarks bar first, then use it on your target page.</div></div>`,
          `<h2>Option 2 — Browser console <span class="badge green">CSP-safe</span></h2>
  <div class="card"><p>Open browser DevTools console on your target page and paste:</p>
    <pre>${escapeHtml(consoleSaasSnippet)}</pre>
    <div class="note">✅ Works on most pages — uses fetch + eval which respects <code>connect-src https:</code> and <code>unsafe-eval</code>.</div></div>`,
          `<h2>Option 3 — Script tag</h2>
  <div class="card"><p>Add this tag to your HTML (before <code>&lt;/body&gt;</code>):</p>
    <pre>${escapeHtml(saasScriptTag)}</pre>
    <div class="note">Requires your CSP to allow loading scripts from <code>${saasUrl}</code>. Suitable when you control the page's HTML.</div></div>`,
        ],
      ));
    });
    return;
  }

  const scriptUrl = `http://localhost:${port}/vibeflow-overlay.js`;
  const boardIdAttr = safeBoardId ? ` data-board-id="${safeBoardId}"` : '';
  const snippet = `<script src="${scriptUrl}" data-vibeflow-overlay${boardIdAttr}></script>`;
  const boardIdLine = safeBoardId ? `s.setAttribute('data-board-id','${safeBoardId}');` : '';
  const bookmarkletCode = `javascript:(function(){if(document.getElementById('vibeflow-studio-root')){alert('Vibeflow overlay is already active on this page.');}else{var s=document.createElement('script');s.src='${scriptUrl}';s.setAttribute('data-vibeflow-overlay','');${boardIdLine}document.head.appendChild(s);}})()`;

  app.get("/inject", (_req, res) => {
    res.type("html").send(buildInjectPageHtml(
      'Add the Vibeflow overlay to any page without modifying source code.',
      [
        `<h2>Option 1 — Bookmarklet <span class="badge">recommended</span></h2>
  <div class="card"><p>Drag this link to your bookmarks bar, then click it on any page to activate the overlay:</p>
    <a class="bookmarklet" href="${bookmarkletCode}"><svg class='bookmarklet-icon' viewBox='0 0 32 32' fill='none' xmlns='http://www.w3.org/2000/svg'><rect x='7' y='13' width='3.5' height='10' rx='1.5' fill='white' opacity='.75'/><rect x='12.25' y='8.5' width='3.5' height='15' rx='1.5' fill='white'/><rect x='17.5' y='14.5' width='3.5' height='8' rx='1.5' fill='white' opacity='.75'/><rect x='22.5' y='11' width='2.5' height='11' rx='1.25' fill='white' opacity='.85'/></svg>Vibeflow annotate</a>
    <div class="note">⚠️ Do not click the link here — drag it to your bookmarks bar first, then use it on your target page.</div></div>`,
        `<h2>Option 2 — Script tag</h2>
  <div class="card"><p>Add this tag to your HTML (before <code>&lt;/body&gt;</code>):</p>
    <pre>${escapeHtml(snippet)}</pre>
    <div class="note">Requires the proto server to be running at port ${port}. Works without the Chrome extension.</div></div>`,
        `<h2>Option 3 — Browser console</h2>
  <div class="card"><p>Open browser DevTools console and paste:</p>
    <pre>var s=document.createElement('script');s.src='${scriptUrl}';s.setAttribute('data-vibeflow-overlay','');${safeBoardId ? `s.setAttribute('data-board-id','${safeBoardId}');` : ''}document.head.appendChild(s);</pre></div>`,
        `<div class="note" style="margin-top:20px">⚙️ <strong>CSP note:</strong> If your app sets a strict Content-Security-Policy, use the Chrome extension instead — it bypasses CSP by injecting in the main world.</div>`,
      ],
    ));
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
 */
function useErrorHandler(app: express.Application): void {
   
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[Proto] Unhandled error:", err.message);
    res.status(500).json({ error: "Internal server error" });
  });
}

/**
 * CORS middleware: allow cross-origin requests so the overlay running inside an
 * existing app (different port/origin) can call the Vibeflow Studio task API.
 * Safe for a localhost development tool.
 */
function useCors(app: express.Application): void {
  app.use((_req: express.Request, res: express.Response, next: express.NextFunction) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (_req.method === "OPTIONS") { res.status(204).end(); return; }
    next();
  });
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
  app.use((_req: express.Request, res: express.Response, next: express.NextFunction) => {
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
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    // COEP: unsafe-none is required for the kanban UI which loads resources from same origin
    // and for the overlay-showcase.html demo which uses cross-origin CDN resources.
    res.setHeader("Cross-Origin-Embedder-Policy", "unsafe-none");
    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    next();
  });
}

/**
 * API-only mode: starts the task API server without serving any HTML files.
 * Intended for use with existing hosted/served projects — the Chrome extension
 * connects to this server to read and write tasks while you browse your app.
 */
async function serveApiOnly(
  projectDir: string,
  options: ServeOptions,
): Promise<ServeInstance> {
  // Check auth before registering any routes — online mode must never expose local task API.
  const token = options._testToken !== undefined ? options._testToken : await readToken().catch(() => null);
  const workspace = options._testWorkspace !== undefined ? options._testWorkspace : (token ? await readWorkspace().catch(() => null) : null);
  const isOnline = !!(token && workspace);

  const app = express();
  useCors(app);
  useSecurityHeaders(app);
  app.use(express.json({ limit: "10mb" }));
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer });

  const broadcast = (data: object) => {
    const msg = JSON.stringify(data);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  };

  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      } catch { /* ignore non-JSON */ }
    });
  });

  // Derive SaaS base URL from workspace.url origin — validated against known production domains to prevent SSRF.
  // Falls back to VIBEFLOW_API_URL env var for custom servers or testing.
  const saasApiUrl = sanitizeWorkspaceOrigin(workspace?.url) ?? process.env.VIBEFLOW_API_URL ?? "http://localhost:3000";

  if (isOnline) {
    // Online mode: local task API is intentionally blocked. Any accidental call to /api/tasks
    // or /trpc will return 503 so problems surface immediately instead of silently writing local files.
    app.use(["/api/tasks", "/api/push", "/trpc"], (_req, res) => {
      res.status(503).json({
        error: "Online mode active — local task API is disabled. All task operations go through the SaaS backend.",
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

    const overlayScript = getOverlayScript(options.port);
    app.get("/vibeflow-overlay.js", (_req, res) => {
      res.type("application/javascript").send(overlayScript);
    });
    const screenshotsDirOffline = join(projectDir, PROTO_DIR, SCREENSHOTS_DIR);
    app.get("/screenshots/:filename", (req, res) => {
      const { filename } = req.params;
      const taskId = basename(filename as string, ".png");
      if (!isValidTaskId(taskId)) { res.status(400).end(); return; }
      const filePath = join(screenshotsDirOffline, `${taskId}.png`);
      if (!existsSync(filePath)) { res.status(404).end(); return; }
      res.sendFile(filePath); // nosemgrep: javascript.express.security.audit.express-res-sendfile.express-res-sendfile
    });

    registerPagesApi(app, []);
    registerTaskApi(app, projectDir, broadcast);
    registerTrpcApi(app, projectDir, broadcast);
    registerMetaApis(app, projectDir, broadcast);
  }

  registerKanbanRoute(app, options.port);
  registerInjectPage(app, options.port, isOnline ? workspace?.id : undefined, isOnline ? saasApiUrl : undefined);

  const taskWatcher = isOnline ? null : createTaskWatcher(join(projectDir, PROTO_DIR, TASKS_DIR), {
    onChanged: (filePath) => {
      const task = readTaskFile(filePath);
      if (task) broadcast({ type: "task-changed", taskId: task.id, action: "update", task, source: 'cli' });
      else broadcast({ type: "tasks-updated" });
    },
    onDeleted: (filePath) => {
      const taskId = basename(filePath, ".json");
      broadcast({ type: "task-deleted", taskId });
    },
  });

  useErrorHandler(app);

  return new Promise<ServeInstance>((resolvePromise, reject) => {
    const bindHost = options.host ?? 'localhost';
    httpServer.listen(options.port, bindHost, () => {
      const displayHost = bindHost === '0.0.0.0' ? getLanIp() ?? 'localhost' : bindHost;
      const url = `http://${displayHost}:${options.port}`;
      const localUrl = bindHost === '0.0.0.0' ? `http://localhost:${options.port}` : null;
      const divider = chalk.dim("  " + "─".repeat(62));

      console.log();
      console.log(chalk.green("  ✓ Vibeflow running") + chalk.dim(" · ") + chalk.cyan(url));
      if (localUrl) {
        console.log(chalk.dim("  Local:          ") + chalk.cyan(localUrl));
      }
      console.log(divider);

      if (isOnline) {
        console.log(chalk.dim("  Mode:  ") + chalk.green("● Online") + chalk.dim(" — connected to Vibeflow SaaS"));
        console.log(chalk.dim("  Board: ") + chalk.white(workspace!.name ?? "your board"));
        console.log(chalk.dim("  Web:   ") + chalk.cyan(workspace!.url));
        console.log(divider);
        console.log(chalk.dim("  Overlay script:  ") + chalk.cyan(`${url}/vibeflow-overlay.js`));
        console.log();
        console.log(chalk.dim("  ┌─ Add to your HTML ") + chalk.dim("─".repeat(43) + "┐"));
        console.log(chalk.dim("  │ ") + chalk.yellow(`<script src="${url}/vibeflow-overlay.js" data-vibeflow-overlay></script>`) + chalk.dim(" │"));
        console.log(chalk.dim("  │ ") + chalk.dim("Or drag the bookmarklet: ") + chalk.cyan(`${url}/inject`) + chalk.dim("         │"));
        console.log(chalk.dim("  └" + "─".repeat(63) + "┘"));
      } else {
        console.log(chalk.dim("  Mode:  ") + chalk.yellow("◎ Local") + chalk.dim(" — no account needed"));
        console.log(divider);
        console.log(chalk.bold.white("  BOARDS & APIS"));
        console.log(chalk.dim("  Kanban board    ") + chalk.cyan(`${url}/kanban`));
        console.log(chalk.dim("  Task API        ") + chalk.cyan(`${url}/api/tasks`));
        console.log(divider);
        console.log(chalk.bold.white("  INTEGRATE INTO YOUR APP") + chalk.dim(`  (full guide: ${url}/inject)`));
        console.log(chalk.dim("  1. Add this script tag to your HTML:"));
        console.log(chalk.dim("     ") + chalk.yellow(`<script src="${url}/vibeflow-overlay.js" data-vibeflow-overlay></script>`));
        console.log(chalk.dim("  2. Reload your page — the overlay appears automatically."));
        console.log(chalk.dim("  3. Click anything to annotate it."));
        console.log(divider);
        console.log(chalk.dim("  Bookmarklet — no code changes needed:"));
        console.log(chalk.dim("  Visit and drag the bookmarklet from ") + chalk.cyan(`${url}/inject`) + chalk.dim(" to your bookmarks bar."));
      }
      console.log();
      console.log(chalk.dim("  Press Ctrl+C to stop"));
      console.log();

      resolvePromise({
        url,
        close: async () => {
          if (taskWatcher) await taskWatcher.close();
          wss.close();
          await new Promise<void>((r) => httpServer.close(() => r()));
        },
      });
    });

    httpServer.on("error", reject);
  });
}

export async function serve(
  target: string | undefined,
  options: ServeOptions,
): Promise<ServeInstance> {
  // API-only mode: no target provided
  if (!target) {
    return serveApiOnly(options.projectDir ?? process.cwd(), options);
  }

  // Proxy mode was removed. Only Chrome extension or static file serving are supported.
  if (target.startsWith("http://") || target.startsWith("https://")) {
    throw new Error(
      "Proxy mode is no longer supported.\n" +
      "To annotate an existing app, run: proto serve  (API-only mode)\n" +
      "Then install the Chrome extension and navigate to your app.",
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
  ensureTaskDirs(projectDir);

  const app = express();
  useCors(app);
  useSecurityHeaders(app);
  app.use(express.json({ limit: "10mb" }));
  const httpServer = createServer(app);
  const wss = new WebSocketServer({ server: httpServer });

  const broadcast = (data: object) => {
    const msg = JSON.stringify(data);
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(msg);
      }
    }
  };

  // Respond to ping from overlay/extension to keep connection alive
  wss.on("connection", (ws) => {
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        }
      } catch { /* ignore non-JSON */ }
    });
  });

  const overlayScript = options.noOverlay ? null : getOverlayScript(options.port);

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
    if (!isValidTaskId(taskId)) { res.status(400).end(); return; }
    const filePath = join(screenshotsDirHtml, `${taskId}.png`);
    if (!existsSync(filePath)) { res.status(404).end(); return; }
    res.sendFile(filePath); // nosemgrep: javascript.express.security.audit.express-res-sendfile.express-res-sendfile
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

  // ── Task API ─────────────────────────────────────────────────────────────
  const pageRoutes = htmlFiles.map((f) => `/${basename(f)}`);
  registerPagesApi(app, isDir ? pageRoutes : []);
  registerTaskApi(app, projectDir, broadcast);
  registerTrpcApi(app, projectDir, broadcast);
  registerMetaApis(app, projectDir, broadcast);
  registerKanbanRoute(app, options.port);
  registerInjectPage(app, options.port);

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
      if (task) broadcast({ type: "task-changed", taskId: task.id, action: "update", task, source: 'cli' });
      else broadcast({ type: "tasks-updated" });
    },
    onDeleted: (filePath) => {
      const taskId = basename(filePath, ".json");
      broadcast({ type: "task-deleted", taskId });
    },
  });

  useErrorHandler(app);

  return new Promise<ServeInstance>((resolvePromise, reject) => {
    const bindHost2 = options.host ?? 'localhost';
    httpServer.listen(options.port, bindHost2, () => {
      const displayHost2 = bindHost2 === '0.0.0.0' ? getLanIp() ?? 'localhost' : bindHost2;
      const url = `http://${displayHost2}:${options.port}`;
      const localUrl = bindHost2 === '0.0.0.0' ? `http://localhost:${options.port}` : null;
      const divider = chalk.dim("  " + "─".repeat(62));

      console.log();
      console.log(chalk.green("  ✓ Vibeflow running") + chalk.dim(" · ") + chalk.cyan(url));
      if (localUrl) {
        console.log(chalk.dim("  Local:         ") + chalk.cyan(localUrl));
      }
      console.log(divider);
      for (const f of htmlFiles) {
        const route = isDir ? `/${basename(f)}` : "/";
        console.log(chalk.dim("  File:          ") + chalk.cyan(`${url}${route}`) + chalk.dim(`  (${basename(f)})`));
      }
      console.log(chalk.dim("  Kanban board:  ") + chalk.cyan(`${url}/kanban`));
      console.log(chalk.dim("  Task API:      ") + chalk.cyan(`${url}/api/tasks`));
      console.log(divider);
      console.log(chalk.bold.white("  INTEGRATE INTO YOUR APP") + chalk.dim(`  (full guide: ${url}/inject)`));
      console.log(chalk.dim("  1. Add this script tag to your HTML:"));
      console.log(chalk.dim("     ") + chalk.yellow(`<script src="${url}/vibeflow-overlay.js" data-vibeflow-overlay></script>`));
      console.log(chalk.dim("  2. Reload your page — the overlay appears automatically."));
      console.log(chalk.dim("  3. Click anything to annotate it."));
      console.log();
      console.log(chalk.dim("  Press Ctrl+C to stop"));
      console.log();

      if (options.open) {
        import("open").then((mod) => mod.default(url)).catch(() => {});
      }

      resolvePromise({
        url,
        close: async () => {
          if (watcher) await watcher.close();
          await taskWatcher.close();
          wss.close();
          await new Promise<void>((r) => httpServer.close(() => r()));
        },
      });
    });

    httpServer.on("error", reject);
  });
}
