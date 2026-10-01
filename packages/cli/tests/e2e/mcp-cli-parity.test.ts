/**
 * CLI ↔ MCP parity e2e — the claim under test: "CLI commands are automatically
 * mapped to MCP tools."
 *
 * Unlike mcp-parity.test.ts (manifest ↔ wire), this suite drives BOTH surfaces
 * — the real `node dist/index.js` CLI and the real MCP server over HTTP —
 * against the same throwaway workspace and compares observable state:
 *
 *  1. cliRef validity — every manifest cliRef flag must exist in the REAL
 *     `--help` output of the command it names (drift.test.ts only checks the
 *     flags start with `--`, so a stale cliRef passes there silently).
 *  2. Review-gate parity — REVIEW_COMMENT_REQUIRED, COMMIT_MESSAGE_REQUIRED
 *     and VERIFY_REQUIRED must fire on both surfaces with the same code and
 *     leave the task untouched on both.
 *  3. Verify semantics — `vibeflow verify` collects evidence and writes NO
 *     verdict; `--set-verify cannot` and `setVerify:"cannot"` both leave
 *     `verified` absent on disk.
 *  4. State round-trip — a task created through one surface is readable and
 *     editable through the other with identical data.
 *  5. Id-prefix resolution — `tasks --get <prefix>` and `get_task {id:<prefix>}`
 *     must resolve the SAME task. The expression lived inlined in the CLI only,
 *     so the MCP path was exact-match while the CLI accepted any prefix.
 *  6. push stays offline — `push_tasks {dryRun:true}` and `push --dry-run`
 *     must not require network/credentials.
 *
 * Known divergences are PINNED (asserted as they behave today) with flip
 * notes, following the existing e2e convention. The full findings list lives
 * in the linked task, not here.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, globSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { manifest } from "../../src/mcp/manifest.js";
import {
  bootMcpServer,
  newClient,
  initialize,
  callTool,
  assertJsonTextContent,
  runCli,
  seedGitUser,
  type McpClient,
  type McpTestEnv,
} from "./mcp-helpers.js";

const CLI_PKG_VERSION = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
).version as string;

// ── shared workspace helpers ────────────────────────────────────────────────

function readTaskFromDisk(projectDir: string, taskId: string): any {
  const flat = join(projectDir, ".vibeflow", "tasks", `${taskId}.json`);
  if (existsSync(flat)) return JSON.parse(readFileSync(flat, "utf-8"));
  const matches = globSync(
    join(projectDir, ".vibeflow", "tasks", "*", `${taskId}.json`),
  );
  expect(matches.length, `task file for ${taskId} not found`).toBeGreaterThan(0);
  return JSON.parse(readFileSync(matches[0], "utf-8"));
}

function writeSettings(projectDir: string, settings: Record<string, unknown>): void {
  const dir = join(projectDir, ".vibeflow");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify(settings, null, 2));
}

/** Call a tool and return the parsed JSON text payload (data or error envelope). */
async function callJson(
  client: McpClient,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  return assertJsonTextContent(await callTool(client, name, args));
}

// ═══ 1. cliRef ↔ real CLI surface ═════════════════════════════════════════

