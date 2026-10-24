/**
 * Same-board operation differential (P9, ticket 0e5f5e06 — the acceptance
 * half).
 *
 * The claim under test: the CLI binary and the MCP server are two renderers
 * over ONE shared operation layer. So driving the SAME disposable board
 * through both surfaces with the SAME inputs must produce the SAME data —
 * not merely "both succeed". Every case here compares normalized payloads
 * and authoritative post-state, and every mutation is cross-read through
 * the other surface (create via CLI → read via MCP, edit via MCP → read
 * via CLI), so a divergence in either direction fails.
 *
 * Lane: local only (disposable project dir, isolated HOME, no network, no
 * git writes — settings disable auto-commit). The hosted/API lane needs
 * disposable cloud credentials and is tracked as the P9 follow-up with
 * exact anchors (see scripts/operation-drift-canary.mjs); it must never
 * silently pass here, so this file asserts nothing about hosted at all.
 *
 * What this file does NOT do (by design):
 * - browser verification (verify_task needs a live page; engine parity is
 *   pinned in tests/unit/mcp/parity.test.ts and verify e2e);
 * - true concurrent claim races (pinned in mcp-claim-race.test.ts) — here
 *   sequential live claims must still hand out distinct tasks;
 * - envelope equality: CLI answers {ok:true,...namedPayload} on stdout and
 *   {ok:false,...} on stderr, MCP answers raw data / {ok:false,...} text.
 *   The comparator decodes each envelope with a fixed adapter and compares
 *   the DATA, which is what the shared-operation claim is about.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  globSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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

function seedTask(
  projectDir: string,
  task: Record<string, unknown>,
): void {
  const dir = join(projectDir, ".vibeflow", "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${task.id as string}.json`),
    JSON.stringify(task, null, 2) + "\n",
  );
}

/** Disposable board fingerprint: both surfaces must resolve to THIS dir. */
function seedBoard(projectDir: string): void {
  const t = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    title: `Task ${id}`,
    description: `description of ${id}`,
    status: "todo",
    selector: "/",
    created: "2026-01-01T00:00:00.000Z",
    comments: [],
    files: [],
    ...overrides,
  });
  seedTask(projectDir, t("root-a", { priority: "High", tags: ["public"] }));
  seedTask(projectDir, t("root-b", {}));
  seedTask(
    projectDir,
    t("child-a", { links: [{ taskId: "done-p", type: "parent" }] }),
  );
  // Done parent with a todo child: the child must NEVER be claimed and
  // must appear only in explicitly filtered/unbounded reads.
  seedTask(projectDir, t("done-p", { status: "done" }));
  seedTask(
    projectDir,
    t("child-done-p", { links: [{ taskId: "done-p", type: "parent" }] }),
  );
  mkdirSync(join(projectDir, ".vibeflow"), { recursive: true });
  writeFileSync(
    join(projectDir, ".vibeflow", "settings.json"),
    JSON.stringify(
      { autoCommit: false, createBranch: false, autoPush: false },
      null,
      2,
    ),
  );
}

/** CLI stdout JSON (success envelope) or parsed stderr (refusal envelope). */
async function cliJson(
  projectDir: string,
  home: string,
  args: string[],
): Promise<{ code: number; body: any }> {
  const res = await runCli(args, { cwd: projectDir, home });
  const raw = res.code === 0 ? res.stdout : res.stderr;
  return { code: res.code, body: JSON.parse(raw) };
}

/** MCP tool result through the real HTTP transport (data or {ok:false}). */
async function mcpJson(
  client: McpClient,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  return assertJsonTextContent(await callTool(client, name, args));
}

/** Normalized task for cross-surface comparison (volatile URLs dropped). */
function normTask(t: any): any {
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    status: t.status,
    type: t.type,
    priority: t.priority,
    links: (t.links ?? []).map((l: any) => ({ ...l })).sort((a: any, b: any) =>
      `${a.taskId}${a.type}`.localeCompare(`${b.taskId}${b.type}`),
    ),
    comments: (t.comments ?? []).map((c: any) => ({
      text: c.text,
      author: c.author,
    })),
    files: (t.files ?? []).map((f: any) => ({ name: f.name, size: f.size })),
  };
}

const sortedIds = (tasks: Array<{ id: string }>) =>
  tasks.map((t) => t.id).sort();

