/**
 * Agent chat HTTP surface (ticket 0847833f): session lifecycle, message
 * intake, approvals, browser round-trips, and the per-session chat MCP
 * endpoint. Mounted by `serve` ONLY when VIBEFLOW_FEATURES includes CHAT.
 *
 * WHAT: thin glue between the overlay panel (REST + WS broadcast) and
 * the ChatSessionManager / chat MCP servers. All agent→UI events flow
 * out via the serve `broadcast` (the panel filters by sessionId); all
 * UI→agent calls are REST POSTs below. Nothing here runs model work —
 * the pi child owns that; this module routes, times out, and degrades.
 *
 * Endpoints (all JSON):
 * - GET  /api/chat/status → { enabled, piAvailable, active, maxSessions }
 * - POST /api/chat/sessions {} → { sessionId } (503 at the cap)
 * - POST /api/chat/:id/message { message, page? } → { accepted, commandId }
 * - DELETE /api/chat/:id → { closed }
 * - POST /api/chat/approvals/:approvalId { approved } → { resolved }
 * - POST /api/chat/:id/tool-result { requestId, payload } → { received }
 * - ALL  /api/chat-mcp/:sessionId → per-session MCP (StreamableHTTP)
 *
 * Degraded paths (never a hang, never a throw past Express):
 * - unknown/closed session id → 404 (MCP + REST alike)
 * - approval undecided in 120 s → deny (fail-closed, agent is told)
 * - browser round-trip unanswered in 5 s → null (TIMEOUT refusal)
 * - pi child emits garbage → parseError diagnostic, reader continues
 */
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import type { Express, Request, Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ChatSessionManager,
  isAgentChatEnabled,
  TOO_MANY_SESSIONS,
  type ChatImage,
} from "./sessions.js";
import { mapPiRecord } from "./protocol.js";
import {
  createChatMcpServer,
  CHAT_MCP_APPROVAL_TIMEOUT_MS,
  CHAT_MCP_DOM_ROUNDTRIP_TIMEOUT_MS,
  type ChatMcpHooks,
} from "./mcp.js";
import { mcpAuth } from "../../mcp/auth.js";

const APPROVAL_TIMEOUT_MS = CHAT_MCP_APPROVAL_TIMEOUT_MS;
// Ticket 658d0238: 5 s browser round-trip budget — the DOM read either
// answers fast or the tab is gone; hanging the agent longer blocks the
// model turn on a dead client for no benefit.
const DOM_ROUNDTRIP_TIMEOUT_MS = CHAT_MCP_DOM_ROUNDTRIP_TIMEOUT_MS;
const PI_PROBE_TTL_MS = 60_1000;
const REAPER_INTERVAL_MS = 5 * 60 * 1000;

interface PendingApproval {
  sessionId: string;
  toolName: string;
  argsSummary: string;
  createdAt: number;
  resolve: (approved: boolean) => void;
}

interface PendingDomRead {
  sessionId: string;
  resolve: (result: { text: string; found: boolean } | null) => void;
}

interface ChatMcpMount {
  server: ReturnType<typeof createChatMcpServer>;
  transports: Map<string, StreamableHTTPServerTransport>;
  createdAt: number;
  lastSeen: number;
}

export interface ChatRoutesOptions {
  manager: ChatSessionManager;
  broadcast: (data: Record<string, unknown>) => void;
  /** Project dir the chat agents work in (tool context + MCP cwd). */
  projectDir: string;
}

let reaper: NodeJS.Timeout | null = null;
const approvals = new Map<string, PendingApproval>();
const domReads = new Map<string, PendingDomRead>();
const chatMcpMounts = new Map<string, ChatMcpMount>();
let piProbe: { at: number; available: boolean } | null = null;

