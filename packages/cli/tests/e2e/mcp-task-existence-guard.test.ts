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

interface RefusalRow {
  /** Stable label — appears in every failure message. */
  label: string;
  tool: string;
  /**
   * Names the fixtures the row needs. Named rather than a closure because the
   * table is module-scope: it cannot capture the per-test MCP client, and a
   * seed written here would be untestable. Called BEFORE the `before` snapshot,
   * so a seeded task is never mistaken for something the refusal created.
   */
  seed?: "task+research";
  input: (ids: { taskId: string; researchId: string }) => Record<string, unknown>;
  /** The assigned code. Asserted, so a wrong code cannot pass as "it refused". */
  code: string;
}

/**
 * The reachable-refusal set, EXPLICIT.
 *
 * Every row is a call this file makes and therefore a refusal a client can
 * actually receive. Written out rather than derived from a loop over "whatever
 * refused", because a set discovered by observing a run is a set that silently
 * shrinks when a fix changes a code — the exact failure this guard exists to
 * prevent. One row per `id`-bearing manifest tool is enforced below, so the
 * list cannot fall behind the manifest, and the non-existence refusals are
 * themselves checked against the derived set.
 *
 * Two kinds of row, both required to carry a non-empty `suggestion`:
 *  - the existence refusals (`group: "existence"`) — one per `id`-bearing tool;
 *  - the recovery refusals (`group: "recovery"`) — the other codes a client can
 *    actually land on, so "every refusal names how to fix it" is enforced past
 *    the existence case instead of being asserted in prose.
 */
const REACHABLE_REFUSALS: Array<
  RefusalRow & { group: "existence" | "recovery" }