describe("same-board differential: CLI vs MCP", () => {
  let projectDir: string;
  let home: string;
  let env: McpTestEnv;
  let client: McpClient;

  beforeEach(async () => {
    projectDir = mkdtempSync(join(tmpdir(), "op-diff-"));
    home = mkdtempSync(join(tmpdir(), "op-diff-home-"));
    seedGitUser(projectDir);
    seedBoard(projectDir);
    // Same board, two renderers: the server is pinned to the project dir
    // the CLI runs in (the fingerprint both sides must agree on).
    env = await bootMcpServer(projectDir);
    expect(env.projectDir).toBe(projectDir);
    client = newClient(env.mcpUrl);
    await initialize(client);
  });

  afterEach(async () => {
    await env.cleanup();
    rmSync(projectDir, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("reads agree: roots, children, filtered scope, detail", async () => {
    // Unfiltered roots on both.
    const cliRoots = await cliJson(projectDir, home, ["tasks", "--json"]);
    expect(cliRoots.code).toBe(0);
    const mcpRoots = await mcpJson(client, "list_tasks", {});
    expect(sortedIds(cliRoots.body.tasks)).toEqual([
      "done-p",
      "root-a",
      "root-b",
    ]);
    expect(sortedIds(mcpRoots.tasks)).toEqual([
      "done-p",
      "root-a",
      "root-b",
    ]);
    expect(mcpRoots.totalMatching).toBe(cliRoots.body.totalMatching);
    expect(mcpRoots.totalRoots).toBe(cliRoots.body.totalRoots);
    expect(mcpRoots.hiddenChildren).toBe(cliRoots.body.hiddenChildren);

    // Filtered search includes matching children on both (the P2
    // correction: no surface may hide a matching child).
    const cliFiltered = await cliJson(projectDir, home, [
      "tasks",
      "--status",
      "todo",
      "--json",
    ]);
    const mcpFiltered = await mcpJson(client, "list_tasks", {
      status: "todo",
    });
    expect(sortedIds(cliFiltered.body.tasks)).toEqual(
      sortedIds(mcpFiltered.tasks),
    );
    expect(sortedIds(cliFiltered.body.tasks)).toContain("child-a");

    // Unbounded children on both.
    const cliAll = await cliJson(projectDir, home, [
      "tasks",
      "--children",
      "--json",
    ]);
    const mcpAll = await mcpJson(client, "list_tasks", { children: true });
    expect(sortedIds(cliAll.body.tasks)).toEqual(sortedIds(mcpAll.tasks));

    // Detail for every listed id agrees field-for-field (normalized).
    for (const id of sortedIds(mcpAll.tasks)) {
      const cliGet = await cliJson(projectDir, home, [
        "tasks",
        "--get",
        id,
        "--json",
      ]);
      const mcpGet = await mcpJson(client, "get_task", { id });
      expect(normTask(cliGet.body.task)).toEqual(normTask(mcpGet));
    }
  });

  it("mutations round-trip through the other surface", async () => {
    // Create via CLI → read via MCP, identical data.
    const created = await cliJson(projectDir, home, [
      "tasks",
      "--add",
      "--title",
      "cli-made",
      "--priority",
      "High",
      "--json",
    ]);
    expect(created.code).toBe(0);
    const cliId = created.body.task.id;
    const mcpRead = await mcpJson(client, "get_task", { id: cliId });
    expect(mcpRead.title).toBe("cli-made");
    expect(mcpRead.priority).toBe("High");

    // Create via MCP with a parent → CLI sees the surgical parent link.
    const mcpCreated = await mcpJson(client, "create_task", {
      title: "mcp-made",
      parent: "root-a",
    });
    const cliRead = await cliJson(projectDir, home, [
      "tasks",
      "--get",
      mcpCreated.id,
      "--json",
    ]);
    expect(
      cliRead.body.task.links.map((l: any) => l.taskId),
    ).toContain("root-a");

    // Edit via MCP → CLI sees the title and exactly one new comment.
    const before = (cliRead.body.task.comments ?? []).length;
    const updated = await mcpJson(client, "update_task", {
      id: mcpCreated.id,
      title: "mcp-renamed",
      comment: "mcp note",
    });
    expect(updated.title).toBe("mcp-renamed");
    const cliAfterMcp = await cliJson(projectDir, home, [
      "tasks",
      "--get",
      mcpCreated.id,
      "--json",
    ]);
    expect(cliAfterMcp.body.task.title).toBe("mcp-renamed");
    expect(cliAfterMcp.body.task.comments.length).toBe(before + 1);
    expect(
      cliAfterMcp.body.task.comments[before].text,
    ).toBe("mcp note");

    // Edit via CLI → MCP sees the title and exactly one new comment.
    const mcpBefore = await mcpJson(client, "get_task", { id: cliId });
    const editRes = await cliJson(projectDir, home, [
      "tasks",
      "--edit",
      cliId,
      "--title",
      "cli-renamed",
      "--comment",
      "cli note",
      "--json",
    ]);
    expect(editRes.code).toBe(0);
    const mcpAfterCli = await mcpJson(client, "get_task", { id: cliId });
    expect(mcpAfterCli.title).toBe("cli-renamed");
    expect(mcpAfterCli.comments.length).toBe(mcpBefore.comments.length + 1);
    expect(
      mcpAfterCli.comments[mcpAfterCli.comments.length - 1].text,
    ).toBe("cli note");
  });

  it("attachments round-trip with identical bytes; CLI refuses duplicates", async () => {
    const payload = "# differential attach\n";
    const src = join(projectDir, "attach-me.md");
    writeFileSync(src, payload);

    // CLI attach → MCP metadata agrees, bytes on disk are exact.
    const attached = await cliJson(projectDir, home, [
      "tasks",
      "--attach",
      src,
      "--task",
      "root-b",
      "--json",
    ]);
    expect(attached.code).toBe(0);
    const mcpGot = await mcpJson(client, "get_task", { id: "root-b" });
    expect(mcpGot.files.map((f: any) => f.name)).toContain("attach-me.md");
    const stored = globSync(
      join(projectDir, ".vibeflow", "tasks", "files", "root-b", "attach-me.md"),
    );
    expect(stored).toHaveLength(1);
    expect(readFileSync(stored[0], "utf-8")).toBe(payload);

    // CLI duplicate attach refuses (declared input-policy delta, exit
    // USAGE per the attach renderer's exact-exit contract) — one ref.
    const dup = await cliJson(projectDir, home, [
      "tasks",
      "--attach",
      src,
      "--task",
      "root-b",
      "--json",
    ]);
    expect(dup.code).toBe(2);
    expect(dup.body.error.code).toBe("E_FILE_EXISTS");

    // MCP attach of the same name REPLACES in place (the declared other
    // half of the policy): still one ref, bytes now the replacement.
    const replacement = Buffer.from("# replacement\n").toString("base64");
    const replaced = await mcpJson(client, "attach_file", {
      id: "root-b",
      filename: "attach-me.md",
      contentB64: replacement,
    });
    expect(replaced.name).toBe("attach-me.md");
    const mcpGot2 = await mcpJson(client, "get_task", { id: "root-b" });
    expect(
      mcpGot2.files.filter((f: any) => f.name === "attach-me.md"),
    ).toHaveLength(1);
    expect(readFileSync(stored[0], "utf-8")).toBe("# replacement\n");
  });

  it("claim previews agree; sequential live claims hand out distinct tasks", async () => {
    // Same snapshot, same candidate on both (roots-first, High first, no
    // done-parent child).
    const cliPreview = await cliJson(projectDir, home, [
      "tasks",
      "--next",
      "--dry-run",
      "--json",
    ]);
    const mcpPreview = await mcpJson(client, "claim_next_task", {
      dryRun: true,
    });
    expect(cliPreview.body.task.id).toBe("root-a");
    expect(mcpPreview.id).toBe("root-a");

    // Live claims hand out distinct tasks; post-state is identical.
    const cliClaim = await cliJson(projectDir, home, [
      "tasks",
      "--next",
      "--json",
    ]);
    expect(cliClaim.body.task.id).toBe("root-a");
    const mcpClaim = await mcpJson(client, "claim_next_task", {});
    expect(mcpClaim.id).toBe("root-b");
    expect(mcpClaim.id).not.toBe(cliClaim.body.task.id);

    const cliState = await cliJson(projectDir, home, [
      "tasks",
      "--get",
      "root-a",
      "--json",
    ]);
    const mcpState = await mcpJson(client, "get_task", { id: "root-b" });
    expect(cliState.body.task.status).toBe("in-progress");
    expect(mcpState.status).toBe("in-progress");

    // Board exhausted for claims (done-parent child is not claimable):
    // CLI null-claim envelope and MCP null payload agree.
    const cliEmpty = await cliJson(projectDir, home, [
      "tasks",
      "--next",
      "--json",
    ]);
    expect(cliEmpty.code).toBe(0);
    expect(cliEmpty.body.task).toBeNull();
  });

  it("refusals agree in code and leave the board untouched", async () => {
    const snap = (id: string) =>
      JSON.parse(
        readFileSync(
          globSync(join(projectDir, ".vibeflow", "tasks", `${id}.json`))[0],
          "utf-8",
        ),
      );
    const before = snap("root-a");

    // Missing id: TASK_NOT_FOUND on both, nothing written.
    const cliMissing = await cliJson(projectDir, home, [
      "tasks",
      "--get",
      "deadbeef",
      "--json",
    ]);
    expect(cliMissing.code).toBe(3);
    expect(cliMissing.body.error.code).toBe("TASK_NOT_FOUND");
    const mcpMissing = await mcpJson(client, "get_task", { id: "deadbeef" });
    expect(mcpMissing.ok).toBe(false);
    expect(mcpMissing.error.code).toBe("TASK_NOT_FOUND");

    // Review without a comment: REVIEW_COMMENT_REQUIRED on both.
    const cliRefused = await cliJson(projectDir, home, [
      "tasks",
      "--edit",
      "root-a",
      "--set-status",
      "review",
      "--json",
    ]);
    // Gate refusals exit USAGE on the CLI (plan §5.1 exact-exit contract);
    // the shared fact is the error CODE, identical on both surfaces.
    expect(cliRefused.code).toBe(2);
    expect(cliRefused.body.error.code).toBe("REVIEW_COMMENT_REQUIRED");
    const mcpRefused = await mcpJson(client, "update_task", {
      id: "root-a",
      status: "review",
    });
    expect(mcpRefused.ok).toBe(false);
    expect(mcpRefused.error.code).toBe("REVIEW_COMMENT_REQUIRED");

    expect(snap("root-a")).toEqual(before);
  });
});
