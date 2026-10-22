/**
 * MCP `command_run` telemetry (ticket 4e942bed).
 *
 * The MCP server emitted NOTHING to PostHog: every tool call was invisible,
 * so MCP usage could not be compared against the CLI. `createMcpServer`
 * now captures one `command_run` per tool call from its single dispatch
 * hook, with `surface: "mcp"` (CLI emitters carry `surface: "cli"`) so one
 * PostHog filter separates the two surfaces.
 *
 * These tests drive tools THROUGH `createMcpServer` (the `_registeredTools`
 * cast from parity.test.ts) so they see the dispatch hook, not just the
 * operation. The REAL telemetry module is used with `posthog-node` mocked
 * out, so the opt-out guard (`VIBEFLOW_TELEMETRY=0` / test guard) is the
 * production code path — a test that mocked `capture()` itself could not
 * prove suppression.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { flushTelemetry } from "../../../src/telemetry.js";
import { createMcpServer } from "../../../src/mcp/server.js";
import { manifest } from "../../../src/mcp/manifest.js";
import { CLI_VERSION } from "../../../src/version.js";

/**
 * Every event carries the build/runtime envelope (see telemetry.ts). These are
 * NOT PII — no hostname, path or username — but they ARE part of the contract,
 * so they are spelled out here rather than swallowed by objectContaining: a new
 * property must still fail this file.
 */
const ENV_PROPS = {
  cli_version: CLI_VERSION,
  os: `${process.platform}-${process.arch}`,
  node_version: process.versions.node,
};

/** PostHog transport spy: constructor args + every `capture()` payload. */
const ctorSpy = vi.hoisted(() => vi.fn());
const captureSpy = vi.hoisted(() => vi.fn());

vi.mock("posthog-node", () => ({
  PostHog: class MockPostHog {
    constructor(...args: unknown[]) {
      ctorSpy(...args);
    }
    capture(payload: unknown): void {
      captureSpy(payload);
    }
    shutdown(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

let testDir: string;
let homeDir: string;
let originalHome: string | undefined;

function enableTelemetry(): void {
  process.env.HOME = homeDir;
  delete process.env.VIBEFLOW_TELEMETRY;
  // The escape hatch the telemetry module documents for tests exercising
  // the enabled path (the module refuses to enable under vitest otherwise).
  process.env.VIBEFLOW_TELEMETRY_ALLOW_IN_TESTS = "1";
}

function disableTelemetry(): void {
  process.env.VIBEFLOW_TELEMETRY = "0";
  delete process.env.VIBEFLOW_TELEMETRY_ALLOW_IN_TESTS;
}

beforeEach(() => {
  testDir = join(tmpdir(), `mcp-telemetry-${Date.now()}-${process.pid}`);
  mkdirSync(testDir, { recursive: true });
  homeDir = join(testDir, "home");
  mkdirSync(homeDir, { recursive: true });
  originalHome = process.env.HOME;
  captureSpy.mockClear();
  ctorSpy.mockClear();
  disableTelemetry();
});

afterEach(async () => {
  // Reset the telemetry singleton (its client holds the mocked PostHog)
  // so one test's enabled client cannot leak captures into the next.
  await flushTelemetry();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  disableTelemetry();
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

/**
 * Call a tool through the server's dispatch hook — the same cast
 * parity.test.ts uses (`_registeredTools` is the SDK's private registry).
 */
async function callThroughServer(
  tool: string,
  input: unknown,
): Promise<unknown> {
  const registered = (
    createMcpServer(testDir, "local") as unknown as {
      _registeredTools: Record<
        string,
        {
          handler: (
            input: unknown,
          ) => Promise<{ content: Array<{ type: string; text: string }> }>;
        }
      >;
    }
  )._registeredTools;
  const result = await registered[tool]!.handler(input);
  return JSON.parse(result.content[0]!.text) as unknown;
}

function commandRunEvents(): Array<Record<string, unknown>> {
  return captureSpy.mock.calls
    .map((call) => call[0] as Record<string, unknown>)
    .filter((payload) => payload["event"] === "command_run");
}

describe("MCP command_run telemetry", () => {
  it("a tool call emits exactly ONE command_run with surface=mcp + tool + command + ok", async () => {
    enableTelemetry();

    await callThroughServer("list_tasks", { limit: 5 });

    expect(commandRunEvents()).toEqual([
      {
        distinctId: expect.any(String),
        event: "command_run",
        // toEqual (not objectContaining): the analytics contract is small
        // and PII-free — a new property (project root, task id, …) must
        // fail this test rather than ship silently.
        properties: {
          surface: "mcp",
          tool: "list_tasks",
          command: "tasks",
          ok: true,
          $user_id: expect.any(String),
          ...ENV_PROPS,
        },
      },
    ]);
  });

  it("a refused tool call still emits, with ok:false", async () => {
    enableTelemetry();

    const wire = (await callThroughServer("get_task", {
      id: "nope0000000000",
    })) as Record<string, unknown>;
    // Control: the tool really refused, so ok:false describes reality.
    expect(wire).toMatchObject({ ok: false });

    expect(commandRunEvents()).toEqual([
      {
        distinctId: expect.any(String),
        event: "command_run",
        properties: {
          surface: "mcp",
          tool: "get_task",
          command: "tasks",
          ok: false,
          $user_id: expect.any(String),
          ...ENV_PROPS,
        },
      },
    ]);
  });

  it("the event is suppressed when telemetry is disabled, and the tool still works", async () => {
    disableTelemetry();

    const wire = (await callThroughServer("list_tasks", {
      limit: 5,
    })) as Record<string, unknown>;

    expect(captureSpy).not.toHaveBeenCalled();
    // Telemetry must never break the tool: the call still answers.
    expect(wire).toHaveProperty("tasks");
  });

  it("two calls emit two events (no dedupe/coalescing)", async () => {
    enableTelemetry();

    await callThroughServer("list_tasks", { limit: 5 });
    await callThroughServer("get_project", {});

    const events = commandRunEvents();
    expect(events).toHaveLength(2);
    expect(
      events.map(
        (payload) =>
          (payload["properties"] as Record<string, unknown>)["tool"],
      ),
    ).toEqual(["list_tasks", "get_project"]);
  });

  it("a tool added to the manifest is covered WITHOUT touching server.ts", async () => {
    enableTelemetry();

    // A probe tool appended to the manifest at runtime only. If coverage
    // required a per-tool call site, this tool would emit nothing.
    const ProbeInput = z.object({}).strict();
    manifest.push({
      name: "probe_coverage_tool",
      title: "Probe",
      description: "test-only probe proving single-hook coverage",
      cliRef: { command: "tasks", flags: [] },
      category: "task-read",
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      input: ProbeInput.shape,
      schema: ProbeInput,
      run: () => Promise.resolve({ ok: true as const, data: null }),
    });
    try {
      await callThroughServer("probe_coverage_tool", {});
    } finally {
      manifest.pop();
    }

    expect(commandRunEvents()).toEqual([
      {
        distinctId: expect.any(String),
        event: "command_run",
        properties: {
          surface: "mcp",
          tool: "probe_coverage_tool",
          command: "tasks",
          ok: true,
          $user_id: expect.any(String),
          ...ENV_PROPS,
        },
      },
    ]);
  });
});
