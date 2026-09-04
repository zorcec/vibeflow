/**
 * MCP e2e — MCP-from-manifest parity (spec §2.8, Phase 5-aware).
 *
 * src/mcp/server.ts registers 10 tools with hand-copied descriptions/schemas;
 * src/mcp/manifest.ts is the intended single source of truth. Phase 5 will
 * register tools FROM the manifest — at that point the soft-parity assertions
 * here (inputSchema keys, annotations) flip to strict manifest-derived checks.
 *
 * Existing static drift coverage lives in tests/unit/mcp/drift.test.ts — this
 * suite covers parity via tools/list over HTTP.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { manifest } from "../../src/mcp/manifest.js";
import {
  bootMcpServer,
  newClient,
  initialize,
  listTools,
  callTool,
  type McpClient,
  type McpTestEnv,
} from "./mcp-helpers.js";

interface ToolDef {
  name: string;
  description: string;
  inputSchema?: { properties?: Record<string, unknown> };
  annotations?: unknown;
}

describe("MCP-from-manifest parity", () => {
  let env: McpTestEnv;
  let client: McpClient;
  let tools: ToolDef[];

  beforeAll(async () => {
    env = await bootMcpServer();
    client = newClient(env.mcpUrl);
    await initialize(client);
    const res = await listTools(client);
    expect(res.status).toBe(200);
    const body = await res.json();
    tools = body.result.tools as ToolDef[];
  });

  afterAll(async () => {
    await env.cleanup();
  });

  it("1: names parity — tools/list === manifest, exactly 10, no extras", () => {
    const listed = tools.map((t) => t.name).sort();
    const manifestNames = manifest.map((m) => m.name).sort();
    expect(listed).toEqual(manifestNames);
    expect(tools.length).toBe(10);
  });

  it("2: descriptions parity — server copies manifest descriptions verbatim", () => {
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const m of manifest) {
      const tool = byName.get(m.name);
      expect(tool, `tool ${m.name} missing from tools/list`).toBeDefined();
      expect(tool!.description).toBe(m.description);
    }
  });

  it("3: light schema check — invalid documented field rejected with -32602", async () => {
    // One intentionally invalid documented field per tool: if the server
    // ACCEPTS it, the HTTP schema drifted from the manifest-documented shape.
    const invalidArgs: Record<string, Record<string, unknown>> = {
      list_tasks: { limit: -1 },
      get_task: { id: 123 },
      create_task: { title: 123 },
      update_task: {
        id: "ffffffffffffffffffffffffffff00",
        status: "bogus",
      },
      claim_next_task: { dryRun: "yes" },
      add_comment: { id: 123, text: "x" },
      attach_file: { id: 123, filename: "a.md", contentB64: "aGk=" },
      export_prompt: { format: "html" },
      verify_task: { id: 123, url: "http://ok" },
      push_tasks: { dryRun: "yes" },
    };
    for (const m of manifest) {
      const bad = invalidArgs[m.name];
      expect(bad, `no invalid-args probe for ${m.name}`).toBeDefined();
      const res = await callTool(client, m.name, bad);
      expect(res.status, m.name).toBe(200);
      const body = await res.json();
      const text = body.result?.content?.[0]?.text ?? "";
      const rejected =
        body.error?.code === -32602 || text.startsWith("MCP error -32602");
      expect(rejected, `${m.name} accepted invalid args: ${text.slice(0, 80)}`).toBe(
        true,
      );
    }
  });

  it("4: inputSchema key parity — [Phase 5 flip] strict manifest derivation", () => {
    // Soft parity TODAY: hand-copied server.ts schemas must expose exactly the
    // keys the manifest zod shapes document. Phase 5 flips this to derive both
    // sides from the manifest and assert strict equality of full schemas.
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const m of manifest) {
      const tool = byName.get(m.name)!;
      const listedKeys = Object.keys(tool.inputSchema?.properties ?? {}).sort();
      // manifest input is a ZodRawShape (plain object) after Phase 5
      const shape = (m.input as Record<string, unknown>) ?? {};
      const manifestKeys = Object.keys(shape).sort();
      expect(listedKeys, m.name).toEqual(manifestKeys);
    }
  });

  it("5: annotations absent — [Phase 5 flip] will equal manifest.annotations", () => {
    // Hand-registered via server.tool without annotations today.
    for (const t of tools) {
      expect(t.annotations, t.name).toBeUndefined();
    }
  });
});
