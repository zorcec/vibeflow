/**
 * MCP + HTTP parity — creating a task with a parent.
 *
 * Both surfaces must accept an optional `parent` (full id or unique prefix),
 * link it in the same shape as the CLI `--add --parent`, and reject a dangling
 * target with the `Parent task not found: <id>` wording.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  bootMcpServer,
  newClient,
  initialize,
  callTool,
  assertJsonTextContent,
  type McpClient,
  type McpTestEnv,
} from "./mcp-helpers.js";

async function httpCreate(
  baseUrl: string,
  body: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

describe("create with parent — MCP + HTTP parity", () => {
  let env: McpTestEnv;
  let client: McpClient;

  beforeEach(async () => {
    env = await bootMcpServer();
    client = newClient(env.mcpUrl);
    await initialize(client);
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("MCP create_task links a child under a full parent id", async () => {
    const parent = await assertJsonTextContent(
      await callTool(client, "create_task", { title: "Parent" }),
    );

    const child = await assertJsonTextContent(
      await callTool(client, "create_task", {
        title: "Child",
        parent: parent.id,
      }),
    );

    expect(child.links).toEqual([{ taskId: parent.id, type: "parent" }]);
  });

  it("MCP create_task resolves a prefix and rejects a dangling parent", async () => {
    const parent = await assertJsonTextContent(
      await callTool(client, "create_task", { title: "Parent" }),
    );

    const child = await assertJsonTextContent(
      await callTool(client, "create_task", {
        title: "Child",
        parent: parent.id.slice(0, 8),
      }),
    );
    expect(child.links).toEqual([{ taskId: parent.id, type: "parent" }]);

    const bad = await assertJsonTextContent(
      await callTool(client, "create_task", {
        title: "Orphan",
        parent: "deadbeefdeadbeef",
      }),
    );
    expect(bad.message).toBe("Parent task not found: deadbeefdeadbeef");
  });

  it("POST /api/tasks links a child under a parent field", async () => {
    const parent = await httpCreate(env.baseUrl, {
      title: "Parent",
      selector: "/",
    });
    expect(parent.status).toBe(200);
    const parentId = parent.json.task.id;

    const child = await httpCreate(env.baseUrl, {
      title: "Child",
      selector: "/",
      parent: parentId,
    });
    expect(child.status).toBe(200);
    expect(child.json.task.links).toEqual([
      { taskId: parentId, type: "parent" },
    ]);

    // prefix resolution
    const child2 = await httpCreate(env.baseUrl, {
      title: "Child 2",
      selector: "/",
      parent: parentId.slice(0, 8),
    });
    expect(child2.status).toBe(200);
    expect(child2.json.task.links).toEqual([
      { taskId: parentId, type: "parent" },
    ]);
  });

  it("POST /api/tasks rejects a dangling parent", async () => {
    const res = await httpCreate(env.baseUrl, {
      title: "Orphan",
      selector: "/",
      parent: "deadbeefdeadbeef",
    });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("Parent task not found: deadbeefdeadbeef");
  });
});