describe("manifest cliRef vs real CLI surface", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mcp-parity-home-"));
  });

  afterEach(() => {
    // home is a throwaway dir with no processes
  });

  it("every cliRef flag exists in the real command's --help", async () => {
    const commands = [...new Set(manifest.map((m) => m.cliRef.command))];
    const helpByCommand: Record<string, string> = {};
    for (const cmd of commands) {
      const res = await runCli([cmd, "--help"], {
        cwd: home,
        home,
      });
      expect(res.code, `${cmd} --help failed: ${res.stderr}`).toBe(0);
      helpByCommand[cmd] = res.stdout;
    }
    for (const tool of manifest) {
      const help = helpByCommand[tool.cliRef.command];
      expect(help, `no help for ${tool.cliRef.command}`).toBeTruthy();
      for (const flag of tool.cliRef.flags) {
        expect(
          help,
          `stale cliRef: ${tool.name} references ${tool.cliRef.command} ${flag}, which does not exist in its --help output`,
        ).toContain(flag);
      }
    }
  });

  it("serverInfo.version equals the package.json version", async () => {
    // src/mcp/server.ts advertises CLI_VERSION (src/version.ts), the
    // build-time define from packages/cli/package.json. A release that
    // forgets the define, or a re-hardcode of "0.1.0", fails here.
    const env = await bootMcpServer();
    try {
      const client = newClient(env.mcpUrl);
      const res = await initialize(client);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result.serverInfo.version).toBe(CLI_PKG_VERSION);
    } finally {
      await env.cleanup();
    }
  });

  it("bare `tasks --comment <text>` is rejected with E_USAGE instead of silently no-oping", async () => {
    // add_comment's cliRef names the working form (--edit + --comment). The
    // bare form used to exit 0 and change nothing — a silent no-op the MCP
    // surface does not share. It is now a hard usage error on the CLI side.
    const projectDir = mkdtempSync(join(tmpdir(), "mcp-parity-comment-"));
    seedGitUser(projectDir);
    const created = JSON.parse(
      (
        await runCli(
          ["tasks", "--add", "--title", "comment target", "--json"],
          { cwd: projectDir, home },
        )
      ).stdout,
    );
    const taskId = created.task.id;
    const before = readTaskFromDisk(projectDir, taskId).comments ?? [];

    const res = await runCli(
      ["tasks", "--comment", "rejected bare --comment", "--json"],
      { cwd: projectDir, home },
    );
    expect(res.code).toBe(2);
    const envelope = JSON.parse(res.stderr);
    expect(envelope.error.code).toBe("E_USAGE");
    expect(envelope.error.message).toContain("--comment requires --edit");
    // Nothing landed on disk — the old behaviour was a silent no-op.
    const after = readTaskFromDisk(projectDir, taskId).comments ?? [];
    expect(after.length).toBe(before.length);
    expect(JSON.stringify(after)).not.toContain("rejected bare --comment");
  });
});

// ═══ 2. review-gate parity (the sharp one) ════════════════════════════════

describe("review-gate parity — CLI vs MCP on the same workspace", () => {
  let env: McpTestEnv;
  let client: McpClient;
  let home: string;

  beforeEach(async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "mcp-parity-gate-"));
    seedGitUser(projectDir);
    env = await bootMcpServer(projectDir);
    client = newClient(env.mcpUrl);
    await initialize(client);
    home = mkdtempSync(join(tmpdir(), "mcp-parity-gate-home-"));
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("gate 1: review without comment — BOTH surfaces refuse, task untouched", async () => {
    const task = await callJson(client, "create_task", { title: "gate parity" });

    // MCP side
    const mcpRes = await callJson(client, "update_task", {
      id: task.id,
      status: "review",
    });
    expect(mcpRes.error.code).toBe("REVIEW_COMMENT_REQUIRED");
    expect(readTaskFromDisk(env.projectDir, task.id).status).not.toBe("review");

    // CLI side — same task, same workspace
    const cliRes = await runCli(
      ["tasks", "--edit", task.id, "--set-status", "review"],
      { cwd: env.projectDir, home },
    );
    expect(cliRes.code).toBe(2);
    expect(cliRes.stdout).toMatch(/comment is required/i);
    expect(readTaskFromDisk(env.projectDir, task.id).status).not.toBe("review");

    // Both succeed with a comment → same resulting state
    const mcpOk = await callJson(client, "update_task", {
      id: task.id,
      status: "review",
      comment: "Report: parity proof",
    });
    expect(mcpOk.status).toBe("review");
    const onDisk = readTaskFromDisk(env.projectDir, task.id);
    expect(onDisk.status).toBe("review");
    expect(
      (onDisk.comments ?? []).some((c: any) =>
        (c.text ?? "").includes("parity proof"),
      ),
    ).toBe(true);
  });

  it("gate 2: auto-commit ON, no commit message — BOTH surfaces refuse COMMIT_MESSAGE_REQUIRED", async () => {
    const task = await callJson(client, "create_task", { title: "autocommit gate" });
    writeSettings(env.projectDir, { autoCommit: true });

    // MCP side
    const mcpRes = await callJson(client, "update_task", {
      id: task.id,
      status: "review",
      comment: "did the work",
    });
    expect(mcpRes.error.code).toBe("COMMIT_MESSAGE_REQUIRED");
    expect(readTaskFromDisk(env.projectDir, task.id).status).not.toBe("review");

    // CLI side
    const cliRes = await runCli(
      [
        "tasks",
        "--edit",
        task.id,
        "--set-status",
        "review",
        "--comment",
        "did the work",
      ],
      { cwd: env.projectDir, home },
    );
    expect(cliRes.code).toBe(2);
    expect(cliRes.stdout).toMatch(/commit-message is required/i);
    expect(readTaskFromDisk(env.projectDir, task.id).status).not.toBe("review");
  });

  it("gate 3: annotated task + requireVerifyBeforeReview — BOTH surfaces demand a verdict", async () => {
    const task = await callJson(client, "create_task", { title: "annotated gate" });
    // Seed an annotation (selector + url) directly — seeding only
    const file = globSync(
      join(env.projectDir, ".vibeflow", "tasks", "*", `${task.id}.json`),
    )[0];
    const raw = JSON.parse(readFileSync(file, "utf-8"));
    raw.selector = "#main";
    raw.url = "http://127.0.0.1:9/";
    writeFileSync(file, JSON.stringify(raw, null, 2));
    writeSettings(env.projectDir, { requireVerifyBeforeReview: true });

    // MCP side — comment present but NO verdict → refuse
    const mcpRes = await callJson(client, "update_task", {
      id: task.id,
      status: "review",
      comment: "looks done",
    });
    expect(mcpRes.error.code).toBe("VERIFY_REQUIRED");
    expect(readTaskFromDisk(env.projectDir, task.id).status).not.toBe("review");

    // CLI side — same refusal wording
    const cliRes = await runCli(
      [
        "tasks",
        "--edit",
        task.id,
        "--set-status",
        "review",
        "--comment",
        "looks done",
      ],
      { cwd: env.projectDir, home },
    );
    expect(cliRes.code).toBe(2);
    expect(cliRes.stdout).toMatch(/verification verdict/i);
    expect(readTaskFromDisk(env.projectDir, task.id).status).not.toBe("review");

    // MCP with the verdict on the transition → allowed
    const mcpOk = await callJson(client, "update_task", {
      id: task.id,
      status: "review",
      comment: "looks done",
      setVerify: "pass",
    });
    expect(mcpOk.status).toBe("review");
    expect(readTaskFromDisk(env.projectDir, task.id).verified).toBe(true);
  });
});

