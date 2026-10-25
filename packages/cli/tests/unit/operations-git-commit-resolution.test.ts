/**
 * Commit id-resolution parity (ticket e47d3004).
 *
 * `tasks --commit --task <short-id>` printed "Task not found" while
 * `--edit`/`--get` resolved the same short id: the commit-link path
 * hardcoded local mode and skipped the shared resolver. The operation now
 * resolves through `resolveTaskOrRefusal` (board in saas mode, files in
 * local mode), so a unique prefix resolves and links, an ambiguous prefix
 * refuses naming the candidates, and an unknown id says not found.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

vi.mock("../../src/auth/project-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/auth/project-auth.js")>();
  return { ...actual, resolveProjectAuth: vi.fn() };
});

import { resolveProjectAuth } from "../../src/auth/project-auth.js";
import { saasAuth } from "./helpers/mock-project-auth.js";
import type { OperationContext } from "../../src/core/operations.js";
import { commitTaskPathsOperation } from "../../src/core/operations.js";
import { gitEnvWithCleanLocation } from "../../src/core/git-env.js";

const gitEnv = gitEnvWithCleanLocation();

let projectDir: string;
let ctx: OperationContext;

function v0Task(id: string) {
  return {
    id,
    title: `board ${id}`,
    description: `body of ${id}`,
    status: "todo",
    priority: null,
    type: null,
    boardId: "board-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/** URL-routed fake board: detail by id, one boards page, one tasks page. */
function stubBoard(ids: string[]) {
  const byId = new Map(ids.map((id) => [id, v0Task(id)]));
  const seen: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      seen.push(url);
      if (url.includes("/api/v0/boards")) {
        const items = [{ id: "board-1", name: "B1" }];
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          text: () => Promise.resolve(JSON.stringify({ items, nextCursor: null })),
          json: () => Promise.resolve({ items, nextCursor: null }),
        });
      }
      const detailMatch = url.match(/\/api\/v0\/tasks\/([^/?]+)(\/.*)?$/);
      if (detailMatch && detailMatch[1] !== "tasks" && detailMatch[2] === undefined) {
        const row = byId.get(detailMatch[1]);
        if (!row) {
          return Promise.resolve({
            ok: false,
            status: 404,
            headers: { get: () => "application/json" },
            text: () => Promise.resolve("{}"),
            json: () => Promise.resolve({}),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          text: () => Promise.resolve(JSON.stringify(row)),
          json: () => Promise.resolve(row),
        });
      }
      const items = [...byId.values()];
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        text: () =>
          Promise.resolve(JSON.stringify({ items, nextCursor: null })),
        json: () => Promise.resolve({ items, nextCursor: null }),
      });
    }),
  );
  return seen;
}

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "p5-git-saas-"));
  ctx = { projectDir, mode: "saas" };
  vi.mocked(resolveProjectAuth).mockResolvedValue(saasAuth());
});

afterEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.VIBEFLOW_API_URL;
});

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: projectDir,
    env: gitEnv,
    stdio: ["ignore", "pipe", "ignore"],
  }).toString();
}

/** Local clone record carrying the board id (what pull/add persist). */
function seedClone(id: string): string {
  const dateSubdir = new Date().toISOString().slice(0, 10);
  const tasksDir = join(projectDir, ".vibeflow", "tasks", dateSubdir);
  mkdirSync(tasksDir, { recursive: true });
  const rel = join(".vibeflow", "tasks", dateSubdir, `${id}.json`);
  writeFileSync(
    join(projectDir, rel),
    JSON.stringify({
      id,
      title: `board ${id}`,
      description: "",
      status: "todo",
      selector: "/",
      created: new Date().toISOString(),
      commits: [],
    }),
  );
  return rel;
}