function startReapers(): void {
  if (reaper) return;
  reaper = setInterval(() => {
    const now = Date.now();
    for (const [id, approval] of approvals) {
      if (now - approval.createdAt > APPROVAL_TIMEOUT_MS) {
        approvals.delete(id);
        approval.resolve(false);
      }
    }
    for (const [id, mount] of chatMcpMounts) {
      if (now - mount.lastSeen > APPROVAL_TIMEOUT_MS * 5) {
        for (const transport of mount.transports.values()) {
          transport.close().catch(() => {});
        }
        chatMcpMounts.delete(id);
      }
    }
  }, REAPER_INTERVAL_MS);
  // Never hold a one-shot CLI process open for chat housekeeping.
  reaper.unref();
}

function probePiAvailable(): boolean {
  const now = Date.now();
  if (piProbe && now - piProbe.at < PI_PROBE_TTL_MS) return piProbe.available;
  let available = false;
  try {
    const result = spawnSync("pi", ["--version"], { timeout: 10_000 });
    available = result.status === 0;
  } catch {
    available = false;
  }
  piProbe = { at: now, available };
  return available;
}

/** Trusted metadata the browser attaches to every message (never page body). */
export interface ChatPageContext {
  url?: string;
  title?: string;
  selector?: string;
  selectedText?: string;
  parentSnippet?: string;
}

/**
 * Shared hook wiring for chat MCP servers: approvals always on (the
 * gate is the point), DOM round-trips and project dir bound to the
 * serve broadcast. One factory so the mount path below and any future
 * caller cannot drift apart.
 */
export function hooksFor(
  broadcast: (data: Record<string, unknown>) => void,
  projectDir: string,
): ChatMcpHooks {
  return {
    approvalsEnabled: () => true,
    requestApproval: (sessionId, toolName, argsSummary) =>
      requestApproval(broadcast, sessionId, toolName, argsSummary),
    requestBrowserDom: (sessionId, selector) =>
      requestBrowserDom(broadcast, sessionId, selector),
    projectDirFor: () => projectDir,
  };
}

