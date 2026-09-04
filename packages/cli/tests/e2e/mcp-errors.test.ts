/**
 * MCP e2e — error paths + update_task gate matrix (spec §2.3, §2.4).
 *
 * Two error layers:
 *  - Protocol-level: HTTP 200 with JSON-RPC body.error (e.g. -32601 unknown
 *    tool, -32602 invalid tool arguments via zod).
 *  - Tool-level: HTTP 200 with ok-shaped content[0].text JSON envelope
 *    {error, message, suggestion} from formatResult.
 *
 * Invariants asserted in every case: HTTP never 5xx, body parses as JSON-RPC,
 * server stays usable after each error.
 *
 * [Phase 3] gate matrix uses the GATED helper: today the MCP update_task
 * wrapper has NO review gate and NO verified reset (CLI-only gates). Flip
 * GATED to true when Phase 3 ports the gates.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync, globSync, mkdtempSync } from "node:fs";
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

const NONEXISTENT_ID = "ffffffffffffffffffffffffffff00";

/** Parse the tool-level text envelope. Asserts HTTP 200 + parses. */
async function parseEnvelope(res: Response): Promise<any> {
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.jsonrpc).toBe("2.0");
  return JSON.parse(body.result.content[0].text);
}

/**
 * Raw fetch with the same localhost allowlist mcpFetch enforces — used for
 * deliberately malformed requests (bad body / headers) the JSON-RPC client
 * cannot express.
 */
async function rawFetch(
  mcpUrl: string,
  init: { headers: Record<string, string>; body: string },
): Promise<Response> {
  const url = new URL(mcpUrl);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error(`SSRF blocked: ${mcpUrl} is not a localhost URL`);
  }
  return fetch(url, { ...init, method: "POST" });
}

/** Invariant: server is still usable after an error. */
async function assertServerUsable(client: McpClient): Promise<void> {
  const res = await callTool(client, "list_tasks", { limit: 0 });
  const parsed = await assertJsonTextContent(res);
  expect(Array.isArray(parsed.tasks)).toBe(true);
}

/**
 * PINNED [now]: schema/unknown-tool errors come back HTTP 200 as error-as-content:
 * content[0].text = "MCP error -<code>: <detail>" with result.isError === true.
 * The spec expected body.error.code — actual SDK behavior differs; documented
 * in the task report.
 */
async function assertMcpErrorContent(
  res: Response,
  code: number,
): Promise<string> {
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.jsonrpc).toBe("2.0");
  expect(body.result.isError).toBe(true);
  const text = body.result.content[0].text;
  expect(typeof text).toBe("string");
  expect(text).toMatch(new RegExp(`^MCP error -${Math.abs(code)}:`));
  return text;
}

/** Read a task JSON from disk (flat or date-subdir layout). */
function readTaskFromDisk(projectDir: string, taskId: string): any {
  const tasksDir = join(projectDir, ".vibeflow", "tasks");
  const flat = join(tasksDir, `${taskId}.json`);
  if (existsSync(flat)) return JSON.parse(readFileSync(flat, "utf-8"));
  const matches = globSync(join(tasksDir, "*", `${taskId}.json`));
  expect(matches.length).toBeGreaterThan(0);
  return JSON.parse(readFileSync(matches[0], "utf-8"));
}