describe("commitTaskPathsOperation saas-mode resolution", () => {
  it("resolves a unique short prefix against the board and links the commit", async () => {
    const full = "s329ijxa000000000000000000000001";
    stubBoard([full, "unrelated000000000000000000000002"]);
    git(["init", "-q"]);
    git(["config", "user.email", "p5-git@test.local"]);
    git(["config", "user.name", "P5"]);
    git(["commit", "-q", "--allow-empty", "-m", "init"]);
    const rel = seedClone(full);
    const headBefore = git(["rev-parse", "HEAD"]).trim();

    const r = await commitTaskPathsOperation(ctx, {
      id: "s329ijxa",
      message: "probe: link resolution",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.taskId).toBe(full);
    // Clean tree: links HEAD instead of failing, and the record carries it.
    expect(r.data.sha).toBe(headBefore);
    const record = JSON.parse(readFileSync(join(projectDir, rel), "utf-8")) as {
      commits: Array<{ sha: string }>;
    };
    expect(record.commits).toHaveLength(1);
    expect(record.commits[0].sha).toBe(headBefore);
  });

  it("resolves a board-only prefix with no local clone (dry run)", async () => {
    // The reported bug exactly: the task lives on the board (resolvable
    // by --edit/--get) with no local file. Local-only resolution says
    // "not found"; the shared resolver names it.
    const full = "s329ijxa999999999999999999999999";
    stubBoard([full]);
    git(["init", "-q"]);
    git(["config", "user.email", "p5-git@test.local"]);
    git(["config", "user.name", "P5"]);
    git(["commit", "-q", "--allow-empty", "-m", "init"]);

    const r = await commitTaskPathsOperation(ctx, {
      id: "s329ijxa",
      message: "probe",
      dryRun: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.taskId).toBe(full);
    expect(r.data.taskTitle).toBe(`board ${full}`);
  });

  it("refuses an ambiguous prefix naming the candidates, writing nothing", async () => {
    stubBoard(["ab111111111111111111111111111111", "ab222222222222222222222222222222"]);
    git(["init", "-q"]);
    git(["config", "user.email", "p5-git@test.local"]);
    git(["config", "user.name", "P5"]);
    git(["commit", "-q", "--allow-empty", "-m", "init"]);
    const headBefore = git(["rev-parse", "HEAD"]).trim();

    const r = await commitTaskPathsOperation(ctx, { id: "ab", message: "x" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("E_AMBIGUOUS");
    expect(r.error.message).toContain("ab111111111111111111111111111111");
    expect(r.error.message).toContain("ab222222222222222222222222222222");
    expect(git(["rev-parse", "HEAD"]).trim()).toBe(headBefore);
  });

  it("says not found for an unknown id, writing nothing", async () => {
    stubBoard(["real0000000000000000000000000001"]);
    git(["init", "-q"]);
    git(["config", "user.email", "p5-git@test.local"]);
    git(["config", "user.name", "P5"]);
    git(["commit", "-q", "--allow-empty", "-m", "init"]);
    const headBefore = git(["rev-parse", "HEAD"]).trim();

    const r = await commitTaskPathsOperation(ctx, { id: "ghost", message: "x" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("TASK_NOT_FOUND");
    expect(r.error.message).toBe("Task not found: ghost");
    expect(git(["rev-parse", "HEAD"]).trim()).toBe(headBefore);
  });

  it("never falls back to the local store when the board is unreachable", async () => {
    // A local record with the same prefix exists — a local fallback would
    // resolve it. The board stays authoritative: unreachable refuses.
    seedClone("ghost-local-00000000000000000001");
    git(["init", "-q"]);
    git(["config", "user.email", "p5-git@test.local"]);
    git(["config", "user.name", "P5"]);
    git(["commit", "-q", "--allow-empty", "-m", "init"]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("fetch failed")),
    );

    const r = await commitTaskPathsOperation(ctx, {
      id: "ghost-lo",
      message: "x",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    // Transport refusal, never a silent local resolution of the same prefix.
    expect(r.error.code).not.toBe("TASK_NOT_FOUND");
    expect(r.error.message).toContain("fetch failed");
  });
});
