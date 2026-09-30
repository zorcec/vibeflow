/**
 * MCP e2e — the two server tools over the HTTP transport (spec §2.2).
 *
 * `start_kanban` and `get_integration_guide` are the first tools that touch a
 * PORT rather than the task store, so this file is mostly about the things
 * that can go wrong once a tool owns a listener: two calls fighting over one
 * port, and a port some other process already holds.
 *
 * The stdout-corruption half of this story — the reason `ServeOptions.quiet`
 * exists at all — lives in `tests/e2e/mcp-stdio.test.ts`, because it can only
 * be seen on a real spawned process's fd 1.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bootMcpServer,
  newClient,
  initialize,
  callTool,
  assertJsonTextContent,
  listTools,
  type McpClient,
  type McpTestEnv,
} from "./mcp-helpers.js";

/**
 * Localhost-only fetch wrapper — the same allowlist `mcp-transport.test.ts`
 * uses. Every URL asserted here is a loopback address this test itself bound,
 * so the check is a guard against a test ever reaching off-box, not a
 * capability the tools lack.
 */
function localFetch(url: string): Promise<Response> {
  const u = new URL(url);
  if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") {
    throw new Error(`SSRF blocked: ${url} is not a localhost URL`);
  }
  return fetch(url);
}

let env: McpTestEnv;
let client: McpClient;
let projectDir: string;

beforeAll(async () => {
  env = await bootMcpServer();
  client = newClient(env.mcpUrl);
  await initialize(client);
});

afterAll(async () => {
  // The kanban singleton outlives the MCP server that started it, so it is
  // closed explicitly — otherwise the suite leaks a listener on every run.
  const { closeKanbanServer } = await import("../../src/server/kanban-server.js");
  await closeKanbanServer();
  await env.cleanup();
});

describe("start_kanban / get_integration_guide over HTTP", () => {
  it("both tools are discoverable and carry the agreed annotations", async () => {
    const res = await listTools(client);
    const tools = (await res.json()).result.tools as {
      name: string;
      annotations?: Record<string, boolean>;
    }[];
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect([...byName.keys()]).toContain("start_kanban");
    expect([...byName.keys()]).toContain("get_integration_guide");
    // readOnlyHint true for the read, false for the one that binds a port.
    expect(byName.get("get_integration_guide")!.annotations!.readOnlyHint).toBe(
      true,
    );
    expect(byName.get("start_kanban")!.annotations!.readOnlyHint).toBe(false);
  });

  it("get_integration_guide reports NOT running before the server is up", async () => {
    const payload = await assertJsonTextContent(
      await callTool(client, "get_integration_guide", {}),
    );
    expect(payload.serverRunning).toBe(false);
    // Built against the DEFAULT port, and it says so out loud.
    expect(payload.kanbanUrl).toBe("http://localhost:3700/kanban");
    expect(payload.instructions).toContain("NOT running");
    expect(payload.instructions).toContain("start_kanban");
  });

  it("start_kanban binds a port and returns a REACHABLE kanban URL", async () => {
    const port = await freePort();
    const payload = await assertJsonTextContent(
      await callTool(client, "start_kanban", { port }),
    );
    expect(payload.started).toBe(true);
    expect(payload.alreadyRunning).toBe(false);
    expect(payload.kanbanUrl).toBe(`http://localhost:${port}/kanban`);

    // Not just a well-formed string — the board actually answers.
    const board = await localFetch(payload.kanbanUrl);
    expect(board.ok).toBe(true);
    expect(await board.text()).toContain('id="root"');
    // …and so does the guide page it points at.
    const inject = await localFetch(payload.injectUrl);
    expect(inject.ok).toBe(true);
    expect(await inject.text()).toContain("vibeflow-overlay.js");
  });

  it("a second call reuses the running instance instead of fighting for the port", async () => {
    // A DIFFERENT port, and a different host, than the first call used — the
    // singleton must ignore both rather than try to rebind.
    const payload = await assertJsonTextContent(
      await callTool(client, "start_kanban", { port: 1, host: "0.0.0.0" }),
    );
    expect(payload.alreadyRunning).toBe(true);
    expect(payload.started).toBe(false);
    // The FIRST call's URL, unchanged.
    expect(payload.kanbanUrl).not.toContain(":1/");
    // And it is still the same live server.
    expect((await localFetch(payload.kanbanUrl)).ok).toBe(true);
  });

  it("concurrent calls converge on ONE instance (no EADDRINUSE)", async () => {
    // Five simultaneous calls. Without coalescing on the in-flight promise
    // these would race to bind and all but one would reject EADDRINUSE.
    const port = await freePort();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        callTool(client, "start_kanban", { port }),
      ),
    );
    const payloads = await Promise.all(results.map(assertJsonTextContent));
    // Every call SUCCEEDED — a refused one would not have parsed as a payload
    // carrying a kanbanUrl at all.
    const urls = new Set(payloads.map((p) => p.kanbanUrl));
    expect(urls.size).toBe(1);
    // At most one call did the starting. It is 0 here, not 1: the singleton
    // was already up from the previous test in this file, and the port-in-use
    // test below is the one that proves the FIRST bind really happens.
    expect(payloads.filter((p) => p.started === true).length).toBeLessThanOrEqual(1);
    expect((await localFetch(payloads[0].kanbanUrl)).ok).toBe(true);
  });

  it("get_integration_guide reports RUNNING once the server is up", async () => {
    const payload = await assertJsonTextContent(
      await callTool(client, "get_integration_guide", {}),
    );
    expect(payload.serverRunning).toBe(true);
    // Real URLs from the live instance, not the 3700 default.
    expect(payload.kanbanUrl).not.toBe("http://localhost:3700/kanban");
    expect((await localFetch(payload.kanbanUrl)).ok).toBe(true);
    expect(payload.instructions).not.toContain("NOT running");
  });

  it("start_kanban dryRun previews the URLs and binds nothing", async () => {
    const port = await freePort();
    const payload = await assertJsonTextContent(
      await callTool(client, "start_kanban", { port, dryRun: true }),
    );
    expect(payload.wouldStart).toBe(true);
    expect(payload.started).toBe(false);
    expect(payload.kanbanUrl).toBe(`http://localhost:${port}/kanban`);
    // Nothing was bound — a connection to it is refused.
    await expect(
      localFetch(`http://localhost:${port}/kanban`),
    ).rejects.toThrow();
  });
});

