/**
 * W4 stdio e2e — an oversized inbound frame must be ANSWERED, never fatal
 * (ticket eb77a4df297eb443f3839ce4876939).
 *
 * What broke before: the SDK's `ReadBuffer` clears its buffer and THROWS when
 * one frame exceeds its limit, `StdioServerTransport._ondata` answers that
 * throw by closing, and `runStdioMcp`'s onclose then exits the process. The
 * server died with exit 0, wrote no frame and nothing to stderr, and the
 * client waited forever for a response that could never come — the "vibeflow
 * MCP tools always get stuck" symptom this ticket was filed for.
 *
 * Two frames are driven through a REAL spawned `cli mcp` process:
 *   1. just over the old 10 MB SDK default → must still be SERVED (the cap
 *      moved up, so a large `attach_file` payload is not fatal);
 *   2. over MAX_INBOUND_FRAME_BYTES → must be REFUSED with a JSON-RPC error
 *      naming the cap, with the server alive and still answering afterwards.
 *
 * Both assertions go red on the pre-fix build: the process exits 0 mid-frame
 * and the pending request is rejected with "server exited before responding".
 *
 * HOME is isolated and no raw env spread is used (ticket 8ac96ef9) — the
 * spawn flows through the `spawn-isolated.ts` chokepoint like every other
 * CLI spawn in this suite.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CLI_ENTRY as CLI, isolatedCliEnv } from "./spawn-isolated.js";

/**
 * Pinned mirror of `MAX_INBOUND_FRAME_BYTES` in `src/mcp/stdio.ts` — stated
 * as a literal rather than imported so the pre-fix build (which has no such
 * constant) still collects the spec and fails BEHAVIOURALLY: on a reverted
 * fix the server exits 0 mid-frame and the request is rejected with
 * "server exited before responding". A future cap change must edit both.
 */
const CAP_BYTES = 16 * 1024 * 1024;

/** How long one JSON-RPC exchange may take before the test calls it a hang. */
const RESPONSE_DEADLINE_MS = 20_000;

interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface Pending {
  resolve: (message: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface Session {
  /** Send a request (id assigned here) and resolve with its response. */
  request: (message: Record<string, unknown>) => Promise<any>;
  /** Write a pre-built frame under an id this session will await. */
  sendRaw: (id: number, frame: string) => Promise<any>;
  /** Fire-and-forget notification (no id, no response expected). */
  notify: (message: Record<string, unknown>) => void;
  /** Exit info once the child closed; null while the server is alive. */
  exitInfo: () => ExitInfo | null;
  close: () => void;
}

const openSessions: Session[] = [];

afterEach(() => {
  for (const session of openSessions.splice(0)) session.close();
});

/**
 * Spawn `cli mcp --project <tmp>` over real stdio and speak raw JSON-RPC to
 * it. A response resolves the pending request; a server that dies (or simply
 * never answers) rejects instead of leaving the test hanging.
 */
async function openSession(): Promise<Session> {
  const projectDir = mkdtempSync(join(tmpdir(), "mcp-oversize-proj-"));
  mkdirSync(join(projectDir, ".vibeflow"), { recursive: true });
  const home = mkdtempSync(join(tmpdir(), "mcp-oversize-home-"));

  const child: ChildProcess = spawn(
    process.execPath,
    [CLI, "mcp", "--project", projectDir],
    {
      cwd: projectDir,
      env: isolatedCliEnv({ home, cwd: projectDir }),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let buffer = "";
  let exitInfo: ExitInfo | null = null;
  const pending = new Map<number, Pending>();

  const failPending = (error: Error) => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  };

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        continue; // non-frame stdout is asserted by mcp-stdio.test.ts
      }
      if (typeof message.id === "number" && pending.has(message.id)) {
        const waiter = pending.get(message.id)!;
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
      }
    }
  });
  child.on("exit", (code, signal) => {
    exitInfo = { code, signal };
    failPending(
      new Error(`server exited (code=${code}, signal=${signal}) before responding`),
    );
  });
  child.stdin?.on("error", () => {
    /* EPIPE once the server is gone — the exit handler reports it */
  });

  let nextId = 0;
  const write = (frame: string) => {
    child.stdin?.write(frame);
  };
  const sendRaw = (id: number, frame: string) =>
    new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`no response to frame id ${id} within ${RESPONSE_DEADLINE_MS}ms`));
      }, RESPONSE_DEADLINE_MS);
      pending.set(id, { resolve, reject, timer });
      write(frame);
    });
  const request = (message: Record<string, unknown>) => {
    const id = ++nextId;
    return sendRaw(id, `${JSON.stringify({ jsonrpc: "2.0", id, ...message })}\n`);
  };
  const notify = (message: Record<string, unknown>) => {
    write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };

  const session: Session = {
    request,
    sendRaw,
    notify,
    exitInfo: () => exitInfo,
    close: () => {
      child.kill("SIGKILL");
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
  openSessions.push(session);

  await request({
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "mcp-oversize-e2e", version: "0.0.0" },
    },
  });
  notify({ method: "notifications/initialized" });
  return session;
}

/** A `tools/call` frame of roughly `payloadBytes` plus JSON-RPC framing. */
function oversizedCallFrame(id: number, payloadBytes: number): string {
  return `${JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: "list_tasks",
      arguments: { oversized: "x".repeat(payloadBytes) },
    },
  })}\n`;
}

describe("MCP stdio oversized inbound frame", () => {
  it("1: a frame over the old 10 MB SDK default is still served, not fatal", async () => {
    const session = await openSession();
    // 11 MB: over the SDK's own 10 MB ReadBuffer default, well under our cap.
    // The tool's schema refuses the unknown field — but a refusal is a REPLY.
    // Pre-fix this frame killed the server and produced no reply at all.
    const response = await session.sendRaw(
      900,
      oversizedCallFrame(900, 11 * 1024 * 1024),
    );
    expect(response.result).toBeDefined();
    expect(session.exitInfo()).toBeNull();

    const list = await session.request({ method: "tools/list", params: {} });
    expect(list.result.tools.length).toBeGreaterThan(0);
  });

  it("2: a frame over the cap is answered with a JSON-RPC error and the server keeps serving", async () => {
    const session = await openSession();
    // One byte of payload past the cap once the JSON-RPC framing is added —
    // pre-fix the SDK closed the transport here and the process exited 0.
    const refusal = await session.sendRaw(
      901,
      oversizedCallFrame(901, CAP_BYTES),
    );
    expect(refusal.error).toBeDefined();
    expect(String(refusal.error.message)).toContain(String(CAP_BYTES));
    expect(session.exitInfo()).toBeNull();

    // The session is not a zombie: the next exchange must still be served.
    const list = await session.request({ method: "tools/list", params: {} });
    expect(list.result.tools.length).toBeGreaterThan(0);
    expect(session.exitInfo()).toBeNull();
  });
});
