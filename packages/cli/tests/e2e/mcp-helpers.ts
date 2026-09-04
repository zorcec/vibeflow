/**
 * Shared helpers for MCP e2e tests.
 *
 * Boot: in-process API-only server (MCP is mounted only in API-only mode
 * via serveApiOnly → mountMcp). _testToken:null/_testWorkspace:null
 * force OFFLINE mode deterministically — without them the server reads
 * the real ~/.vibeflow/token and silently boots in SaaS mode (MCP not mounted).
 *
 * McpClient: fetch-based JSON-RPC over HTTP — initialize → session header →
 * notifications/initialized → listTools/callTool.
 *
 * Cleanup: instance.close() + rmSync temp dirs + stopMcpForTests() (clears
 * module-scope sessions Map + reaper interval in mcp/http.ts).
 */

import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { expect } from "vitest";

// Suppress telemetry in every test process
process.env.VIBEFLOW_TELEMETRY = "0";

const { serve } = await import("../../src/server/server.js");
const { stopMcpForTests, getSessionCount } = await import(
  "../../src/mcp/http.js"
);
type ServeInstance = Awaited<ReturnType<typeof serve>>;

// ── Port allocation ──────────────────────────────────────────────────────────

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

// ── MCP server boot ──────────────────────────────────────────────────────────

export interface McpTestEnv {
  instance: ServeInstance;
  baseUrl: string;
  mcpUrl: string;
  projectDir: string;
  cleanup: () => Promise<void>;
}

export async function bootMcpServer(projectDir?: string): Promise<McpTestEnv> {
  const dir = projectDir ?? mkdtempSync(join(tmpdir(), "mcp-e2e-"));
  const port = await getFreePort();
  const instance = await (serve as any)(undefined, {
    port,
    open: false,
    projectDir: dir,
    // @internal test hooks — force OFFLINE mode deterministically
    _testToken: null,
    _testWorkspace: null,
  });
  return {
    instance,
    projectDir: dir,
    baseUrl: instance.url,
    mcpUrl: instance.url + "/api/mcp",
    async cleanup() {
      await instance.close();
      rmSync(dir, { recursive: true, force: true });
      stopMcpForTests();
    },
  };
}

// ── MCP client ───────────────────────────────────────────────────────────────

export const PROTOCOL_VERSION = "2025-06-18";

export function jsonRpcBody(
  id: number | null,
  method: string,
  params?: unknown,
): unknown {
  const body: Record<string, unknown> = { jsonrpc: "2.0", id, method };
  if (params !== undefined) body.params = params;
  return body;
}

export interface McpClient {
  mcpUrl: string;
  token?: string;
  sessionId?: string;
  nextId: number;
}

async function mcpFetch(
  c: McpClient,
  body: unknown,
  init: RequestInit = {},
): Promise<Response> {
  // Allowlist: only localhost URLs — all test clients use bootMcpServer/spawnApiServer
  const url = new URL(c.mcpUrl);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error(`SSRF blocked: ${c.mcpUrl} is not a localhost URL`);
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (c.token) headers.Authorization = `Bearer ${c.token}`;
  if (c.sessionId) headers["mcp-session-id"] = c.sessionId;
  return fetch(c.mcpUrl, {
    ...init,
    method: init.method ?? "POST",
    headers: { ...headers, ...(init.headers as Record<string, string>) },
    body: init.body ?? JSON.stringify(body),
  });
}

export async function initialize(
  c: McpClient,
  protocolVersion = PROTOCOL_VERSION,
): Promise<Response> {
  const res = await mcpFetch(
    c,
    jsonRpcBody(1, "initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "mcp-e2e-client", version: "0.0.0" },
    }),
  );
  if (res.ok) {
    c.sessionId = res.headers.get("mcp-session-id") ?? undefined;
    // Step 2: send initialized notification (JSON-RPC notification: NO id field)
    const res2 = await mcpFetch(c, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    if (res2.status !== 202)
      throw new Error(`notifications/initialized returned ${res2.status}`);
  }
  return res;
}

export async function listTools(c: McpClient): Promise<Response> {
  return mcpFetch(c, jsonRpcBody(++c.nextId, "tools/list", {}));
}