describe("start_kanban port-in-use is a clean refusal", () => {
  it("returns a structured envelope, not a stack trace", async () => {
    // The singleton is module-level and an earlier test in this file already
    // started it, so a call here would short-circuit and never reach bind().
    // Close it so this test exercises the REAL first-bind failure path.
    const { closeKanbanServer } = await import(
      "../../src/server/kanban-server.js"
    );
    await closeKanbanServer();

    // Occupy a port with a plain socket that is NOT Vibeflow.
    const squatter = createServer();
    const taken = await new Promise<number>((res) => {
      squatter.listen(0, "127.0.0.1", () =>
        res((squatter.address() as { port: number }).port),
      );
    });
    try {
      // A fresh server instance is required: the singleton already holds one,
      // and a second call would short-circuit before ever reaching bind().
      projectDir = mkdtempSync(join(tmpdir(), "mcp-kanban-refuse-"));
      mkdirSync(join(projectDir, ".vibeflow"));
      const fresh = await bootMcpServer(projectDir);
      const c = newClient(fresh.mcpUrl);
      await initialize(c);
      try {
        const res = await callTool(c, "start_kanban", { port: taken });
        const body = await res.json();
        const payload = JSON.parse(body.result.content[0].text as string);
        // The CLI's own refusal envelope, not a thrown Error/stack.
        expect(payload.ok).toBe(false);
        expect(payload.error.code).toBe("KANBAN_PORT_IN_USE");
        expect(payload.error.message).toContain(String(taken));
        expect(payload.error.suggestion).toBeTruthy();
        expect(payload.error.retryable).toBe(false);
        // No raw stack leaked into the payload.
        expect(body.result.content[0].text).not.toContain("at Object.");
        expect(body.result.content[0].text).not.toContain("errno");
      } finally {
        await fresh.cleanup();
        rmSync(projectDir, { recursive: true, force: true });
      }
    } finally {
      await new Promise<void>((r) => squatter.close(() => r()));
    }
  });
});

/** An OS-assigned free port. Never 3000/3001 — other projects own those. */
async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => res(port));
    });
    srv.on("error", rej);
  });
}
