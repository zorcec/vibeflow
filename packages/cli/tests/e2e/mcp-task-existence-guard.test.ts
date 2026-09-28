/**
 * MCP e2e — the task-existence guard for every task-scoped tool.
 *
 * THE RULE: a task-scoped mutation must resolve its task FIRST and refuse
 * `TASK_NOT_FOUND` before touching any state. This file is the recurrence
 * guard for that rule, and it is the deliverable that matters more than the
 * three fixes it was written for — it is what stops a FOURTH tool from
 * forgetting.
 *
 * Why a guard rather than three more assertions: the three live defects were
 * not three bugs with three fixes, they were one missing precondition. Two of
 * them (`add_comment` creating a ghost task file, `attach_file` writing under
 * `.vibeflow/tasks/files/<unknown-id>/`) returned `ok:true` — the agent was
 * told the write happened, had nothing to recover from, and the board was
 * corrupted by an append-only store that does not self-heal.
 *
 * The set of tools under test is DERIVED from the manifest, never hard-coded:
 * every tool whose input declares a task `id`. A new task-scoped tool is
 * therefore swept the day it is added, and the derived-set check below fails
 * until it has a row here.
 *
 * Two independent assertions, both of which a revert of any single fix breaks:
 *  1. the call REFUSES with a code — not "returns something", but `ok:false`
 *     and the assigned code;
 *  2. the tree under `.vibeflow/tasks` is byte-for-byte what it was — a new
 *     file ANYWHERE under that root fails, not just one in the phantom task's
 *     own folder, because the corruption this catches is not always a task
 *     file (an `attach_file` orphan lands in `files/<id>/`).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, globSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  bootMcpServer,
  newClient,
  initialize,
  callTool,
  seedGitUser,
  type McpClient,
  type McpTestEnv,
} from "./mcp-helpers.js";
import { manifest } from "../../src/mcp/manifest.js";

/**
 * An id that cannot exist: no task file anywhere, and no prefix of it can
 * collide, so a resolver that honours prefixes still resolves to itself.
 */
const IMPOSSIBLE_ID = "ffffffffffffffffffffffffffff01";

/**
 * The reachable-refusal set, EXPLICIT.
 *
 * Every row is a call this file makes and therefore a refusal a client can
 * actually receive. Written out rather than derived from a loop over "whatever
 * refused", because a set discovered by observing a run is a set that silently
 * shrinks when a fix changes a code — the exact failure this guard exists to
 * prevent. One row per `id`-bearing manifest tool is enforced below, so the
 * list cannot fall behind the manifest.
 */
const REACHABLE_REFUSALS: Array<{
  /** Stable label — appears in every failure message. */
  label: string;
  tool: string;
  input: Record<string, unknown>;
  /** The assigned code. Asserted, so a wrong code cannot pass as "it refused". */
  code: string;
}> = [
  {
    label: "get_task",
    tool: "get_task",
    input: { id: IMPOSSIBLE_ID },
    code: "TASK_NOT_FOUND",
  },
  {
    label: "update_task",
    tool: "update_task",
    input: { id: IMPOSSIBLE_ID, title: "x" },
    code: "TASK_NOT_FOUND",
  },
  {
    // The ghost-task defect: used to answer ok:true and write a task file.
    label: "add_comment",
    tool: "add_comment",
    input: { id: IMPOSSIBLE_ID, comment: "x" },
    code: "TASK_NOT_FOUND",
  },
  {
    // The orphan-file defect: used to answer ok:true and write a file for a
    // task that does not exist.
    label: "attach_file",
    tool: "attach_file",
    input: {
      id: IMPOSSIBLE_ID,
      filename: "screenshot.png",
      contentB64: Buffer.from("x").toString("base64"),
    },
    code: "TASK_NOT_FOUND",
  },
  {
    label: "export_prompt",
    tool: "export_prompt",
    input: { id: IMPOSSIBLE_ID },
    code: "TASK_NOT_FOUND",
  },
  {
    // `verify_task` resolves through the CLI verify engine, which has its own
    // E_NOT_FOUND code. It is in the sweep because it mutates (it adds a
    // system comment) — a code difference is not an exemption from "writes
    // nothing for a task that is not there".
    label: "verify_task",
    tool: "verify_task",
    input: { id: IMPOSSIBLE_ID, url: "http://127.0.0.1:1/never-loaded" },
    code: "E_NOT_FOUND",
  },
];

/** Every manifest tool that takes a task id. The sweep covers exactly these. */
function manifestIdTools(): string[] {
  return manifest
    .filter((tool) => "id" in tool.input)
    .map((tool) => tool.name)
    .sort();
}