> = [
  {
    group: "existence",
    label: "get_task",
    tool: "get_task",
    input: () => ({ id: IMPOSSIBLE_ID }),
    code: "TASK_NOT_FOUND",
  },
  {
    group: "existence",
    label: "update_task",
    tool: "update_task",
    input: () => ({ id: IMPOSSIBLE_ID, title: "x" }),
    code: "TASK_NOT_FOUND",
  },
  {
    // The ghost-task defect: used to answer ok:true and write a task file.
    group: "existence",
    label: "add_comment",
    tool: "add_comment",
    input: () => ({ id: IMPOSSIBLE_ID, comment: "x" }),
    code: "TASK_NOT_FOUND",
  },
  {
    // The orphan-file defect: used to answer ok:true and write a file for a
    // task that does not exist.
    group: "existence",
    label: "attach_file",
    tool: "attach_file",
    input: () => ({
      id: IMPOSSIBLE_ID,
      filename: "screenshot.png",
      contentB64: Buffer.from("x").toString("base64"),
    }),
    code: "TASK_NOT_FOUND",
  },
  {
    group: "existence",
    label: "export_prompt",
    tool: "export_prompt",
    input: () => ({ id: IMPOSSIBLE_ID }),
    code: "TASK_NOT_FOUND",
  },
  {
    // `verify_task` resolves through the CLI verify engine, which has its own
    // E_NOT_FOUND code. It is in the sweep because it mutates (it adds a
    // system comment) — a code difference is not an exemption from "writes
    // nothing for a task that is not there".
    group: "existence",
    label: "verify_task",
    tool: "verify_task",
    input: () => ({ id: IMPOSSIBLE_ID, url: "http://127.0.0.1:1/never-loaded" }),
    code: "E_NOT_FOUND",
  },

  // ── Recovery refusals ────────────────────────────────────────────────
  // The existence rows above are the property this lane was opened for. These
  // are the rest of what a client can actually land on, all of which used to
  // arrive with no recovery text at all: a code names the failure and nothing
  // else, so the agent is left guessing which input to change.
  {
    group: "recovery",
    label: "attestation VERIFY_REASON_REQUIRED",
    tool: "update_task",
    seed: "task+research",
    input: (ids) => ({ id: ids.taskId, setVerify: "cannot" }),
    code: "VERIFY_REASON_REQUIRED",
  },
  {
    group: "recovery",
    label: "gate VERIFY_REASON_REQUIRED",
    tool: "update_task",
    seed: "task+research",
    // Same code, DIFFERENT string: this one comes from the review gate rather
    // than the attestation, so it needs its own row.
    input: (ids) => ({
      id: ids.taskId,
      status: "review",
      comment: "x",
      setVerify: "cannot",
    }),
    code: "VERIFY_REASON_REQUIRED",
  },
  {
    group: "recovery",
    label: "E_USAGE (a reason with no 'cannot' verdict)",
    tool: "update_task",
    seed: "task+research",
    input: (ids) => ({ id: ids.taskId, verifyReason: "orphan reason" }),
    code: "E_USAGE",
  },
  {
    group: "recovery",
    label: "REVIEW_COMMENT_REQUIRED",
    tool: "update_task",
    seed: "task+research",
    input: (ids) => ({ id: ids.taskId, status: "review" }),
    code: "REVIEW_COMMENT_REQUIRED",
  },
  {
    group: "recovery",
    label: "UNSUPPORTED_FILE_TYPE",
    tool: "attach_file",
    seed: "task+research",
    input: (ids) => ({
      id: ids.taskId,
      filename: "payload.exe",
      contentB64: Buffer.from("x").toString("base64"),
    }),
    code: "UNSUPPORTED_FILE_TYPE",
  },
  {
    group: "recovery",
    label: "CREATE_TASK_ERROR (a parent that does not exist)",
    tool: "create_task",
    input: () => ({ title: "Orphan", parent: IMPOSSIBLE_ID }),
    code: "CREATE_TASK_ERROR",
  },
  {
    group: "recovery",
    label: "E_NO_BASELINE",
    tool: "verify_task",
    seed: "task+research",
    input: (ids) => ({
      id: ids.taskId,
      url: "http://127.0.0.1:1/never-loaded",
    }),
    code: "E_NO_BASELINE",
  },
  {
    group: "recovery",
    label: "RESEARCH_REPORT_REQUIRED",
    tool: "update_task",
    seed: "task+research",
    input: (ids) => ({
      id: ids.researchId,
      status: "review",
      comment: "report follows",
    }),
    code: "RESEARCH_REPORT_REQUIRED",
  },
  {
    group: "recovery",
    label: "RESEARCH_VERIFY_NOT_ALLOWED",
    tool: "update_task",
    seed: "task+research",
    input: (ids) => ({ id: ids.researchId, setVerify: "pass" }),
    code: "RESEARCH_VERIFY_NOT_ALLOWED",
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

  /** A plain task and a Research task, for the rows that need a real target. */
  async function seedTwoTasks(): Promise<{ taskId: string; researchId: string }> {
    const task = (await call("create_task", { title: "sweep target" }))
      .envelope as unknown as { id: string };
    const research = (
      await call("create_task", { title: "sweep research", type: "Research" })
    ).envelope as unknown as { id: string };
    expect(typeof task.id).toBe("string");
    expect(typeof research.id).toBe("string");
    return { taskId: task.id, researchId: research.id };
  }

  it("the existence rows cover every id-bearing manifest tool, and no stale rows", () => {
    const fromManifest = manifestIdTools();
    const fromTable = REACHABLE_REFUSALS.filter((r) => r.group === "existence")
      .map((r) => r.tool)
      .sort();
    // Exact equality in BOTH directions: a new id-bearing tool with no row
    // fails here, and a row for a tool that no longer exists fails here too.
    expect(fromTable).toEqual(fromManifest);
    // Shape guard: a filter that matched nothing would make the sweep vacuous.
    expect(fromManifest.length).toBeGreaterThanOrEqual(6);
  });

  it("every row refuses with its assigned code, a suggestion, and no writes", async () => {
    const offenders: string[] = [];
    for (const row of REACHABLE_REFUSALS) {
      const ids =
        row.seed === "task+research"
          ? await seedTwoTasks()
          : { taskId: "", researchId: "" };
      // Snapshot AFTER seeding, so a seeded task is never counted as something
      // the refusal created.
      const before = treeUnder(tasksRoot());
      const { envelope, isError } = await call(row.tool, row.input(ids));
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
          `${row.label}: answered ok:true instead of refusing (payload ${JSON.stringify(envelope).slice(0, 120)})`,
        );
      } else if (envelope.error?.code !== row.code) {
        offenders.push(
          `${row.label}: refused with ${envelope.error?.code}, expected ${row.code}`,
        );
      } else if (
        typeof envelope.error?.suggestion !== "string" ||
        envelope.error.suggestion.length === 0
      ) {
        // The second guard: a refusal an agent cannot recover from. Every
        // refusal this sweep reaches — a code alone tells the agent what went
        // wrong, never how to make it right.
        offenders.push(
          `${row.label}: ${envelope.error.code} carries no suggestion`,
        );
      }
      if (created.length > 0) {
        offenders.push(
          `${row.label}: a refusal wrote ${JSON.stringify(created)} under .vibeflow/tasks`,
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
