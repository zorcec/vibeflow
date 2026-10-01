/**
 * update_task link-writing modes at the MCP surface.
 *
 * The regression these lock down is concrete: `links` REPLACES the whole set,
 * so an agent that passed a partial array silently destroyed the parent link.
 * In this repo that actually happened — moving task bf03b8eb to review with
 * `links: [{taskId: 1fcb040f, type: "blocks"}]` would have detached it from
 * parent 820fa561. `addLinks` / `removeLinks` exist so the common case never
 * needs a destructive replace.
 *
 * These run over the real HTTP MCP transport via the shared helpers, so they
 * assert the wire behaviour an agent actually sees. On-disk effects are read
 * straight from the task JSON, not from a cached read model.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, globSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bootMcpServer,
  newClient,
  initialize,
  callTool,
  assertJsonTextContent,
  seedGitUser,
  type McpClient,
  type McpTestEnv,
} from "./mcp-helpers.js";

let env: McpTestEnv;
let client: McpClient;

async function call(tool: string, args: Record<string, unknown>) {
  return assertJsonTextContent(await callTool(client, tool, args));
}

async function mkTask(title: string, extra: Record<string, unknown> = {}) {
  const data = await call("create_task", { title, ...extra });
  return data;
}

/** Find a task JSON file in .vibeflow/tasks (flat or date-subdir layout). */
function findTaskFile(projectDir: string, taskId: string): string | null {
  const tasksDir = join(projectDir, ".vibeflow", "tasks");
  const flat = join(tasksDir, `${taskId}.json`);
  if (existsSync(flat)) return flat;
  return globSync(join(tasksDir, "*", `${taskId}.json`))[0] ?? null;
}

/**
 * Read the persisted links straight from the task's JSON on disk, so these
 * tests prove the write landed rather than that the tool returned success.
 */
function diskLinks(
  projectDir: string,
  taskId: string,
): Array<{ taskId: string; type: string }> {
  const file = findTaskFile(projectDir, taskId);
  if (!file) throw new Error(`no task file on disk for ${taskId}`);
  const raw = JSON.parse(readFileSync(file, "utf-8")) as { links?: unknown };
  return (raw.links ?? []) as Array<{ taskId: string; type: string }>;
}

beforeEach(async () => {
  // Seed git user BEFORE booting — MCP reads it at server creation time.
  const tmp = mkdtempSync(join(tmpdir(), "mcp-linkmodes-"));
  seedGitUser(tmp);
  env = await bootMcpServer(tmp);
  client = newClient(env.mcpUrl);
  await initialize(client);
});

afterEach(async () => {
  await env.cleanup();
});