export function registerChatRoutes(app: Express, opts: ChatRoutesOptions): void {
  const { manager, broadcast, projectDir } = opts;
  startReapers();
  void projectDir;

  app.get("/api/chat/status", (_req: Request, res: Response) => {
    res.json({
      enabled: true,
      piAvailable: probePiAvailable(),
      active: manager.size,
    });
  });

  app.post("/api/chat/sessions", (_req: Request, res: Response) => {
    try {
      const session = manager.create();
      session.on("record", (record) => {
        for (const event of mapPiRecord(session.id, record)) {
          broadcast({ ...event });
        }
      });
      res.json({ sessionId: session.id });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === TOO_MANY_SESSIONS) {
        res.status(503).json({
          error: { code: TOO_MANY_SESSIONS, message: (err as Error).message },
        });
        return;
      }
      res.status(500).json({
        error: {
          code: "SESSION_CREATE_FAILED",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  });

  app.post("/api/chat/:sessionId/message", async (req: Request, res: Response) => {
    const session = manager.get(req.params.sessionId as string);
    if (!session) {
      res.status(404).json({
        error: { code: "SESSION_NOT_FOUND", message: "unknown or closed chat session" },
      });
      return;
    }
    const body = (req.body ?? {}) as {
      message?: unknown;
      page?: unknown;
      images?: unknown;
    };
    if (typeof body.message !== "string" || body.message.trim().length === 0) {
      res.status(400).json({
        error: { code: "EMPTY_MESSAGE", message: "message must be a non-empty string" },
      });
      return;
    }
    const page = body.page as ChatPageContext | undefined;
    // Images ride top-level per the RPC contract (never inside metadata).
    // Shape-checked here so a malformed client cannot smuggle arbitrary
    // fields into the pi prompt command.
    const images = Array.isArray(body.images)
      ? body.images.filter(
          (i): i is ChatImage =>
            typeof i === "object" &&
            i !== null &&
            (i as Record<string, unknown>).type === "image" &&
            typeof (i as Record<string, unknown>).data === "string" &&
            typeof (i as Record<string, unknown>).mimeType === "string",
        )
      : undefined;
    try {
      const out = await session.prompt(
        body.message,
        page ? { page } : undefined,
        images,
      );
      res.json({ accepted: true, commandId: out.commandId });
    } catch (err) {
      res.status(502).json({
        error: {
          code: "PROMPT_FAILED",
          message: err instanceof Error ? err.message : String(err),
        },
      });
    }
  });

  // Best-effort interrupt of the active run (Stop button). Always 200
  // for a live session — even an idle one (there may be nothing to
  // stop, which is fine, not an error). 404 only when unknown/closed.
  app.post("/api/chat/:sessionId/abort", async (req: Request, res: Response) => {
    const session = manager.get(req.params.sessionId as string);
    if (!session) {
      res.status(404).json({
        error: { code: "SESSION_NOT_FOUND", message: "unknown or closed chat session" },
      });
      return;
    }
    await session.abort();
    res.json({ aborted: true });
  });

  app.delete("/api/chat/:sessionId", async (req: Request, res: Response) => {
    const closed = await manager.close(req.params.sessionId as string);
    if (!closed) {
      res.status(404).json({
        error: { code: "SESSION_NOT_FOUND", message: "unknown or closed chat session" },
      });
      return;
    }
    closeChatMcpMount(req.params.sessionId as string);
    res.json({ closed: true });
  });

  app.post("/api/chat/approvals/:approvalId", (req: Request, res: Response) => {
    const pending = approvals.get(req.params.approvalId as string);
    if (!pending) {
      res.status(404).json({
        error: { code: "APPROVAL_NOT_FOUND", message: "unknown or expired approval" },
      });
      return;
    }
    approvals.delete(req.params.approvalId as string);
    const approved = (req.body as { approved?: unknown } | undefined)?.approved === true;
    pending.resolve(approved);
    res.json({ resolved: true, approved });
  });

  app.post("/api/chat/:sessionId/tool-result", (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { requestId?: unknown; payload?: unknown };
    const pending =
      typeof body.requestId === "string" ? domReads.get(body.requestId) : undefined;
    if (!pending || pending.sessionId !== (req.params.sessionId as string)) {
      res.status(404).json({
        error: { code: "REQUEST_NOT_FOUND", message: "unknown or expired tool request" },
      });
      return;
    }
    domReads.delete(body.requestId as string);
    const payload = (body.payload ?? {}) as { text?: unknown; found?: unknown };
    // `found` defaults true: full-page reads always match; only an
    // explicit false (selector miss reported by the overlay) counts as
    // missing. A non-string text degrades to null (unreachable tab).
    pending.resolve(
      typeof payload.text === "string"
        ? { text: payload.text, found: payload.found !== false }
        : null,
    );
    res.json({ received: true });
  });

  mountChatMcp(app, manager, broadcast);
}

/**
 * Ask the session's UI to approve a mutating tool call. Broadcasts the
 * approval card; resolves true on Approve, false on Deny/timeout/close.
 * Fail-closed by construction: an unanswered prompt never runs the tool.
 */
export function requestApproval(
  broadcast: (data: Record<string, unknown>) => void,
  sessionId: string,
  toolName: string,
  argsSummary: string,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const approvalId = randomUUID().replace(/-/g, "").slice(0, 12);
    approvals.set(approvalId, {
      sessionId,
      toolName,
      argsSummary,
      createdAt: Date.now(),
      resolve,
    });
    broadcast({
      type: "agent:approval-request",
      sessionId,
      approvalId,
      toolName,
      argsSummary,
    });
    setTimeout(() => {
      if (approvals.delete(approvalId)) resolve(false);
    }, APPROVAL_TIMEOUT_MS).unref?.();
  });
}

/**
 * Ask the session's browser tab to read the live DOM. Resolves the
 * text plus whether the selector matched, or null when no tab answers
 * in time (closed tab, offline overlay). The `found` flag lets the
 * tool answer a selector miss with deterministic ELEMENT_NOT_FOUND.
 */
export function requestBrowserDom(
  broadcast: (data: Record<string, unknown>) => void,
  sessionId: string,
  selector?: string,
): Promise<{ text: string; found: boolean } | null> {
  return new Promise<{ text: string; found: boolean } | null>((resolve) => {
    const requestId = randomUUID().replace(/-/g, "").slice(0, 12);
    domReads.set(requestId, { sessionId, resolve });
    broadcast({
      type: "agent:tool-request",
      sessionId,
      requestId,
      kind: "read_dom",
      selector: selector ?? null,
    });
    setTimeout(() => {
      if (domReads.delete(requestId)) resolve(null);
    }, DOM_ROUNDTRIP_TIMEOUT_MS).unref?.();
  });
}

function mountChatMcp(
  app: Express,
  manager: ChatSessionManager,
  broadcast: (data: Record<string, unknown>) => void,
): void {
  app.use("/api/chat-mcp/:sessionId", (req: Request, res: Response, next) => {
    res.setHeader("Access-Control-Allow-Origin", "http://localhost:3700");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, mcp-session-id",
    );
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use("/api/chat-mcp/:sessionId", mcpAuth);

  app.all("/api/chat-mcp/:sessionId", async (req: Request, res: Response) => {
    const chatSessionId = req.params.sessionId as string;
    const chatSession = manager.get(chatSessionId);
    if (!chatSession) {
      res.status(404).json({
        error: "unknown or closed chat session — create one via POST /api/chat/sessions",
      });
      return;
    }
    let mount = chatMcpMounts.get(chatSessionId);
    if (!mount) {
      // Same shared factory as the REST paths: one wiring, no drift.
      // projectDir comes from the live session (cwd may differ per chat).
      const hooks = hooksFor(broadcast, chatSession.projectDir);
      mount = {
        server: createChatMcpServer(chatSessionId, hooks),
        transports: new Map(),
        createdAt: Date.now(),
        lastSeen: Date.now(),
      };
      chatMcpMounts.set(chatSessionId, mount);
    }
    mount.lastSeen = Date.now();

    try {
      const mcpSessionId = req.headers["mcp-session-id"] as string | undefined;
      if (req.method === "POST") {
        if (mcpSessionId) {
          const transport = mount.transports.get(mcpSessionId);
          if (!transport) {
            res.status(404).json({ error: "Session not found" });
            return;
          }
          await transport.handleRequest(req, res, req.body);
        } else {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableJsonResponse: true,
          });
          await mount.server.connect(transport);
          await transport.handleRequest(req, res, req.body);
          const newSessionId = transport.sessionId;
          if (!newSessionId) {
            res.status(500).json({ error: "Failed to create session" });
            return;
          }
          mount.transports.set(newSessionId, transport);
        }
      } else if (req.method === "GET") {
        if (!mcpSessionId) {
          res.status(400).json({ error: "Session ID required for GET" });
          return;
        }
        const transport = mount.transports.get(mcpSessionId);
        if (!transport) {
          res.status(404).json({ error: "Session not found" });
          return;
        }
        await transport.handleRequest(req, res, req.body);
      } else if (req.method === "DELETE") {
        if (!mcpSessionId) {
          res.status(400).json({ error: "Session ID required for DELETE" });
          return;
        }
        const transport = mount.transports.get(mcpSessionId);
        if (transport) {
          mount.transports.delete(mcpSessionId);
          await transport.close().catch(() => {});
        }
        res.status(200).json({ closed: true });
      } else {
        res.status(405).json({ error: "Method not allowed" });
      }
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  });
}

function closeChatMcpMount(chatSessionId: string): void {
  const mount = chatMcpMounts.get(chatSessionId);
  if (!mount) return;
  chatMcpMounts.delete(chatSessionId);
  for (const transport of mount.transports.values()) {
    transport.close().catch(() => {});
  }
}

/** Whether the chat surface is registered (ENV gate, default OFF). */
export function chatEnabled(): boolean {
  return isAgentChatEnabled();
}