// ═══ 3. verify + verdict semantics ════════════════════════════════════════

describe("verify/verdict parity — CLI vs MCP", () => {
  let env: McpTestEnv;
  let client: McpClient;
  let home: string;

  beforeEach(async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "mcp-parity-verify-"));
    seedGitUser(projectDir);
    env = await bootMcpServer(projectDir);
    client = newClient(env.mcpUrl);
    await initialize(client);
    home = mkdtempSync(join(tmpdir(), "mcp-parity-verify-home-"));
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("verify without baseline: CLI exits 1 E_NO_BASELINE, MCP returns E_NO_BASELINE — neither writes a verdict", async () => {
    const task = await callJson(client, "create_task", { title: "verify parity" });

    const cliRes = await runCli(
      ["verify", task.id, "--json"],
      { cwd: env.projectDir, home },
    );
    expect(cliRes.code).toBe(1);
    // The VerifyError envelope is machine-consumed from stderr
    // (commands/verify.ts writes it there); stdout must stay clean.
    expect(cliRes.stderr).toContain("E_NO_BASELINE");
    expect(cliRes.stdout).not.toContain("E_NO_BASELINE");

    const mcpRes = await callJson(client, "verify_task", { id: task.id });
    expect(mcpRes.error.code).toBe("E_NO_BASELINE");

    // Parity: `vibeflow verify` never writes `verified`; neither does the tool
    expect(readTaskFromDisk(env.projectDir, task.id).verified).toBeUndefined();
  });

  it("--set-verify cannot and setVerify:'cannot' both leave verified absent", async () => {
    const t1 = await callJson(client, "create_task", { title: "cli cannot" });
    const t2 = await callJson(client, "create_task", { title: "mcp cannot" });

    const cliRes = await runCli(
      [
        "tasks",
        "--edit",
        t1.id,
        "--set-verify",
        "cannot",
        "--verify-reason",
        "no environment",
      ],
      { cwd: env.projectDir, home },
    );
    expect(cliRes.code).toBe(0);

    const mcpRes = await callJson(client, "update_task", {
      id: t2.id,
      setVerify: "cannot",
      verifyReason: "no environment",
    });
    expect(mcpRes.error).toBeUndefined();

    expect(readTaskFromDisk(env.projectDir, t1.id).verified).toBeUndefined();
    expect(readTaskFromDisk(env.projectDir, t2.id).verified).toBeUndefined();
  });
});

