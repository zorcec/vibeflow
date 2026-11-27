/**
 * A refusal must be a FAILED tool call, not a successful one with a sad payload.
 *
 * `formatResult` has always serialised refusals as `{ok:false, error:{…}}`
 * JSON text, but it never set MCP's own `isError` flag. A client that checks
 * the protocol flag — the standard way — therefore read a refusal as success
 * and had to parse our envelope to learn otherwise.
 *
 * These cases drive a real SDK Client through InMemoryTransport, so the
 * assertion is on the result a client actually receives after the SDK's
 * request handler, not on the return value of an internal helper.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Task } from "../../../src/core/types.js";
import { createMcpServer } from "../../../src/mcp/server.js";

let testDir: string;

function createTestTask(overrides: Partial<Task> = {}): Task {
  const task: Task = {
    id: "task-1",
    title: "Test Task",
    description: "A test task",
    status: "todo",
    selector: "/",
    created: new Date().toISOString(),
    comments: [],
    files: [],
    ...overrides,
  };
  const dateDir = join(testDir, ".vibeflow", "tasks", task.created.slice(0, 10));
  mkdirSync(dateDir, { recursive: true });
  writeFileSync(join(dateDir, `${task.id}.json`), JSON.stringify(task, null, 2));
  return task;
}

/** Seed the project settings so the developer's global settings never apply. */
function writeSettings(settings: Record<string, unknown>): void {
  mkdirSync(join(testDir, ".vibeflow"), { recursive: true });
  writeFileSync(
    join(testDir, ".vibeflow", "settings.json"),
    JSON.stringify(settings, null, 2),
  );
}

/**
 * A connected SDK client for one server instance. The pair is in-memory, so
 * the call costs nothing and still crosses the protocol boundary.
 */
async function connectClient(): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = createMcpServer(testDir, "local");
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "refusal-is-error-test", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

beforeEach(() => {
  testDir = join(tmpdir(), `mcp-refusal-is-error-${Date.now()}-${process.pid}`);
  mkdirSync(testDir, { recursive: true });
  writeSettings({ autoCommit: false, createBranch: false });
});

afterEach(() => {
  if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
});

describe("refusals carry the protocol error flag", () => {
  it("get_task on an unknown id answers isError:true", async () => {
    const { client, close } = await connectClient();
    try {
      const result = await client.callTool({
        name: "get_task",
        arguments: { id: "no-such-task" },
      });

      expect(result.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it("keeps the {ok:false, error:{…}} payload envelope-aware clients parse", async () => {
    const { client, close } = await connectClient();
    try {
      const result = await client.callTool({
        name: "get_task",
        arguments: { id: "no-such-task" },
      });
      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      const parsed = JSON.parse(text) as Record<string, any>;

      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("TASK_NOT_FOUND");
      expect(typeof parsed.error.message).toBe("string");
      expect(parsed.error.retryable).toBe(false);
    } finally {
      await close();
    }
  });

  it("a successful call carries no isError flag at all", async () => {
    createTestTask();
    const { client, close } = await connectClient();
    try {
      const result = await client.callTool({
        name: "get_task",
        arguments: { id: "task-1" },
      });

      // Absent, not false: the happy path's result is byte-identical to
      // what it was before the flag existed.
      expect(result.isError).toBeUndefined();
      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      expect(JSON.parse(text).id).toBe("task-1");
    } finally {
      await close();
    }
  });

  it("a write refusal is flagged too — not just the read path", async () => {
    const { client, close } = await connectClient();
    try {
      const result = await client.callTool({
        name: "update_task",
        arguments: { id: "no-such-task", title: "x" },
      });

      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>)[0]
        .text;
      expect(JSON.parse(text).error.code).toBe("TASK_NOT_FOUND");
    } finally {
      await close();
    }
  });
});
