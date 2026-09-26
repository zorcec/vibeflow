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
 *  5. push stays offline — `push_tasks {dryRun:true}` and `push --dry-run`
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

  it("PINNED divergence: serverInfo.version (0.1.0) != package version — flip when fixed", async () => {
    // src/mcp/server.ts hardcodes version: "0.1.0"; the CLI package is
    // CLI_PKG_VERSION. Ticket 94c12ebe fixed this for the web-crawl MCP only.
    const env = await bootMcpServer();
    try {
      const client = newClient(env.mcpUrl);
      const res = await initialize(client);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.result.serverInfo.version).toBe("0.1.0");
      expect(body.result.serverInfo.version).not.toBe(CLI_PKG_VERSION);
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
    expect(mcpRes.error).toBe("REVIEW_COMMENT_REQUIRED");
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
    expect(mcpRes.error).toBe("COMMIT_MESSAGE_REQUIRED");
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
    expect(mcpRes.error).toBe("VERIFY_REQUIRED");
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
    expect(mcpRes.error).toBe("E_NO_BASELINE");

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
    expect(parsed.title).toBe("made by MCP");
    expect(parsed.description).toBe("created over the wire");

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
    expect(JSON.parse(seenByCli.stdout).description).toBe("described by MCP");
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