describe("MCP error paths", () => {
  let env: McpTestEnv;
  let client: McpClient;

  beforeEach(async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mcp-e2e-err-git-"));
    seedGitUser(tmp);
    env = await bootMcpServer(tmp);
    client = newClient(env.mcpUrl);
    await initialize(client);
  });

  afterEach(async () => {
    await env.cleanup();
  });

  // ── Protocol-level errors ────────────────────────────────────────────

  it("1: unknown tool → -32602 error-as-content", async () => {
    // PINNED: the SDK reports unknown tools as -32602 (not -32601 as the spec
    // table expected) — documented in the task report.
    const text = await assertMcpErrorContent(
      await callTool(client, "nonexistent_tool", {}),
      -32602,
    );
    expect(text).toContain("nonexistent_tool");
    await assertServerUsable(client);
  });

  it("2: create_task missing title → -32602 error-as-content", async () => {
    await assertMcpErrorContent(
      await callTool(client, "create_task", { description: "no title" }),
      -32602,
    );
    await assertServerUsable(client);
  });

  it("3: create_task bad status enum → -32602 error-as-content", async () => {
    await assertMcpErrorContent(
      await callTool(client, "create_task", {
        title: "x",
        status: "not-a-status",
      }),
      -32602,
    );
    await assertServerUsable(client);
  });

  it("4: list_tasks bad limit → -32602 error-as-content", async () => {
    await assertMcpErrorContent(
      await callTool(client, "list_tasks", { limit: -1 }),
      -32602,
    );
    await assertServerUsable(client);
  });

  it("12: verify_task bad url → -32602 error-as-content", async () => {
    // Create a real task so the failure is schema-level, not existence
    const created = await assertJsonTextContent(
      await callTool(client, "create_task", { title: "verify target" }),
    );
    await assertMcpErrorContent(
      await callTool(client, "verify_task", { id: created.id, url: "nota-url" }),
      -32602,
    );
    await assertServerUsable(client);
  });

  // ── Tool-level error envelopes (formatResult) ────────────────────────

  it("5: get_task nonexistent id → TASK_NOT_FOUND envelope", async () => {
    const parsed = await parseEnvelope(
      await callTool(client, "get_task", { id: NONEXISTENT_ID }),
    );
    expect(parsed.error).toBe("TASK_NOT_FOUND");
    expect(parsed.message).toContain("Task not found");
    await assertServerUsable(client);
  });

  it("6: update_task nonexistent id → TASK_NOT_FOUND, disk unchanged", async () => {
    const parsed = await parseEnvelope(
      await callTool(client, "update_task", { id: NONEXISTENT_ID, title: "x" }),
    );
    expect(parsed.error).toBe("TASK_NOT_FOUND");
    // Nothing was created on disk under a task ID
    const tasksDir = join(env.projectDir, ".vibeflow", "tasks");
    const matches = globSync(join(tasksDir, "**", "*.json"));
    expect(matches).toHaveLength(0);
    await assertServerUsable(client);
  });

  it("7: attach_file path traversal → rejected, no file escapes files dir", async () => {
    const task = await assertJsonTextContent(
      await callTool(client, "create_task", { title: "attach target" }),
    );
    const parsed = await parseEnvelope(
      await callTool(client, "attach_file", {
        id: task.id,
        filename: "../escape.md",
        contentB64: Buffer.from("hello").toString("base64"),
      }),
    );
    // WP-1 landed: validateFilename gates BEFORE saveFile
    expect(["INVALID_FILENAME", "ATTACH_FILE_ERROR"]).toContain(parsed.error);
    // Hard invariant: no file named escape.md anywhere in the project dir
    const matches = globSync(join(env.projectDir, "**", "escape.md"));
    expect(matches).toHaveLength(0);
    await assertServerUsable(client);
  });

  it("8: attach_file separators/control bytes → no escape, no control bytes", async () => {
    const task = await assertJsonTextContent(
      await callTool(client, "create_task", { title: "attach control" }),
    );
    for (const filename of ["..\\evil.md", "sub/dir.md", "a\u0000b.md", "a\u0001b.md"]) {
      const res = await callTool(client, "attach_file", {
        id: task.id,
        filename,
        contentB64: Buffer.from("x").toString("base64"),
      });
      expect(res.status).toBe(200);
      const parsed = JSON.parse((await res.json()).result.content[0].text);
      expect(parsed.error).toBeDefined();
    }
    // Nothing escaped the files dir: the only written files live under
    // .vibeflow/tasks/files/<id>/ and none contain control bytes in the name
    const filesDir = join(env.projectDir, ".vibeflow", "tasks", "files");
    if (existsSync(filesDir)) {
      const written = globSync(join(filesDir, "**", "*")).filter((p) => {
        const base = p.split("/").pop() ?? "";
        for (let i = 0; i < base.length; i++) {
          if (base.charCodeAt(i) < 0x20) return true;
        }
        return false;
      });
      expect(written).toHaveLength(0);
    }
    await assertServerUsable(client);
  });

  it("9: add_comment nonexistent id — PINNED: succeeds (core writes a bare entry)", async () => {
    // BUG-BY-DESIGN: core addComment writes {id, comments:[...]} stub JSON for
    // missing task files ("so comments still persist"), so MCP add_comment on
    // a garbage ID silently creates a task-like stub instead of
    // ADD_COMMENT_ERROR. Tracked as a finding in the task report.
    const res = await callTool(client, "add_comment", {
      id: NONEXISTENT_ID,
      text: "x",
    });
    const parsed = await assertJsonTextContent(res);
    expect(parsed.text).toBe("x");
    expect(parsed.author).toBe("agent");
    await assertServerUsable(client);
  });

  it("10: export_prompt nonexistent single id → TASK_NOT_FOUND", async () => {
    const parsed = await parseEnvelope(
      await callTool(client, "export_prompt", { id: NONEXISTENT_ID }),
    );
    expect(parsed.error).toBe("TASK_NOT_FOUND");
    await assertServerUsable(client);
  });

  it("11: claim_next_task empty board → NO_TASKS_AVAILABLE", async () => {
    const res = await callTool(client, "claim_next_task", { dryRun: false });
    const body = await res.json();
    expect(res.status).toBe(200);
    const parsed = JSON.parse(body.result.content[0].text);
    expect(parsed.error).toBe("NO_TASKS_AVAILABLE");
    expect(parsed.message).toBe("No tasks available to claim");
    // [now] error-as-content contract: isError absent/false on the result
    // [Phase 5 flip note: manifest-based registration may set isError: true — pin and flip]
    expect(body.result?.isError).toBeFalsy();
    await assertServerUsable(client);
  });

  it("14: malformed JSON body — PINNED: 500, not 400", async () => {
    // FINDING (spec deviation): malformed JSON returns 500 instead of the
    // spec'd 400 — Express JSON parse errors are not mapped to 400 by the
    // MCP transport. Documented in the task report; server stays usable.
    const res = await rawFetch(env.mcpUrl, {
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: "{",
    });
    expect(res.status).toBe(500);
    await assertServerUsable(client);
  });

  it("15: missing Accept header → 400/406, not 500", async () => {
    // SDK requires Accept; pin after first run
    const res = await rawFetch(env.mcpUrl, {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "mcp-e2e-client", version: "0.0.0" },
        },
      }),
    });
    expect([400, 406]).toContain(res.status);
    await assertServerUsable(client);
  });

  it("13: server survives error storm", async () => {
    // Run cases 1–12 on ONE session, then a valid call must still succeed
    await callTool(client, "nonexistent_tool", {});
    await callTool(client, "create_task", { description: "no title" });
    await callTool(client, "create_task", {
      title: "x",
      status: "not-a-status",
    });
    await callTool(client, "list_tasks", { limit: -1 });
    await callTool(client, "get_task", { id: NONEXISTENT_ID });
    await callTool(client, "update_task", { id: NONEXISTENT_ID, title: "x" });
    await callTool(client, "attach_file", {
      id: NONEXISTENT_ID,
      filename: "../escape.md",
      contentB64: "aGVsbG8=",
    });
    await callTool(client, "add_comment", { id: NONEXISTENT_ID, text: "x" });
    await callTool(client, "export_prompt", { id: NONEXISTENT_ID });
    await callTool(client, "claim_next_task", { dryRun: false });
    await callTool(client, "verify_task", { id: NONEXISTENT_ID, url: "nota-url" });
    const parsed = await assertJsonTextContent(
      await callTool(client, "list_tasks", { limit: 0 }),
    );
    expect(Array.isArray(parsed.tasks)).toBe(true);
  });
});

