/**
 * MCP HTTP Transport
 *
 * Mounts the MCP server on Express at POST|GET|DELETE /api/mcp.
 * Uses StreamableHTTPServerTransport with per-session McpServer instances.
 * enableJsonResponse: true for read-mostly workload.
 */
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Express, Request, Response } from "express";
import { createMcpServer } from "./server.js";
import { mcpAuth } from "./auth.js";
import crypto from "node:crypto";

// ── Session Management ─────────────────────────────────────────────────────

interface McpSession {
  server: ReturnType<typeof createMcpServer>;
  transport: StreamableHTTPServerTransport;
  createdAt: number;
}

const sessions = new Map<string, McpSession>();
const SESSION_TTL = 30 * 60 * 1000; // 30 minutes

let reaper: NodeJS.Timeout | null = null;
let handlersRegistered = false;

function reapStaleSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL) {
      session.transport.close().catch(() => {});
      sessions.delete(id);
    }
  }
}

function startSessionReaper(): void {
  if (reaper) return;
  reaper = setInterval(reapStaleSessions, 5 * 60 * 1000);
  // Do not keep one-shot CLI processes alive.
  reaper.unref();
}

// ── Express Mount ──────────────────────────────────────────────────────────

export function mountMcp(
  app: Express,
  projectDir: string,
  mode: "local" | "saas" = "local",
): void {
  // Start the session reaper if not already running.
  // This must be lazy (not module-scope) to avoid hanging one-shot CLI commands.
  startSessionReaper();

  // CORS exemption for /api/mcp (prevent credential leakage)
  app.use("/api/mcp", (req: Request, res: Response, next) => {
    // Do not reflect Origin header for MCP endpoint
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

  // Auth middleware
  app.use("/api/mcp", mcpAuth);

  // Handle MCP requests
  app.all("/api/mcp", async (req: Request, res: Response) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (req.method === "POST") {
        if (sessionId) {
          // Existing session
          const session = sessions.get(sessionId);
          if (!session) {
            res.status(404).json({ error: "Session not found" });
            return;
          }
          await session.transport.handleRequest(req, res);
        } else {
          // Initialize new session
          const server = createMcpServer(projectDir, mode);
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            enableJsonResponse: true,
          });

          await server.connect(transport);
          const newSessionId = transport.sessionId;
          if (!newSessionId) {
            res.status(500).json({ error: "Failed to create session" });
            return;
          }

          sessions.set(newSessionId, {
            server,
            transport,
            createdAt: Date.now(),
          });

          // Handle the initialization request
          await transport.handleRequest(req, res);
        }
      } else if (req.method === "GET") {
        // SSE stream for notifications
        if (!sessionId) {
          res.status(400).json({ error: "Session ID required for GET" });
          return;
        }
        const session = sessions.get(sessionId);
        if (!session) {
          res.status(404).json({ error: "Session not found" });
          return;
        }
        await session.transport.handleRequest(req, res);
      } else if (req.method === "DELETE") {
        // Close session
        if (!sessionId) {
          res.status(400).json({ error: "Session ID required for DELETE" });
          return;
        }
        const session = sessions.get(sessionId);
        if (session) {
          await session.transport.close();
          sessions.delete(sessionId);
        }
        res.status(200).json({ ok: true });
      }
    } catch (err) {
      console.error("[MCP] Request error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          error: "Internal server error",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }
    }
  });

  // Cleanup on server shutdown (only register once).
  if (!handlersRegistered) {
    handlersRegistered = true;
    process.on("SIGTERM", async () => {
      for (const [, session] of sessions) {
        await session.transport.close().catch(() => {});
      }
      sessions.clear();
      if (reaper) {
        clearInterval(reaper);
        reaper = null;
      }
    });
    process.on("SIGINT", async () => {
      for (const [, session] of sessions) {
        await session.transport.close().catch(() => {});
      }
      sessions.clear();
      if (reaper) {
        clearInterval(reaper);
        reaper = null;
      }
    });
  }
}

// ── Exports for testing ────────────────────────────────────────────────────

export function getSessionCount(): number {
  return sessions.size;
}

export function clearSessions(): void {
  sessions.clear();
}

/** Teardown for tests — clears the reaper interval and all sessions. */
export function stopMcpForTests(): void {
  if (reaper) {
    clearInterval(reaper);
    reaper = null;
  }
  sessions.clear();
  handlersRegistered = false;
}