describe("addLinks / removeLinks preserve what they do not name", () => {
  it("adds a blocks link WITHOUT deleting an existing parent", async () => {
    const root = await mkTask("growth parent");
    const child = await mkTask("child task", { parent: root.id });
    const other = await mkTask("unrelated");

    // Sanity: the parent link exists before we touch anything.
    expect(diskLinks(env.projectDir, child.id)).toEqual([
      { taskId: root.id, type: "parent" },
    ]);

    await call("update_task", {
      id: child.id,
      addLinks: [{ taskId: other.id, type: "blocks" }],
    });

    const links = diskLinks(env.projectDir, child.id);
    // The whole point: the parent survived a call that never mentioned it.
    expect(links).toContainEqual({ taskId: root.id, type: "parent" });
    expect(links).toContainEqual({ taskId: other.id, type: "blocks" });
    expect(links).toHaveLength(2);
  });

  it("removes one link and keeps every other", async () => {
    const root = await mkTask("root");
    const a = await mkTask("a");
    const b = await mkTask("b");
    const child = await mkTask("child", { parent: root.id });

    await call("update_task", {
      id: child.id,
      addLinks: [
        { taskId: a.id, type: "relates" },
        { taskId: b.id, type: "blocks" },
      ],
    });
    expect(diskLinks(env.projectDir, child.id)).toHaveLength(3);

    await call("update_task", {
      id: child.id,
      removeLinks: [{ taskId: a.id, type: "relates" }],
    });

    const links = diskLinks(env.projectDir, child.id);
    expect(links).toHaveLength(2);
    expect(links).toContainEqual({ taskId: root.id, type: "parent" });
    expect(links).toContainEqual({ taskId: b.id, type: "blocks" });
    expect(links).not.toContainEqual({ taskId: a.id, type: "relates" });
  });

  it("adding a link that is already present is a no-op, not a duplicate", async () => {
    const parent = await mkTask("parent");
    const child = await mkTask("child", { parent: parent.id });
    const other = await mkTask("other");

    await call("update_task", {
      id: child.id,
      addLinks: [{ taskId: other.id, type: "relates" }],
    });
    // Same pair twice, in one payload and across calls.
    await call("update_task", {
      id: child.id,
      addLinks: [
        { taskId: other.id, type: "relates" },
        { taskId: other.id, type: "relates" },
      ],
    });

    const links = diskLinks(env.projectDir, child.id);
    expect(links.filter((l) => l.taskId === other.id)).toHaveLength(1);
    expect(links).toHaveLength(2);
  });

  it("two link TYPES to the same task stay distinct", async () => {
    const x = await mkTask("x");
    const y = await mkTask("y");

    await call("update_task", {
      id: y.id,
      addLinks: [
        { taskId: x.id, type: "relates" },
        { taskId: x.id, type: "blocks" },
      ],
    });

    const links = diskLinks(env.projectDir, y.id);
    expect(links).toHaveLength(2);
    expect(links).toContainEqual({ taskId: x.id, type: "relates" });
    expect(links).toContainEqual({ taskId: x.id, type: "blocks" });
  });
});

describe("link modes compose — they are no longer mutually exclusive", () => {
  // `links` used to REPLACE, so combining it with addLinks/removeLinks was
  // ambiguous and refused E_USAGE. Under MERGE there is no conflict: both
  // fields mean the same additive thing, and the order is defined
  // (clearLinks -> merge -> subtract). Refusing them would only reintroduce
  // the question "which one wins?".
  it("links + addLinks merge into one union, deduped", async () => {
    const parent = await mkTask("parent");
    const a = await mkTask("a");
    const b = await mkTask("b");
    const child = await mkTask("child", { parent: parent.id });

    const data = await call("update_task", {
      id: child.id,
      links: [{ taskId: a.id, type: "blocks" }],
      addLinks: [
        { taskId: a.id, type: "blocks" },
        { taskId: b.id, type: "relates" },
      ],
    });

    expect(data.ok ?? true).toBeTruthy();
    const links = diskLinks(env.projectDir, child.id);
    expect(links).toContainEqual({ taskId: parent.id, type: "parent" });
    expect(links).toContainEqual({ taskId: a.id, type: "blocks" });
    expect(links).toContainEqual({ taskId: b.id, type: "relates" });
    // The shared pair appears once.
    expect(links).toHaveLength(3);
  });

  it("links + removeLinks subtracts after merging", async () => {
    const parent = await mkTask("parent");
    const keep = await mkTask("keep");
    const drop = await mkTask("drop");
    const child = await mkTask("child", { parent: parent.id });
    await call("update_task", {
      id: child.id,
      addLinks: [{ taskId: drop.id, type: "relates" }],
    });

    await call("update_task", {
      id: child.id,
      links: [{ taskId: keep.id, type: "blocks" }],
      removeLinks: [{ taskId: drop.id, type: "relates" }],
    });

    const links = diskLinks(env.projectDir, child.id);
    expect(links).toContainEqual({ taskId: parent.id, type: "parent" });
    expect(links).toContainEqual({ taskId: keep.id, type: "blocks" });
    expect(links).not.toContainEqual({ taskId: drop.id, type: "relates" });
  });

  it("links:[] is refused even alongside removeLinks", async () => {
    // An empty array under MERGE is a client that still thinks REPLACE is
    // happening. Refusing is the only safe reading — silently ignoring it is
    // the worst outcome and silently clearing is the dangerous one.
    const parent = await mkTask("parent");
    const other = await mkTask("other");
    const child = await mkTask("child", { parent: parent.id });
    await call("update_task", {
      id: child.id,
      addLinks: [{ taskId: other.id, type: "relates" }],
    });

    const data = await call("update_task", {
      id: child.id,
      links: [],
      removeLinks: [{ taskId: other.id, type: "relates" }],
    });

    expect(data.ok).toBe(false);
    expect(data.error.code).toBe("E_USAGE");
    // Nothing written: both links survive the refusal.
    expect(diskLinks(env.projectDir, child.id)).toHaveLength(2);
  });
});