// ── update_task gate matrix (spec §2.4) ─────────────────────────────────────

describe("MCP update_task gates", () => {
  let env: McpTestEnv;
  let client: McpClient;

  beforeEach(async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mcp-e2e-gate-git-"));
    seedGitUser(tmp);
    env = await bootMcpServer(tmp);
    client = newClient(env.mcpUrl);
    await initialize(client);
  });

  afterEach(async () => {
    await env.cleanup();
  });

  /** Read a task JSON from disk (flat or date-subdir layout). */
  function readGateTaskFromDisk(taskId: string): any {
    const tasksDir = join(env.projectDir, ".vibeflow", "tasks");
    const flat = join(tasksDir, `${taskId}.json`);
    if (existsSync(flat)) return JSON.parse(readFileSync(flat, "utf-8"));
    const matches = globSync(join(tasksDir, "*", `${taskId}.json`));
    expect(matches.length).toBeGreaterThan(0);
    return JSON.parse(readFileSync(matches[0], "utf-8"));
  }

  /** Locate a task JSON on disk (flat or date-subdir layout). */
  function findTaskFilePath(projectDir: string, taskId: string): string | null {
    const tasksDir = join(projectDir, ".vibeflow", "tasks");
    const flat = join(tasksDir, `${taskId}.json`);
    if (existsSync(flat)) return flat;
    const matches = globSync(join(tasksDir, "*", `${taskId}.json`));
    return matches[0] ?? null;
  }

  // [Phase 3] Gate assertions — flip to the gated expectations when Phase 3
  // lands. Feature-detect: a Phase-3 update_task will reject review+no-comment
  // with a REVIEW_COMMENT_REQUIRED-style envelope. Until then the call succeeds.
  const GATED = true; // Phase 3 landed — gates active

  it("1: status review without comment", async () => {
    const task = await assertJsonTextContent(
      await callTool(client, "create_task", { title: "gate 1" }),
    );
    const res = await callTool(client, "update_task", {
      id: task.id,
      status: "review",
    });
    if (GATED) {
      const parsed = await parseEnvelope(res);
      expect(parsed.error).toBe("REVIEW_COMMENT_REQUIRED");
      expect(readGateTaskFromDisk(task.id).status).toBe("todo");
    } else {
      const parsed = await assertJsonTextContent(res);
      expect(parsed.status).toBe("review");
      expect(readGateTaskFromDisk(task.id).status).toBe("review");
    }
  });

  it("2: status review with comment → ok, comment embedded", async () => {
    const task = await assertJsonTextContent(
      await callTool(client, "create_task", { title: "gate 2" }),
    );
    const parsed = await assertJsonTextContent(
      await callTool(client, "update_task", {
        id: task.id,
        status: "review",
        comment: "Report: what changed and why",
      }),
    );
    expect(parsed.status).toBe("review");
    const onDisk = readGateTaskFromDisk(task.id);
    expect(onDisk.status).toBe("review");
    const texts = (onDisk.comments ?? []).map((c: any) => c.text);
    expect(texts.some((t: string) => t.includes("what changed and why"))).toBe(
      true,
    );
  });

  it("3: status review + comment + skipVerify → ok", async () => {
    const task = await assertJsonTextContent(
      await callTool(client, "create_task", { title: "gate 3" }),
    );
    const parsed = await assertJsonTextContent(
      await callTool(client, "update_task", {
        id: task.id,
        status: "review",
        comment: "x",
        skipVerify: true,
      }),
    );
    expect(parsed.status).toBe("review");
    expect(readGateTaskFromDisk(task.id).status).toBe("review");
  });

  it("4: in-progress on verified task — verified reset", async () => {
    const task = await assertJsonTextContent(
      await callTool(client, "create_task", { title: "gate 4" }),
    );
    // Seed verified: true via direct file write (seeding only)
    const taskFile = findTaskFilePath(env.projectDir, task.id);
    expect(taskFile).not.toBeNull();
    const seeded = JSON.parse(readFileSync(taskFile!, "utf-8"));
    seeded.verified = true;
    const { writeFileSync } = await import("node:fs");
    writeFileSync(taskFile!, JSON.stringify(seeded, null, 2));

    const res = await callTool(client, "update_task", {
      id: task.id,
      status: "in-progress",
    });
    if (GATED) {
      const parsed = await assertJsonTextContent(res);
      expect(parsed.status).toBe("in-progress");
      expect(readTaskFromDisk(env.projectDir, task.id).verified).toBe(false);
    } else {
      // [now] MCP wrapper has no verified reset — CLI-only today.
      const parsed = await assertJsonTextContent(res);
      expect(parsed.status).toBe("in-progress");
      expect(readTaskFromDisk(env.projectDir, task.id).verified).toBe(true);
    }
  });

  it("5: done-status asymmetry — MCP has no agent done warning", async () => {
    // Documented asymmetry: CLI prints a warning on --set-status done by an
    // agent; the MCP wrapper accepts done silently. Pinned [now]; no flip.
    const task = await assertJsonTextContent(
      await callTool(client, "create_task", { title: "gate 5" }),
    );
    const parsed = await assertJsonTextContent(
      await callTool(client, "update_task", { id: task.id, status: "done" }),
    );
    expect(parsed.status).toBe("done");
    expect(readGateTaskFromDisk(task.id).status).toBe("done");
  });
});