// ═══ 4. state round-trip across surfaces ══════════════════════════════════

describe("state round-trip — CLI-created ↔ MCP-created", () => {
  let env: McpTestEnv;
  let client: McpClient;
  let home: string;

  beforeEach(async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "mcp-parity-trip-"));
    seedGitUser(projectDir);
    env = await bootMcpServer(projectDir);
    client = newClient(env.mcpUrl);
    await initialize(client);
    home = mkdtempSync(join(tmpdir(), "mcp-parity-trip-home-"));
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("CLI --add → MCP get_task/list_tasks; MCP create → CLI --get --json; edits cross over", async () => {
    // 1. CLI creates, MCP reads
    const cliAdd = JSON.parse(
      (
        await runCli(
          ["tasks", "--add", "--title", "made by CLI", "--json"],
          { cwd: env.projectDir, home },
        )
      ).stdout,
    );
    const cliTaskId = cliAdd.task.id as string;
    const viaMcp = await callJson(client, "get_task", { id: cliTaskId });
    expect(viaMcp.title).toBe("made by CLI");
    expect(viaMcp.status).toBe(cliAdd.task.status);

    const listed = await callJson(client, "list_tasks", { limit: 0 });
    expect(listed.tasks.map((t: any) => t.id)).toContain(cliTaskId);

    // 2. MCP creates, CLI reads
    const mcpTask = await callJson(client, "create_task", {
      title: "made by MCP",
      description: "created over the wire",
    });
    const cliGet = await runCli(
      ["tasks", "--get", mcpTask.id, "--json"],
      { cwd: env.projectDir, home },
    );
    expect(cliGet.code).toBe(0);
    const parsed = JSON.parse(cliGet.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.task.title).toBe("made by MCP");
    expect(parsed.task.description).toBe("created over the wire");

    // 3. CLI edits → MCP sees it
    const cliEdit = await runCli(
      ["tasks", "--edit", mcpTask.id, "--title", "renamed by CLI"],
      { cwd: env.projectDir, home },
    );
    expect(cliEdit.code).toBe(0);
    const seenByMcp = await callJson(client, "get_task", { id: mcpTask.id });
    expect(seenByMcp.title).toBe("renamed by CLI");

    // 4. MCP edits → CLI sees it
    const mcpEdit = await callJson(client, "update_task", {
      id: cliTaskId,
      description: "described by MCP",
    });
    expect(mcpEdit.description).toBe("described by MCP");
    const seenByCli = await runCli(
      ["tasks", "--get", cliTaskId, "--json"],
      { cwd: env.projectDir, home },
    );
    expect(JSON.parse(seenByCli.stdout).task.description).toBe("described by MCP");
  });

  it("prefix resolution parity: `tasks --get <prefix>` and `get_task {id:<prefix>}` name the same task", async () => {
    const created = await callJson(client, "create_task", {
      title: "prefix resolution",
    });
    const fullId: string = created.id;
    expect(fullId.length).toBeGreaterThan(8);
    const prefix = fullId.slice(0, 8);

    // MCP: a prefix resolves to the full task (it used to be TASK_NOT_FOUND).
    const viaMcp = await callJson(client, "get_task", { id: prefix });
    expect(viaMcp.id).toBe(fullId);

    // CLI: the same prefix, same workspace, same task.
    const viaCli = await runCli(
      ["tasks", "--get", prefix, "--json"],
      { cwd: env.projectDir, home },
    );
    expect(viaCli.code).toBe(0);
    expect(JSON.parse(viaCli.stdout).task.id).toBe(viaMcp.id);

    // And a prefix matching nothing is still a clean miss on both surfaces.
    const miss = await callJson(client, "get_task", { id: "zzzzzzzz" });
    expect(miss.error.code).toBe("TASK_NOT_FOUND");
    const missCli = await runCli(
      ["tasks", "--get", "zzzzzzzz", "--json"],
      { cwd: env.projectDir, home },
    );
    expect(missCli.code).not.toBe(0);
  });

  it("push stays offline on both surfaces (dry-run, no credentials)", async () => {
    // push_tasks: dryRun input guarantees no SaaS call regardless of mode.
    const mcpRes = await callTool(client, "push_tasks", { dryRun: true });
    expect(mcpRes.status).toBe(200);
    const body = await mcpRes.json();
    expect(body.error).toBeUndefined();
    const text = body.result?.content?.[0]?.text;
    expect(typeof text).toBe("string");
    expect(() => JSON.parse(text as string)).not.toThrow();

    const cliRes = await runCli(["push", "--dry-run"], {
      cwd: env.projectDir,
      home,
    });
    expect(cliRes.code).toBe(0);
  });
});