describe("links MERGES — the same guarantee the CLI gives", () => {
  it("a link you do not name is PRESERVED", async () => {
    const parent = await mkTask("parent");
    const other = await mkTask("other");
    const child = await mkTask("child", { parent: parent.id });

    await call("update_task", {
      id: child.id,
      links: [{ taskId: other.id, type: "blocks" }],
    });

    // `links` used to REPLACE here and drop the parent. It now merges, so the
    // parent survives — the whole point of the change, and the reason an agent
    // can no longer destroy a link by sending an incomplete update.
    const links = diskLinks(env.projectDir, child.id);
    expect(links).toContainEqual({ taskId: parent.id, type: "parent" });
    expect(links).toContainEqual({ taskId: other.id, type: "blocks" });
    expect(links).toHaveLength(2);
  });

  it("links and addLinks are the same MERGE — sending both dedupes", async () => {
    const a = await mkTask("a");
    const b = await mkTask("b");
    const child = await mkTask("child");

    await call("update_task", {
      id: child.id,
      links: [{ taskId: a.id, type: "relates" }],
      addLinks: [
        { taskId: a.id, type: "relates" },
        { taskId: b.id, type: "blocks" },
      ],
    });

    // The shared pair appears once, not twice.
    expect(diskLinks(env.projectDir, child.id)).toEqual([
      { taskId: a.id, type: "relates" },
      { taskId: b.id, type: "blocks" },
    ]);
  });

  it("clearLinks:true is the ONLY way to clear links", async () => {
    const parent = await mkTask("parent");
    const child = await mkTask("child", { parent: parent.id });

    await call("update_task", { id: child.id, clearLinks: true });
    expect(diskLinks(env.projectDir, child.id)).toEqual([]);
  });

  it("clearLinks:false is a no-op, not a clear", async () => {
    const parent = await mkTask("parent");
    const child = await mkTask("child", { parent: parent.id });

    await call("update_task", { id: child.id, clearLinks: false });
    // A client that always sends the flag must not wipe links by omission.
    expect(diskLinks(env.projectDir, child.id)).toEqual([
      { taskId: parent.id, type: "parent" },
    ]);
  });

  it("links:[] is REFUSED, pointing at clearLinks", async () => {
    const parent = await mkTask("parent");
    const child = await mkTask("child", { parent: parent.id });

    // Silently doing nothing would be the worst outcome, and silently clearing
    // would be the dangerous one — so it is an explicit E_USAGE.
    const data = await call("update_task", { id: child.id, links: [] });
    expect(data.ok).toBe(false);
    expect(data.error.code).toBe("E_USAGE");
    expect(JSON.stringify(data.error)).toContain("clearLinks");
    // Refused means refused: the parent is untouched.
    expect(diskLinks(env.projectDir, child.id)).toEqual([
      { taskId: parent.id, type: "parent" },
    ]);
  });

  it("clear then add in one call applies in that order", async () => {
    const stale = await mkTask("stale");
    const fresh = await mkTask("fresh");
    const parent = await mkTask("parent");
    const child = await mkTask("child", { parent: parent.id });
    await call("update_task", {
      id: child.id,
      addLinks: [{ taskId: stale.id, type: "relates" }],
    });

    await call("update_task", {
      id: child.id,
      clearLinks: true,
      addLinks: [{ taskId: fresh.id, type: "blocks" }],
    });

    const links = diskLinks(env.projectDir, child.id);
    expect(links).toContainEqual({ taskId: fresh.id, type: "blocks" });
    expect(links).not.toContainEqual({ taskId: stale.id, type: "relates" });
  });

  it("removeLinks wins over links in the same call (merge then subtract)", async () => {
    const keep = await mkTask("keep");
    const drop = await mkTask("drop");
    const child = await mkTask("child");
    await call("update_task", {
      id: child.id,
      addLinks: [{ taskId: drop.id, type: "relates" }],
    });

    await call("update_task", {
      id: child.id,
      links: [{ taskId: keep.id, type: "blocks" }],
      removeLinks: [{ taskId: drop.id, type: "relates" }],
    });

    const links = diskLinks(env.projectDir, child.id);
    expect(links).toContainEqual({ taskId: keep.id, type: "blocks" });
    expect(links).not.toContainEqual({ taskId: drop.id, type: "relates" });
  });
});