export async function callTool(
  c: McpClient,
  name: string,
  args: Record<string, unknown>,
): Promise<Response> {
  return mcpFetch(
    c,
    jsonRpcBody(++c.nextId, "tools/call", { name, arguments: args }),
  );
}

/** Assert the TextContent contract: HTTP 200, content[0].text is a string that parses as JSON. */
export async function assertJsonTextContent(res: Response): Promise<any> {
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.error).toBeUndefined();
  const text = body.result?.content?.[0]?.text;
  expect(typeof text).toBe("string");
  expect(() => JSON.parse(text as string)).not.toThrow();
  return JSON.parse(text as string);
}

export function newClient(mcpUrl: string, token?: string): McpClient {
  return { mcpUrl, token, nextId: 1 };
}

// ── Exported re-exports ──────────────────────────────────────────────────────

export { stopMcpForTests, getSessionCount };

// ── HOME-isolated spawn helpers ──────────────────────────────────────────────

const CLI_PATH = join(process.cwd(), "dist", "index.js");

export function isolatedEnv(tmpHome: string): NodeJS.ProcessEnv {
  return { ...process.env, HOME: tmpHome, VIBEFLOW_TELEMETRY: "0" };
}

export async function runCli(
  args: string[],
  opts: { cwd: string; home: string; timeoutMs?: number },
): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  signal: string | null;
  elapsedMs: number;
}> {
  const start = Date.now();
  return new Promise((resolve) => {
    execFile(
      "node",
      [CLI_PATH, ...args],
      {
        cwd: opts.cwd,
        encoding: "utf-8",
        timeout: opts.timeoutMs ?? 15_000,
        env: isolatedEnv(opts.home),
      },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as any).code === "number"
            ? (err as any).code
            : err
              ? 1
              : 0;
        resolve({
          stdout,
          stderr,
          code,
          signal: null,
          elapsedMs: Date.now() - start,
        });
      },
    );
  });
}

export function spawnApiServer(opts: {
  cwd: string;
  home: string;
  port: number;
}): { child: ChildProcess; mcpUrl: string; waitReady: Promise<void> } {
  const child = spawn(
    "node",
    [CLI_PATH, "serve", "--no-open", "-p", String(opts.port)],
    {
      cwd: opts.cwd,
      env: isolatedEnv(opts.home),
    },
  );
  const mcpUrl = `http://127.0.0.1:${opts.port}/api/mcp`;
  const waitReady = new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const poll = async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${opts.port}/api/tasks`);
        if (res.ok || res.status < 500) {
          resolve();
          return;
        }
      } catch {
        // not ready yet
      }
      if (Date.now() - start > 10_000) {
        reject(new Error("spawnApiServer timed out"));
        return;
      }
      setTimeout(poll, 200);
    };
    poll();
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== null && code !== 0)
        reject(new Error(`spawnApiServer exited ${code}`));
    });
  });
  return { child, mcpUrl, waitReady };
}

// ── Seed helpers ─────────────────────────────────────────────────────────────

export function ensureTaskDirs(projectDir: string): void {
  mkdirSync(join(projectDir, ".vibeflow", "tasks"), { recursive: true });
  mkdirSync(join(projectDir, ".vibeflow", "tasks", "files"), {
    recursive: true,
  });
}

export function seedTask(
  projectDir: string,
  task: {
    id: string;
    title: string;
    status: string;
    priority?: string;
    type?: string;
    created?: string;
    description?: string;
    tags?: string[];
  },
): void {
  ensureTaskDirs(projectDir);
  const data = {
    id: task.id,
    title: task.title,
    description: task.description ?? "",
    status: task.status,
    priority: task.priority ?? "Medium",
    type: task.type ?? "Task",
    created: task.created ?? new Date().toISOString(),
    tags: task.tags ?? [],
    comments: [],
    files: [],
  };
  writeFileSync(
    join(projectDir, ".vibeflow", "tasks", `${task.id}.json`),
    JSON.stringify(data, null, 2),
  );
}

export function seedGitUser(projectDir: string): void {
  const { execSync } = require("node:child_process");
  execSync(
    "git init && git config user.name 'E2E User' && git config user.email 'e2e@test.local'",
    {
      cwd: projectDir,
      stdio: "ignore",
    },
  );
}

export type { expect };
