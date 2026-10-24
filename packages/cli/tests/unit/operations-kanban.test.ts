/**
 * Kanban lifecycle operation pins (ticket 453c7465, P7 kanban increment).
 *
 * `startKanban` is the one shared implementation behind `vibeflow kanban`
 * and the `start_kanban` MCP tool. Driven here in local mode against injected
 * port fakes — never a real listener — plus the real singleton behind a
 * mocked `serve()` (no socket ever binds):
 *
 * - the operation forwards port/host/dev/quiet/noCtrlCHint plus the
 *   boundary-resolved project directory to the `start` port exactly as
 *   passed (dev/quiet/noCtrlCHint ride ONLY when set — the MCP path omits
 *   them and inherits the singleton's quiet default; an absent dev is absent,
 *   never `false`);
 * - the dry-run preview binds nothing and resolves through the same URL rule
 *   the real serve() uses, so it names the same URLs the live call will;
 * - a second start is coalesced per current behaviour: `started: false`
 *   maps to `alreadyRunning: true` and the payload keeps the FIRST
 *   instance's URLs even when the second call names another port/host/dev;
 * - a refused bind (EADDRINUSE, on the error or its cause) is
 *   KANBAN_PORT_IN_USE naming the port; any other startup failure is
 *   KANBAN_START_FAILED carrying the underlying message;
 * - the singleton forwards dev/quiet/noCtrlCHint to serve() (open stays
 *   false always — the CLI renderer owns the single `open()` call, so the
 *   operation path is browser-free by construction) and a second call while
 *   an instance lives reuses it without a second serve() call, ignoring
 *   every option including dev.
 *
 * The CLI envelopes over these results (the `✗` line, the suggestion dim,
 * exit 1) stay in the `kanban` renderer in src/index.ts, and real
 * listener behaviour stays pinned by the existing
 * serve/mcp-kanban-tools suites.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import type { OperationContext } from "../../src/core/operations.js";
import { startKanban } from "../../src/core/operations.js";
import type { StartKanbanPorts } from "../../src/core/operations/kanban.js";
import type { ServeInstance } from "../../src/server/server.js";
import type { IntegrationGuide } from "../../src/server/startup-guide.js";
import type { KanbanStartOptions } from "../../src/server/kanban-server.js";

const serveSpy = vi.hoisted(() => vi.fn());

vi.mock("../../src/server/server.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/server/server.js")>();
  return {
    ...actual,
    serve: serveSpy,
  };
});

const ctx: OperationContext = { projectDir: "/tmp/p7-kanban-test", mode: "local" };

function fakeGuide(url = "http://localhost:3700"): IntegrationGuide {
  return {
    url,
    localUrl: null,
    kanbanUrl: `${url}/kanban`,
    taskApiUrl: `${url}/api/tasks`,
    injectUrl: `${url}/inject`,
    overlayScriptUrl: `${url}/vibeflow-overlay.js`,
  } as unknown as IntegrationGuide;
}

function fakeInstance(url = "http://localhost:3700"): ServeInstance {
  return {
    url,
    localUrl: null,
    guide: fakeGuide(url),
    close: async () => {},
  };
}

function fakePorts(
  onStart?: (options: KanbanStartOptions) => void,
): StartKanbanPorts {
  return {
    start: async (options: KanbanStartOptions) => {
      onStart?.(options);
      return { instance: fakeInstance(), started: true };
    },
    buildGuide: (urls: { url: string; localUrl: string | null }) =>
      fakeGuide(urls.url),
    resolveUrls: (host: string, port: number) => ({
      url: `http://${host}:${port}`,
      localUrl: null,
    }),
    guideText: () => "instructions",
  };
}

describe("startKanban operation", () => {
  it("forwards port, host, dev, quiet and noCtrlCHint plus the project dir to the start port", async () => {
    const seen: KanbanStartOptions[] = [];
    const result = await startKanban(
      ctx,
      {
        port: 9999,
        host: "0.0.0.0",
        dev: true,
        quiet: false,
        noCtrlCHint: true,
        dryRun: false,
      },
      fakePorts((options) => seen.push(options)),
    );
    expect(seen).toEqual([
      {
        projectDir: "/tmp/p7-kanban-test",
        port: 9999,
        host: "0.0.0.0",
        dev: true,
        quiet: false,
        noCtrlCHint: true,
      },
    ]);
    expect(result.ok).toBe(true);
    expect(result.ok && result.data).toMatchObject({
      alreadyRunning: false,
      started: true,
      url: "http://localhost:3700",
      kanbanUrl: "http://localhost:3700/kanban",
      instructions: "instructions",
    });
  });

  it("omits dev/quiet/noCtrlCHint when unset so the singleton defaults apply (MCP path)", async () => {
    const seen: KanbanStartOptions[] = [];
    const result = await startKanban(
      ctx,
      { port: 3700 },
      fakePorts((options) => seen.push(options)),
    );
    // Absent, never `false`: the singleton's own quiet default (MCP-safe)
    // and production bundle apply.
    expect(seen).toEqual([{ projectDir: "/tmp/p7-kanban-test", port: 3700 }]);
    expect(seen[0]).not.toHaveProperty("dev");
    expect(seen[0]).not.toHaveProperty("quiet");
    expect(seen[0]).not.toHaveProperty("noCtrlCHint");
    expect(result.ok).toBe(true);
  });

  it("dryRun previews the URLs through the shared URL rule and binds nothing", async () => {
    const start = vi.fn();
    const result = await startKanban(
      ctx,
      { port: 4123, host: "127.0.0.1", dryRun: true },
      { ...fakePorts(), start },
    );
    expect(start).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: true,
      data: {
        alreadyRunning: false,
        started: false,
        wouldStart: true,
        url: "http://127.0.0.1:4123",
        localUrl: null,
        kanbanUrl: "http://127.0.0.1:4123/kanban",
        taskApiUrl: "http://127.0.0.1:4123/api/tasks",
        overlayScriptUrl: "http://127.0.0.1:4123/vibeflow-overlay.js",
        injectUrl: "http://127.0.0.1:4123/inject",
        guide: fakeGuide("http://127.0.0.1:4123"),
        instructions: "instructions",
      },
      steps: [
        {
          code: "DRY_RUN",
          message:
            "Kanban server would start on port 4123 (host 127.0.0.1); nothing was started",
        },
      ],
    });
  });

  it("coalesces a second start: alreadyRunning with the FIRST instance URLs", async () => {
    const first = fakeInstance("http://localhost:3700");
    const start = vi.fn(async () => ({ instance: first, started: false }));
    // A different port, host AND dev than the first call used — the payload
    // keeps the first instance's URLs, exactly as the singleton behaves.
    const result = await startKanban(
      ctx,
      { port: 1, host: "0.0.0.0", dev: true },
      { ...fakePorts(), start },
    );
    expect(start).toHaveBeenCalledTimes(1);
    expect(result.ok && result.data).toMatchObject({
      alreadyRunning: true,
      started: false,
      url: "http://localhost:3700",
      kanbanUrl: "http://localhost:3700/kanban",
    });
    expect(result.ok && (result.data as { url: string }).url).not.toContain(
      ":1/",
    );
  });

  it("maps a refused bind to KANBAN_PORT_IN_USE naming the port", async () => {
    const refused = Object.assign(new Error("listen EADDRINUSE"), {
      code: "EADDRINUSE",
    });
    const withCause = Object.assign(new Error("wrapped"), {
      cause: { code: "EADDRINUSE" },
    });
    for (const failure of [refused, withCause]) {
      const result = await startKanban(
        ctx,
        { port: 3700 },
        {
          ...fakePorts(),
          start: async () => {
            throw failure;
          },
        },
      );
      expect(result).toEqual({
        ok: false,
        error: {
          code: "KANBAN_PORT_IN_USE",
          message:
            "Port 3700 is already in use, so the kanban server could not start.",
          suggestion:
            "Pass a different `port`, or stop whatever is listening on that port. If Vibeflow is already running here, call start_kanban again without a port.",
        },
      });
    }
  });

  it("maps any other startup failure to KANBAN_START_FAILED with its message", async () => {
    const result = await startKanban(
      ctx,
      {},
      {
        ...fakePorts(),
        start: async () => {
          throw new Error("boom");
        },
      },
    );
    expect(result).toEqual({
      ok: false,
      error: {
        code: "KANBAN_START_FAILED",
        message: "boom",
        suggestion:
          "Check the port is free and the project directory is a Vibeflow project, then call start_kanban again",
      },
    });
  });
});

describe("startKanbanServer singleton", () => {
  afterEach(async () => {
    serveSpy.mockReset();
    const { closeKanbanServer } = await import(
      "../../src/server/kanban-server.js"
    );
    await closeKanbanServer();
  });

  it("forwards dev/quiet/noCtrlCHint to serve() and never opens a browser", async () => {
    serveSpy.mockResolvedValue(fakeInstance());
    const { startKanbanServer } = await import(
      "../../src/server/kanban-server.js"
    );
    const { instance, started } = await startKanbanServer({
      projectDir: "/tmp/p7-kanban-singleton",
      port: 3700,
      dev: true,
      quiet: false,
      noCtrlCHint: true,
    });
    expect(started).toBe(true);
    expect(instance.url).toBe("http://localhost:3700");
    expect(serveSpy).toHaveBeenCalledTimes(1);
    expect(serveSpy.mock.calls[0][0]).toBeUndefined();
    expect(serveSpy.mock.calls[0][1]).toEqual({
      port: 3700,
      host: undefined,
      open: false,
      projectDir: "/tmp/p7-kanban-singleton",
      quiet: false,
      noCtrlCHint: true,
      dev: true,
    });
  });

  it("defaults to quiet with no dev chrome (MCP-safe)", async () => {
    serveSpy.mockResolvedValue(fakeInstance());
    const { startKanbanServer } = await import(
      "../../src/server/kanban-server.js"
    );
    await startKanbanServer({ projectDir: "/tmp/p7-kanban-singleton" });
    expect(serveSpy.mock.calls[0][1]).toEqual({
      port: 3700,
      host: undefined,
      open: false,
      projectDir: "/tmp/p7-kanban-singleton",
      quiet: true,
    });
  });

  it("a second call reuses the running instance and never calls serve() again", async () => {
    serveSpy.mockResolvedValue(fakeInstance("http://localhost:3700"));
    const { startKanbanServer } = await import(
      "../../src/server/kanban-server.js"
    );
    const first = await startKanbanServer({
      projectDir: "/tmp/p7-kanban-singleton",
      port: 3700,
    });
    expect(first.started).toBe(true);
    // Different port, host AND dev — all ignored, no second bind.
    const second = await startKanbanServer({
      projectDir: "/tmp/p7-kanban-singleton",
      port: 1,
      host: "0.0.0.0",
      dev: true,
      quiet: false,
    });
    expect(second.started).toBe(false);
    expect(second.instance).toBe(first.instance);
    expect(serveSpy).toHaveBeenCalledTimes(1);
  });
});
