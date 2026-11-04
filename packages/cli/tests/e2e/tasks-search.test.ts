/**
 * CLI + MCP e2e — `tasks --search` (ticket mq8azbxthl824162fnr4at49).
 *
 * The fuzzy search runs on a scratch LOCAL board through two surfaces that
 * share one operation: the CLI (`tasks --search "..." --json`) and MCP
 * (`list_tasks { search }`). Both must return the same ids in the same
 * relevance order (score, then id) — the parity contract — and a query no
 * substring would match must still hit (non-vacuous fuzziness).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  spawnCli,
  bootMcpServer,
  newClient,
  initialize,
  callTool,
  assertJsonTextContent,
  type McpTestEnv,
} from "./mcp-helpers.js";

const cleanups: Array<() => void> = [];
let mcpEnvs: McpTestEnv[] = [];
afterEach(async () => {
  for (const env of mcpEnvs) await env.instance.close().catch(() => {});
  mcpEnvs = [];
  while (cleanups.length) cleanups.pop()!();
});

function freshStore(): { store: string; home: string } {
  const store = mkdtempSync(join(tmpdir(), "search-e2e-store-"));
  const home = mkdtempSync(join(tmpdir(), "search-e2e-home-"));
  cleanups.push(() => {
    rmSync(store, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });
  return { store, home };
}

async function addTask(
  store: string,
  home: string,
  title: string,
  extra: string[] = [],
): Promise<string> {
  const add = await spawnCli(
    ["tasks", store, "--add", "--title", title, "--json", ...extra],
    { cwd: store, home },
  );
  expect(add.code).toBe(0);
  return JSON.parse(add.stdout).task.id as string;
}

describe("tasks --search (local) + list_tasks { search } parity", () => {
  it("same query, same ids, same relevance order on both surfaces", async () => {
    const { store, home } = freshStore();
    const widget = await addTask(store, home, "Fix the widget export");
    await addTask(store, home, "Polish the onboarding tour");
    await addTask(store, home, "Tag the release", ["--tag", "widget-export"]);

    // "wdget" is not a substring of "widget" — only the fuzzy matcher hits.
    const cli = await spawnCli(
      ["tasks", store, "--search", "wdget", "--json"],
      { cwd: store, home },
    );
    expect(cli.code).toBe(0);
    const cliBody = JSON.parse(cli.stdout);
    expect(cliBody.ok).toBe(true);
    // Local envelope carries the page at top level (see localListJsonPayload).
    const cliIds = cliBody.tasks.map((t: { id: string }) => t.id);
    // Tag-scope "widget-export" contains the subsequence too (w-i-d-g-e-t
    // across "widget-export"), so both rows match; title-hit order is by
    // score — but the KEY assertions are same-set + same-order as MCP.
    expect(cliIds).toContain(widget);
    expect(cliIds).not.toContain(undefined);
    expect(cliBody.order).toEqual(["score:asc", "id:asc"]);

    const env = await bootMcpServer(store);
    mcpEnvs.push(env);
    const client = newClient(env.mcpUrl);
    await initialize(client);
    const res = await callTool(client, "list_tasks", { search: "wdget" });
    const mcpBody = await assertJsonTextContent(res);
    const mcpIds = mcpBody.tasks.map((t: { id: string }) => t.id);

    // PARITY: same query → same ids in the same order.
    expect(mcpIds).toEqual(cliIds);
  });

  it("blank search behaves like no search", async () => {
    const { store, home } = freshStore();
    await addTask(store, home, "Fix the widget export");
    const plain = await spawnCli(["tasks", store, "--json"], {
      cwd: store,
      home,
    });
    const blank = await spawnCli(
      ["tasks", store, "--search", "   ", "--json"],
      { cwd: store, home },
    );
    expect(blank.code).toBe(0);
    expect(JSON.parse(blank.stdout).tasks).toEqual(
      JSON.parse(plain.stdout).tasks,
    );
  });
});
