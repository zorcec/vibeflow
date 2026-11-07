/**
 * Cross-surface parity — a dangling parent is a LINK problem everywhere.
 *
 * Owner rule (ticket 180347d6): the code is INVALID_LINKS on every surface.
 * The CLI keeps its friendly client-side pre-check (better message, no round
 * trip) but reports the same code the hosted backend answers for the same
 * mistake, so automation sees one code. This file pins the contract end to
 * end: CLI `tasks --add --parent <missing>` and `--edit --set-parent
 * <missing>` answer INVALID_LINKS under `--json`, carrying the same
 * `{ok:false, error:{code,message}}` shape — with the same code and the same
 * wording — as the local MCP `create_task` / `update_task` parent refusals.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bootMcpServer,
  newClient,
  initialize,
  callTool,
  assertJsonTextContent,
  spawnCli,
  type McpClient,
  type McpTestEnv,
} from "./mcp-helpers.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const GHOST = "deadbeefdeadbeef";

async function addTask(
  store: string,
  home: string,
  title: string,
): Promise<string> {
  const r = await spawnCli(
    ["tasks", store, "--add", "--title", title, "--json"],
    { cwd: store, home },
  );
  expect(r.code).toBe(0);
  return (JSON.parse(r.stdout) as { task: { id: string } }).task.id;
}

function expectInvalidLinksRefusal(
  r: { stdout: string; stderr: string; code: number | null },
  ghost: string,
): { code: string; message: string } {
  expect(r.code).not.toBe(0);
  expect(r.stdout.trim()).toBe("");
  const envelope = JSON.parse(r.stderr) as {
    ok: boolean;
    error: { code: string; message: string };
  };
  expect(envelope.ok).toBe(false);
  expect(envelope.error.code).toBe("INVALID_LINKS");
  expect(envelope.error.message).toBe(`Parent task not found: ${ghost}`);
  return envelope.error;
}

describe("dangling parent — INVALID_LINKS on every surface", () => {
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

  it("CLI --add --parent <missing> answers INVALID_LINKS", async () => {
    const store = freshDir("parent-code-store-");
    const home = freshDir("parent-code-home-");
    const r = await spawnCli(
      [
        "tasks",
        store,
        "--add",
        "--title",
        "Orphan",
        "--parent",
        GHOST,
        "--json",
      ],
      { cwd: store, home },
    );
    expectInvalidLinksRefusal(r, GHOST);
  });

  it("CLI --edit --set-parent <missing> answers INVALID_LINKS", async () => {
    const store = freshDir("parent-code-store-");
    const home = freshDir("parent-code-home-");
    const id = await addTask(store, home, "Needs a parent");
    const r = await spawnCli(
      ["tasks", store, "--edit", id, "--set-parent", GHOST, "--json"],
      { cwd: store, home },
    );
    expectInvalidLinksRefusal(r, GHOST);
  });

  it("MCP create_task / update_task refuse the same mistake with the same code and shape", async () => {
    const badCreate = await assertJsonTextContent(
      await callTool(client, "create_task", {
        title: "Orphan",
        parent: GHOST,
      }),
    );
    expect(badCreate.ok).toBe(false);
    expect(badCreate.error.code).toBe("INVALID_LINKS");
    expect(badCreate.error.message).toBe(`Parent task not found: ${GHOST}`);

    const child = await assertJsonTextContent(
      await callTool(client, "create_task", { title: "Child" }),
    );
    const badUpdate = await assertJsonTextContent(
      await callTool(client, "update_task", { id: child.id, parent: GHOST }),
    );
    expect(badUpdate.ok).toBe(false);
    expect(badUpdate.error.code).toBe("INVALID_LINKS");
    expect(badUpdate.error.message).toBe(`Parent task not found: ${GHOST}`);
  });
});