describe("refusals leave existing links alone", () => {
  it("a self-link refusal writes nothing", async () => {
    const parent = await mkTask("parent");
    const child = await mkTask("child", { parent: parent.id });

    const data = await call("update_task", {
      id: child.id,
      addLinks: [{ taskId: child.id, type: "relates" }],
    });

    expect(data.ok).toBe(false);
    expect(diskLinks(env.projectDir, child.id)).toEqual([
      { taskId: parent.id, type: "parent" },
    ]);
  });

  it("a second parent is refused and the first survives", async () => {
    const p1 = await mkTask("p1");
    const p2 = await mkTask("p2");
    const child = await mkTask("child", { parent: p1.id });

    const data = await call("update_task", {
      id: child.id,
      addLinks: [{ taskId: p2.id, type: "parent" }],
    });

    expect(data.ok).toBe(false);
    expect(diskLinks(env.projectDir, child.id)).toEqual([{ taskId: p1.id, type: "parent" }]);
  });

  it("a link to a task that does not exist is TASK_NOT_FOUND", async () => {
    const child = await mkTask("child");

    const data = await call("update_task", {
      id: child.id,
      addLinks: [{ taskId: "deadbeefdeadbeef", type: "relates" }],
    });

    expect(data.ok).toBe(false);
    expect(data.error.code).toBe("TASK_NOT_FOUND");
  });

  it("a cycle through the parent chain is refused", async () => {
    const grandparent = await mkTask("grandparent");
    const parent = await mkTask("parent", { parent: grandparent.id });
    const child = await mkTask("child", { parent: parent.id });

    // grandparent -> child would make child its own ancestor.
    const data = await call("update_task", {
      id: grandparent.id,
      addLinks: [{ taskId: child.id, type: "parent" }],
    });

    expect(data.ok).toBe(false);
    expect(diskLinks(env.projectDir, grandparent.id)).toEqual([]);
  });
});

describe("dry run previews without writing", () => {
  it("addLinks under dryRun changes nothing on disk", async () => {
    const parent = await mkTask("parent");
    const other = await mkTask("other");
    const child = await mkTask("child", { parent: parent.id });

    const data = await call("update_task", {
      id: child.id,
      addLinks: [{ taskId: other.id, type: "blocks" }],
      dryRun: true,
    });

    expect(data.notices?.[0]?.code).toBe("DRY_RUN");
    expect(diskLinks(env.projectDir, child.id)).toEqual([
      { taskId: parent.id, type: "parent" },
    ]);
  });
});

describe("additive editing matches the CLI's surgical --set-parent", () => {
  it("swaps the parent and keeps a link it never named", async () => {
    const p1 = await mkTask("old parent");
    const p2 = await mkTask("new parent");
    const other = await mkTask("other");
    const child = await mkTask("child", { parent: p1.id });
    await call("update_task", {
      id: child.id,
      addLinks: [{ taskId: other.id, type: "relates" }],
    });

    // Remove then add — the surgical equivalent of `--set-parent p2`.
    await call("update_task", {
      id: child.id,
      removeLinks: [{ taskId: p1.id, type: "parent" }],
    });
    await call("update_task", {
      id: child.id,
      addLinks: [{ taskId: p2.id, type: "parent" }],
    });

    const links = diskLinks(env.projectDir, child.id);
    expect(links).toContainEqual({ taskId: p2.id, type: "parent" });
    expect(links).not.toContainEqual({ taskId: p1.id, type: "parent" });
    // The relates link was never named in either call and survived.
    expect(links).toContainEqual({ taskId: other.id, type: "relates" });
  });
});