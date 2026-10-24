/**
 * Server lifecycle operation pins (ticket 453c7465, P7 server-lifecycle
 * increment).
 *
 * `startServer` and `startMcpTransport` are CLI-only local lifecycle
 * operations (no MCP tools): they bind listeners on this machine and start
 * a stdio transport — never the board, never the network beyond localhost.
 * Driven here in local mode against injected port fakes — never a real
 * listener, transport, or HOME:
 *
 * - api mode (no target) serves the boundary-resolved project directory
 *   and reports `mode: "api"`; prototype mode passes the HTML target
 *   through and never forwards an unrelated project dir (serve() derives
 *   the project from the target path instead);
 * - host/open/dev ride through exactly as passed (`open` defaults to true
 *   like Commander's `--no-open` negation; `dev` rides only when true);
 * - a refused bind (EADDRINUSE, on the error or its cause) is
 *   SERVER_PORT_IN_USE; any other startup failure is SERVER_START_FAILED
 *   carrying the underlying message;
 * - the MCP transport resolves its backend mode through the injected port
 *   (explicit input wins, otherwise the resolver) and starts the injected
 *   runner with exactly `(projectDir, mode)`; a failed start is
 *   MCP_TRANSPORT_START_FAILED.
 *
 * The CLI envelopes over these results (the `✗` line, the suggestion dim,
 * exit 1) stay in the `serve`/`mcp` renderers in src/index.ts, and real
 * listener/transport behaviour stays pinned by the existing
 * serve/serve-startup-cleanup/mcp-stdio suites.
 */
import { describe, it, expect, vi } from "vitest";
import type { OperationContext } from "../../src/core/operations.js";
import {
  startServer,
  startMcpTransport,
} from "../../src/core/operations.js";
import type {
  ServeFn,
  McpRunFn,
} from "../../src/core/operations.js";
import type { ServeInstance } from "../../src/server/server.js";
import type { IntegrationGuide } from "../../src/server/startup-guide.js";

const ctx: OperationContext = { projectDir: "/tmp/p7-server-test", mode: "local" };

function fakeGuide(): IntegrationGuide {
  return { url: "http://localhost:3700" } as unknown as IntegrationGuide;
}

function fakeInstance(overrides: Partial<ServeInstance> = {}): ServeInstance {
  return {
    url: "http://localhost:3700",
    localUrl: null,
    guide: fakeGuide(),
    close: async () => {},
    ...overrides,
  };
}

describe("startServer", () => {
  it("serves the boundary-resolved root in api mode and reports it", async () => {
    const serve = vi.fn<ServeFn>(async () => fakeInstance());
    const result = await startServer(ctx, { port: 3700, serve });
    expect(result.ok).toBe(true);
    expect(serve).toHaveBeenCalledTimes(1);
    expect(serve.mock.calls[0][0]).toBeUndefined();
    expect(serve.mock.calls[0][1]).toEqual({
      port: 3700,
      open: true,
      projectDir: "/tmp/p7-server-test",
    });
    expect(result).toEqual({
      ok: true,
      data: {
        mode: "api",
        url: "http://localhost:3700",
        localUrl: null,
        guide: fakeGuide(),
      },
    });
  });

  it("passes the HTML target through in prototype mode without a project dir", async () => {
    const serve = vi.fn<ServeFn>(async () => fakeInstance());
    const result = await startServer(ctx, {
      target: "demo.html",
      port: 3701,
      serve,
    });
    expect(result.ok).toBe(true);
    expect(serve.mock.calls[0][0]).toBe("demo.html");
    expect(serve.mock.calls[0][1]).toEqual({ port: 3701, open: true });
    expect(result.ok && result.data.mode).toBe("prototype");
  });

  it("passes host, no-open, dev and an explicit project dir through", async () => {
    const serve = vi.fn<ServeFn>(async () =>
      fakeInstance({ localUrl: "http://localhost:9999" }),
    );
    const result = await startServer(ctx, {
      port: 9999,
      host: "0.0.0.0",
      open: false,
      dev: true,
      projectDir: "/tmp/p7-explicit",
      serve,
    });
    expect(serve.mock.calls[0][1]).toEqual({
      port: 9999,
      host: "0.0.0.0",
      open: false,
      projectDir: "/tmp/p7-explicit",
      dev: true,
    });
    expect(result.ok && result.data.localUrl).toBe("http://localhost:9999");
  });

  it("maps a refused bind to SERVER_PORT_IN_USE", async () => {
    const refused = Object.assign(new Error("listen EADDRINUSE"), {
      code: "EADDRINUSE",
    });
    const withCause = Object.assign(new Error("wrapped"), {
      cause: { code: "EADDRINUSE" },
    });
    for (const failure of [refused, withCause]) {
      const serve = vi.fn<ServeFn>(async () => {
        throw failure;
      });
      const result = await startServer(ctx, { port: 3700, serve });
      expect(result).toEqual({
        ok: false,
        error: {
          code: "SERVER_PORT_IN_USE",
          message: "Port 3700 is already in use, so the server could not start.",
          suggestion:
            "Pass a different --port, or stop whatever is listening on that port.",
        },
      });
    }
  });

  it("maps any other startup failure to SERVER_START_FAILED with its message", async () => {
    const serve = vi.fn<ServeFn>(async () => {
      throw new Error("No HTML files found at empty-dir");
    });
    const result = await startServer(ctx, {
      target: "empty-dir",
      port: 3700,
      serve,
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "SERVER_START_FAILED",
        message: "No HTML files found at empty-dir",
        suggestion:
          "Check the target path and port, then run the serve command again.",
      },
    });
  });
});

describe("startMcpTransport", () => {
  it("starts the transport with the pinned root and explicit mode", async () => {
    const run = vi.fn<McpRunFn>(async () => {});
    const result = await startMcpTransport(ctx, { mode: "saas", run });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("/tmp/p7-server-test", "saas");
    expect(result).toEqual({
      ok: true,
      data: { projectDir: "/tmp/p7-server-test", mode: "saas" },
    });
  });

  it("resolves the mode through the injected port when omitted", async () => {
    const run = vi.fn<McpRunFn>(async () => {});
    const resolveMode = vi.fn(async () => "local" as const);
    const result = await startMcpTransport(ctx, { resolveMode, run });
    expect(resolveMode).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("/tmp/p7-server-test", "local");
    expect(result).toEqual({
      ok: true,
      data: { projectDir: "/tmp/p7-server-test", mode: "local" },
    });
  });

  it("maps a failed start to MCP_TRANSPORT_START_FAILED", async () => {
    const run = vi.fn<McpRunFn>(async () => {
      throw new Error("transport closed");
    });
    const result = await startMcpTransport(ctx, { mode: "local", run });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "MCP_TRANSPORT_START_FAILED",
        message: "transport closed",
        suggestion:
          "Check the project directory is a Vibeflow project, then run the mcp command again.",
      },
    });
  });
});