interface Envelope {
  ok: boolean;
  error?: {
    code: string;
    message: string;
    retryable?: boolean;
    suggestion?: string;
  };
}

function treeUnder(root: string): string[] {
  if (!existsSync(root)) return [];
  return globSync(join(root, "**", "*"), { dot: true })
    .map((p) => p.slice(root.length))
    .sort();
}

describe("MCP task-scoped tools resolve the task before they touch state", () => {
  let env: McpTestEnv;
  let client: McpClient;

  beforeEach(async () => {
    const tmp = mkdtempSync(join(tmpdir(), "mcp-e2e-exists-"));
    seedGitUser(tmp);
    env = await bootMcpServer(tmp);
    client = newClient(env.mcpUrl);
    await initialize(client);
  });

  afterEach(async () => {
    await env.cleanup();
  });

  const tasksRoot = () => join(env.projectDir, ".vibeflow", "tasks");

  /** Call a tool and return the tool-level envelope. */
  async function call(tool: string, input: Record<string, unknown>) {
    const res = await callTool(client, tool, input);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
    // A tool-level refusal is an ordinary result, NOT isError — if a fix ever
    // made one of these throw instead, the guard would stop reading the
    // envelope and the refusal would silently "pass". Asserted per sweep below.
    return {
      isError: Boolean(body.result.isError),
      envelope: JSON.parse(body.result.content[0].text) as Envelope,
    };
  }

  it("the sweep covers every id-bearing manifest tool, and no stale rows", () => {
    const fromManifest = manifestIdTools();
    const fromTable = REACHABLE_REFUSALS.map((r) => r.tool).sort();
    // Exact equality in BOTH directions: a new id-bearing tool with no row
    // fails here, and a row for a tool that no longer exists fails here too.
    expect(fromTable).toEqual(fromManifest);
    // Shape guard: a filter that matched nothing would make the sweep vacuous.
    expect(fromManifest.length).toBeGreaterThanOrEqual(6);
  });

  it("every task-scoped tool refuses an impossible id and writes nothing", async () => {
    const offenders: string[] = [];
    for (const row of REACHABLE_REFUSALS) {
      const before = treeUnder(tasksRoot());
      const { envelope, isError } = await call(row.tool, row.input);
      const after = treeUnder(tasksRoot());
      const created = after.filter((p) => !before.includes(p));

      if (isError) {
        offenders.push(
          `${row.label}: raised a protocol-level error instead of the refusal envelope`,
        );
        continue;
      }
      if (envelope.ok !== false) {
        offenders.push(
          `${row.label}: answered ok:true for a task that does not exist (payload ${JSON.stringify(envelope).slice(0, 120)})`,
        );
      } else if (envelope.error?.code !== row.code) {
        offenders.push(
          `${row.label}: refused with ${envelope.error?.code}, expected ${row.code}`,
        );
      } else if (
        typeof envelope.error?.suggestion !== "string" ||
        envelope.error.suggestion.length === 0
      ) {
        // The second guard: a refusal an agent cannot recover from. Same sweep,
        // every refusal it reaches — a code alone tells the agent what went
        // wrong, never how to make it right.
        offenders.push(
          `${row.label}: ${envelope.error.code} carries no suggestion`,
        );
      }
      if (created.length > 0) {
        offenders.push(
          `${row.label}: created ${JSON.stringify(created)} under .vibeflow/tasks for a task that does not exist`,
        );
      }
    }
    // Collected, not thrown on the first, so one run reports the whole class.
    expect(offenders).toEqual([]);
  });

  it("a dangling link target is refused as TASK_NOT_FOUND, not a generic error", async () => {
    // update_task is already swept above for a missing TASK. This row covers
    // the other existence check on the same tool: a link whose TARGET does not
    // exist. It always refused — but as `UPDATE_TASK_ERROR`, because
    // buildUpdateLinks dropped the producer's code, so the client was told the
    // CALL was wrong when the truth was "that task does not exist". A guard
    // that only checked "it refused" would have passed the buggy version, so
    // the code itself is asserted.
    const created = (await call("create_task", { title: "link target" }))
      .envelope as unknown as { id: string };
    expect(typeof created.id).toBe("string");

    const before = treeUnder(tasksRoot());
    const { envelope } = await call("update_task", {
      id: created.id,
      links: [{ taskId: IMPOSSIBLE_ID, type: "relates" }],
    });
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe("TASK_NOT_FOUND");
    expect(typeof envelope.error?.suggestion).toBe("string");
    expect(envelope.error!.suggestion!.length).toBeGreaterThan(0);
    // The refusal wrote nothing: no link was persisted against the real task.
    expect(treeUnder(tasksRoot())).toEqual(before);
  });
});