// ═══ 7. SEMANTIC parity — the same operation, the same result ══════════════
//
// Sections 1-6 and gates G1/G5 all compare NAMES. This section compares
// OUTCOMES, because names are exactly how the link divergence shipped:
// `--set-parent` exists, `links` exists, every gate was green, and one
// surface could delete a parent the other could never touch.
//
// The claim under test: for every capability both surfaces expose, driving the
// CLI and driving MCP from identical starting state must leave identical task
// state on disk. Divergence fails loudly here instead of being discovered by
// a user's agent in production.

describe("semantic parity — CLI and MCP produce the same state", () => {
  let env: McpTestEnv;
  let client: McpClient;
  let home: string;

  beforeEach(async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "mcp-sem-"));
    seedGitUser(projectDir);
    env = await bootMcpServer(projectDir);
    client = newClient(env.mcpUrl);
    await initialize(client);
    home = mkdtempSync(join(tmpdir(), "mcp-sem-home-"));
  });

  afterEach(async () => {
    await env.cleanup();
  });

  const linksOf = (id: string): Array<{ taskId: string; type: string }> =>
    (readTaskFromDisk(env.projectDir, id).links ??
      []) as Array<{ taskId: string; type: string }>;

  const shape = (l: Array<{ type: string }>) => l.map((x) => x.type).sort();

  /**
   * The SAME starting state on both sides: a subject parented to p1, plus a
   * bystander `relates` link that neither operation under test names. If a
   * surface drops the bystander, it diverges — which is the whole point.
   */
  async function seedIdentical(): Promise<{
    p1: string;
    p2: string;
    other: string;
    task: string;
  }> {
    const p1 = (await callJson(client, "create_task", { title: "parent one" })).id;
    const p2 = (await callJson(client, "create_task", { title: "parent two" })).id;
    const other = (await callJson(client, "create_task", { title: "bystander" })).id;
    const task = (
      await callJson(client, "create_task", { title: "subject", parent: p1 })
    ).id;
    await callJson(client, "update_task", {
      id: task,
      addLinks: [{ taskId: other, type: "relates" }],
    });
    return { p1, p2, other, task };
  }

  it("parent swap: CLI --set-parent/--no-parent ≡ MCP addLinks/removeLinks", async () => {
    // ── CLI side ────────────────────────────────────────────────────────
    const cli = await seedIdentical();
    const cleared = await runCli(
      ["tasks", "--edit", cli.task, "--no-parent", "--json"],
      { cwd: env.projectDir, home },
    );
    expect(cleared.code, cleared.stderr).toBe(0);
    const swapped = await runCli(
      ["tasks", "--edit", cli.task, "--set-parent", cli.p2, "--json"],
      { cwd: env.projectDir, home },
    );
    expect(swapped.code, swapped.stderr).toBe(0);

    // ── MCP side, identical starting state ──────────────────────────────
    const mcp = await seedIdentical();
    await callJson(client, "update_task", {
      id: mcp.task,
      removeLinks: [{ taskId: mcp.p1, type: "parent" }],
    });
    await callJson(client, "update_task", {
      id: mcp.task,
      addLinks: [{ taskId: mcp.p2, type: "parent" }],
    });

    // Same parent on both…
    expect(linksOf(cli.task)).toContainEqual({ taskId: cli.p2, type: "parent" });
    expect(linksOf(mcp.task)).toContainEqual({ taskId: mcp.p2, type: "parent" });
    expect(linksOf(cli.task)).not.toContainEqual({ taskId: cli.p1, type: "parent" });
    expect(linksOf(mcp.task)).not.toContainEqual({ taskId: mcp.p1, type: "parent" });

    // …and the bystander `relates` link survived on BOTH. That is the
    // guarantee --set-parent gives and `links` does not.
    expect(linksOf(cli.task)).toContainEqual({ taskId: cli.other, type: "relates" });
    expect(linksOf(mcp.task)).toContainEqual({ taskId: mcp.other, type: "relates" });

    // Structurally identical, not merely "both non-empty".
    expect(shape(linksOf(mcp.task))).toEqual(shape(linksOf(cli.task)));
  });

  it("DIVERGENCE, now CLOSED: MCP `links` preserves what --set-parent preserves", async () => {
    // This test used to PIN the divergence: `links` had REPLACE semantics, so
    // sending one link dropped the parent, and it asserted that as intended
    // behaviour. It now asserts the two surfaces AGREE, which is the fix.
    //
    // The name keeps "DIVERGENCE" so the history stays greppable from a bug
    // report that predates the fix.
    const p1 = (await callJson(client, "create_task", { title: "p1" })).id;
    const other = (await callJson(client, "create_task", { title: "other" })).id;
    const task = (
      await callJson(client, "create_task", { title: "t", parent: p1 })
    ).id;
    await callJson(client, "update_task", {
      id: task,
      addLinks: [{ taskId: other, type: "relates" }],
    });
    expect(linksOf(task)).toHaveLength(2);

    // `links` with ONE entry: the parent is PRESERVED. An agent can no longer
    // destroy a link by sending an incomplete update.
    await callJson(client, "update_task", {
      id: task,
      links: [{ taskId: other, type: "relates" }],
    });
    expect(linksOf(task)).toContainEqual({ taskId: p1, type: "parent" });
    expect(linksOf(task)).toHaveLength(2);

    // And the CLI agrees, because it always did.
    const cliTask = (
      await callJson(client, "create_task", { title: "cli", parent: p1 })
    ).id;
    const cliRes = await runCli(
      ["tasks", "--edit", cliTask, "--relates", other, "--json"],
      { cwd: env.projectDir, home },
    );
    expect(cliRes.code, cliRes.stderr).toBe(0);
    expect(shape(linksOf(task)).sort()).toEqual(shape(linksOf(cliTask)).sort());
  });

  it("refusal parity: a cycle is refused on both surfaces and neither writes", async () => {
    const root = (await callJson(client, "create_task", { title: "root" })).id;
    const mid = (
      await callJson(client, "create_task", { title: "mid", parent: root })
    ).id;
    const leaf = (
      await callJson(client, "create_task", { title: "leaf", parent: mid })
    ).id;

    // MCP: root -> leaf would make leaf its own ancestor.
    const mcp = await callJson(client, "update_task", {
      id: root,
      addLinks: [{ taskId: leaf, type: "parent" }],
    });
    expect(mcp.ok).toBe(false);

    // CLI: the same illegal shape, and it must not write either.
    const cli = await runCli(
      ["tasks", "--edit", root, "--set-parent", leaf, "--json"],
      { cwd: env.projectDir, home },
    );
    expect(cli.code).not.toBe(0);

    // Neither surface mutated anything on refusal.
    expect(linksOf(root)).toEqual([]);
    expect(linksOf(mid)).toEqual([{ taskId: root, type: "parent" }]);
    expect(linksOf(leaf)).toEqual([{ taskId: mid, type: "parent" }]);
  });

  it("idempotence parity: re-adding an existing link is a no-op", async () => {
    const parent = (await callJson(client, "create_task", { title: "p" })).id;
    const task = (
      await callJson(client, "create_task", { title: "t", parent })
    ).id;

    for (let i = 0; i < 3; i++) {
      await callJson(client, "update_task", {
        id: task,
        addLinks: [{ taskId: parent, type: "parent" }],
      });
    }
    // Three identical adds, still exactly one link.
    expect(linksOf(task)).toEqual([{ taskId: parent, type: "parent" }]);
  });

  it("CLI --relates/--blocks/--unrelates ≡ MCP addLinks/removeLinks", async () => {
    // The parity fix that closed the last real capability gap: relates and
    // blocks were settable ONLY over MCP. Both surfaces now go through
    // buildAddLinks/buildRemoveLinks, so they must agree exactly — including
    // on the parent that neither side named.
    const p = (await callJson(client, "create_task", { title: "p" })).id;
    const b = (await callJson(client, "create_task", { title: "b" })).id;
    const cliTask = (
      await callJson(client, "create_task", { title: "cli side", parent: p })
    ).id;
    const mcpTask = (
      await callJson(client, "create_task", { title: "mcp side", parent: p })
    ).id;

    // CLI: add both types to the same target in one call.
    const cliAdd = await runCli(
      ["tasks", "--edit", cliTask, "--relates", b, "--blocks", b, "--json"],
      { cwd: env.projectDir, home },
    );
    expect(cliAdd.code, cliAdd.stderr).toBe(0);

    // MCP: the same two links as one addLinks array.
    await callJson(client, "update_task", {
      id: mcpTask,
      addLinks: [
        { taskId: b, type: "relates" },
        { taskId: b, type: "blocks" },
      ],
    });

    // Same link SET, including the untouched parent — and two types to one
    // target stay distinct on both.
    expect(shape(linksOf(cliTask)).sort()).toEqual(
      shape(linksOf(mcpTask)).sort(),
    );
    for (const id of [cliTask, mcpTask]) {
      expect(linksOf(id)).toContainEqual({ taskId: p, type: "parent" });
      expect(linksOf(id)).toContainEqual({ taskId: b, type: "relates" });
      expect(linksOf(id)).toContainEqual({ taskId: b, type: "blocks" });
      expect(linksOf(id)).toHaveLength(3);
    }

    // Removal is surgical on the CLI too, and agrees with MCP.
    const cliRm = await runCli(
      ["tasks", "--edit", cliTask, "--unrelates", b, "--json"],
      { cwd: env.projectDir, home },
    );
    expect(cliRm.code, cliRm.stderr).toBe(0);
    await callJson(client, "update_task", {
      id: mcpTask,
      removeLinks: [{ taskId: b, type: "relates" }],
    });

    expect(shape(linksOf(cliTask)).sort()).toEqual(
      shape(linksOf(mcpTask)).sort(),
    );
    expect(linksOf(cliTask)).toContainEqual({ taskId: p, type: "parent" });
    expect(linksOf(mcpTask)).toContainEqual({ taskId: p, type: "parent" });
    expect(linksOf(cliTask)).not.toContainEqual({ taskId: b, type: "relates" });
    expect(linksOf(mcpTask)).not.toContainEqual({ taskId: b, type: "relates" });

    // Re-adding is idempotent on the CLI, exactly as on MCP.
    await runCli(["tasks", "--edit", cliTask, "--blocks", b, "--json"], {
      cwd: env.projectDir,
      home,
    });
    await runCli(["tasks", "--edit", cliTask, "--blocks", b, "--json"], {
      cwd: env.projectDir,
      home,
    });
    expect(
      linksOf(cliTask).filter((l) => l.type === "blocks"),
    ).toHaveLength(1);
  });

  it("CLI refuses an unknown link target with the same code MCP does", async () => {
    const task = (await callJson(client, "create_task", { title: "t" })).id;

    const cli = await runCli(
      ["tasks", "--edit", task, "--relates", "deadbeefdeadbeef", "--json"],
      { cwd: env.projectDir, home },
    );
    expect(cli.code).not.toBe(0);
    // The refusal envelope lands on stderr (stdout carries protocol/human
    // output only), so read whichever stream carries it rather than assuming.
    const envelope = JSON.parse(
      (cli.stdout?.trim() || cli.stderr?.trim() || "").split("\n").pop()!,
    );
    const cliCode = envelope.error?.code ?? envelope.code;
    expect(cliCode).toBe("TASK_NOT_FOUND");

    // Same refusal, same code, on the MCP side.
    const mcp = await callJson(client, "update_task", {
      id: task,
      addLinks: [{ taskId: "deadbeefdeadbeef", type: "relates" }],
    });
    expect(mcp.ok).toBe(false);
    expect(mcp.error.code).toBe("TASK_NOT_FOUND");

    // Neither wrote anything.
    expect(linksOf(task)).toEqual([]);
  });
});
