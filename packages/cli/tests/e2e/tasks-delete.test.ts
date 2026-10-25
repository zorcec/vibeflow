/**
 * CLI e2e — `tasks --delete <id> [--yes]` in local and SaaS (online) mode.
 *
 * Deleting is a destructive operation, so the command is a two-step:
 * without --yes it only prints what WOULD be deleted and exits non-zero;
 * with --yes it deletes. `--yes --dry-run` reports the confirmed plan
 * and exits 0 with ZERO mutations in both stores (no DELETE sent online,
 * no file unlinked locally). The two stores delete differently:
 *   - local: DELETE drops just the one row, so a parent with children is
 *     refused even WITH --yes (delete the children first, deepest first);
 *   - online: the v0 DELETE CASCADES — the server deletes the whole
 *     descendant cone — so a parent delete proceeds WITH an explicit
 *     warning naming every descendant, reports the server's `deletedIds`,
 *     and drops the matching local records so a later push cannot
 *     recreate them.
 *
 * Non-vacuity proof: with the `--yes` gate removed, the "refuses without
 * --yes" tests fail (the task is gone); with the local children check
 * removed, the local parent test fails (the parent is gone and the child
 * is orphaned); with `--dry-run` falling through to the write, the
 * dry-run tests fail (the task is gone / a DELETE was recorded); with the
 * cascade fake replaced by a single-row DELETE, the online parent test
 * fails (the child survives); with the local cleanup removed, the
 * push test fails (the deleted id travels in the push set again).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { spawnCli, seedTask } from "./mcp-helpers.js";
import { setupSaaSMode } from "../helpers/saas-auth.js";
import { listTasks } from "../../src/core/tasks.js";

const cleanups: Array<() => void> = [];
function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A home WITHOUT a token file, so the CLI takes the local branch. */
function localHome(): string {
  return freshDir("delete-local-home-");
}

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

async function addTask(
  store: string,
  home: string,
  extraArgs: string[],
  env?: Record<string, string>,
): Promise<string> {
  const r = await spawnCli(["tasks", store, "--add", ...extraArgs, "--json"], {
    cwd: store,
    home,
    ...(env ? { env } : {}),
  });
  expect(r.code).toBe(0);
  const payload = JSON.parse(r.stdout) as { ok: boolean; task: { id: string } };
  expect(payload.ok).toBe(true);
  return payload.task.id;
}

async function getCode(
  store: string,
  home: string,
  id: string,
  env?: Record<string, string>,
): Promise<number | null> {
  const r = await spawnCli(["tasks", store, "--get", id, "--json"], {
    cwd: store,
    home,
    ...(env ? { env } : {}),
  });
  return r.code;
}

describe("tasks --delete in local mode", () => {
  it("without --yes prints what would be deleted, exits non-zero, deletes nothing", async () => {
    const store = freshDir("delete-local-store-");
    const home = localHome();
    const id = await addTask(store, home, ["--title", "Doomed"]);

    const r = await spawnCli(["tasks", store, "--delete", id], {
      cwd: store,
      home,
    });
    expect(r.code).not.toBe(0);
    expect(r.stdout).toContain(id);
    expect(r.stdout).toContain("--yes");
    // Nothing was written: the task still reads back.
    expect(await getCode(store, home, id)).toBe(0);
  });

  it("with --yes deletes; --get afterwards is TASK_NOT_FOUND; --json carries { ok, deleted, id, deletedIds }", async () => {
    const store = freshDir("delete-local-store-");
    const home = localHome();
    const id = await addTask(store, home, ["--title", "Doomed"]);

    const r = await spawnCli(["tasks", store, "--delete", id, "--yes", "--json"], {
      cwd: store,
      home,
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, deleted: true, id, deletedIds: [id] });
    expect(await getCode(store, home, id)).not.toBe(0);
  });

  it("--yes --dry-run deletes nothing: exit 0, dryRun payload, task survives", async () => {
    const store = freshDir("delete-local-store-");
    const home = localHome();
    const id = await addTask(store, home, ["--title", "Doomed"]);

    const r = await spawnCli(
      ["tasks", store, "--delete", id, "--yes", "--dry-run", "--json"],
      { cwd: store, home },
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      ok: true,
      dryRun: true,
      id,
      deletedIds: [id],
    });
    // ZERO mutations: the task still reads back.
    expect(await getCode(store, home, id)).toBe(0);

    // The human rendering names the plan and deletes nothing either.
    const human = await spawnCli(
      ["tasks", store, "--delete", id, "--yes", "--dry-run"],
      { cwd: store, home },
    );
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("[dry-run]");
    expect(human.stdout).toContain(id);
    expect(await getCode(store, home, id)).toBe(0);
  });

  it("refuses an empty id cleanly and deletes nothing", async () => {
    const store = freshDir("delete-local-store-");
    const home = localHome();
    // Exactly one task: the old startsWith("") resolution would have
    // matched (and deleted) it — the empty id must refuse instead.
    const id = await addTask(store, home, ["--title", "Lone"]);

    const r = await spawnCli(["tasks", store, "--delete", "", "--yes", "--json"], {
      cwd: store,
      home,
    });
    expect(r.code).not.toBe(0);
    const envelope = JSON.parse(r.stderr) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("TASK_NOT_FOUND");
    expect(await getCode(store, home, id)).toBe(0);
  });

  it("resolves a unique prefix", async () => {
    const store = freshDir("delete-local-store-");
    const home = localHome();
    const id = await addTask(store, home, ["--title", "Doomed"]);

    const r = await spawnCli(
      ["tasks", store, "--delete", id.slice(0, 8), "--yes", "--json"],
      { cwd: store, home },
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, deleted: true, id, deletedIds: [id] });
    expect(await getCode(store, home, id)).not.toBe(0);
  });

  it("refuses an ambiguous prefix, naming the candidates", async () => {
    const store = freshDir("delete-local-store-");
    const home = localHome();
    seedTask(store, { id: "aaa111aaa111", title: "One", status: "todo" });
    seedTask(store, { id: "aaa222aaa222", title: "Two", status: "todo" });

    const r = await spawnCli(["tasks", store, "--delete", "aaa", "--yes", "--json"], {
      cwd: store,
      home,
    });
    expect(r.code).not.toBe(0);
    const envelope = JSON.parse(r.stderr) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("E_AMBIGUOUS");
    expect(envelope.error.message).toContain("aaa111aaa111");
    expect(envelope.error.message).toContain("aaa222aaa222");
    // Both tasks survive.
    expect(await getCode(store, home, "aaa111aaa111")).toBe(0);
    expect(await getCode(store, home, "aaa222aaa222")).toBe(0);
  });

  it("refuses an unknown id with TASK_NOT_FOUND", async () => {
    const store = freshDir("delete-local-store-");
    const home = localHome();

    const r = await spawnCli(["tasks", store, "--delete", "ghost", "--yes", "--json"], {
      cwd: store,
      home,
    });
    expect(r.code).not.toBe(0);
    const envelope = JSON.parse(r.stderr) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(envelope.error.code).toBe("TASK_NOT_FOUND");
    expect(envelope.error.message).toContain("ghost");
  });

  it("refuses a parent with children even WITH --yes; deleting children first unblocks the parent", async () => {
    const store = freshDir("delete-local-store-");
    const home = localHome();
    const parentId = await addTask(store, home, ["--title", "Parent"]);
    const childId = await addTask(store, home, [
      "--title",
      "Child",
      "--parent",
      parentId,
    ]);

    const refused = await spawnCli(
      ["tasks", store, "--delete", parentId, "--yes", "--json"],
      { cwd: store, home },
    );
    expect(refused.code).not.toBe(0);
    const envelope = JSON.parse(refused.stderr) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(envelope.error.code).toBe("HAS_CHILDREN");
    expect(envelope.error.message).toContain(childId);
    // Both survive.
    expect(await getCode(store, home, parentId)).toBe(0);
    expect(await getCode(store, home, childId)).toBe(0);

    // The preview (no --yes) states the children too and deletes nothing.
    const preview = await spawnCli(["tasks", store, "--delete", parentId], {
      cwd: store,
      home,
    });
    expect(preview.code).not.toBe(0);
    expect(preview.stdout).toContain("child");
    expect(preview.stdout).toContain(childId);
    expect(await getCode(store, home, parentId)).toBe(0);

    // Deepest first: the child deletes, then the parent deletes.
    expect(
      (
        await spawnCli(["tasks", store, "--delete", childId, "--yes"], {
          cwd: store,
          home,
        })
      ).code,
    ).toBe(0);
    expect(
      (
        await spawnCli(["tasks", store, "--delete", parentId, "--yes"], {
          cwd: store,
          home,
        })
      ).code,
    ).toBe(0);
    expect(await getCode(store, home, parentId)).not.toBe(0);
    expect(await getCode(store, home, childId)).not.toBe(0);
  });

  it("refuses --yes without --delete", async () => {
    const store = freshDir("delete-local-store-");
    const home = localHome();

    const r = await spawnCli(["tasks", store, "--yes", "--json"], {
      cwd: store,
      home,
    });
    expect(r.code).not.toBe(0);
    const envelope = JSON.parse(r.stderr) as {
      ok: boolean;
      error: { code: string };
    };
    expect(envelope.error.code).toBe("E_USAGE");
  });
});

type SaasLink = { taskId: string; type: string };
type FakeTask = {
  id: string;
  title: string;
  status: string;
  links: SaasLink[];
};

/**
 * A fake v0 backend with an in-memory board: list + detail reads and a
 * CASCADING DELETE (the real `DELETE /api/v0/tasks/:id` deletes the whole
 * descendant cone and answers `{ success, deletedIds }` — the fake does
 * the same, so a CLI that assumed a single-row write would leave children
 * behind fails here). `pageSize` splits the list into cursor pages (the
 * cursor is a numeric offset); without it the board answers in one page.
 */
async function startFakeBackend(opts?: { pageSize?: number }): Promise<{
  url: string;
  deletes: string[];
  tasks: Map<string, FakeTask>;
}> {
  const deletes: string[] = [];
  const tasks = new Map<string, FakeTask>([
    { id: "p1", title: "Parent one", status: "todo", links: [] },
    {
      id: "c1",
      title: "Child of p1",
      status: "todo",
      links: [{ taskId: "p1", type: "parent" }],
    },
    { id: "s1", title: "Solo", status: "todo", links: [] },
    { id: "s2", title: "Solo two", status: "todo", links: [] },
    { id: "ab1", title: "Ambig one", status: "todo", links: [] },
    { id: "ab2", title: "Ambig two", status: "todo", links: [] },
  ].map((t) => [t.id, t]));
  /** Every descendant of `rootId` by following parent links (BFS). */
  const coneOf = (rootId: string): string[] => {
    const seen = new Set<string>([rootId]);
    const out: string[] = [];
    const queue = [rootId];
    while (queue.length > 0) {
      const parent = queue.shift()!;
      for (const t of tasks.values()) {
        if (
          !seen.has(t.id) &&
          t.links.some((l) => l.type === "parent" && l.taskId === parent)
        ) {
          seen.add(t.id);
          out.push(t.id);
          queue.push(t.id);
        }
      }
    }
    return out;
  };
  const server: Server = createServer((req, res) => {
    const finish = (code: number, payload: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const url = req.url ?? "";
    if (req.method === "GET" && url.startsWith("/api/v0/tasks")) {
      const detailMatch = url.match(/^\/api\/v0\/tasks\/([^/?]+)/);
      if (detailMatch) {
        const task = tasks.get(decodeURIComponent(detailMatch[1]));
        if (!task) {
          finish(404, { error: "Task not found", code: "NOT_FOUND" });
          return;
        }
        finish(200, { ...task, comments: [], files: [] });
        return;
      }
      const all = [...tasks.values()].map((t) => ({
        ...t,
        comments: [],
        files: [],
      }));
      // Cursor pages when the test asked for them (cursor = numeric
      // offset); otherwise the whole board in one page.
      const size = opts?.pageSize;
      if (size === undefined) {
        finish(200, { items: all, nextCursor: null });
        return;
      }
      const listUrl = new URL(url, "http://127.0.0.1");
      const offset = Number(listUrl.searchParams.get("cursor") ?? "0");
      const page = all.slice(offset, offset + size);
      finish(200, {
        items: page,
        nextCursor:
          offset + page.length < all.length
            ? String(offset + page.length)
            : null,
      });
      return;
    }
    if (req.method === "DELETE") {
      const match = url.match(/^\/api\/v0\/tasks\/([^/?]+)/);
      if (match) {
        const id = decodeURIComponent(match[1]);
        if (!tasks.has(id)) {
          finish(404, { error: "Task not found", code: "NOT_FOUND" });
          return;
        }
        // CASCADE, like the real route: the whole cone goes, root first.
        const doomed = [id, ...coneOf(id)];
        for (const doomedId of doomed) {
          deletes.push(doomedId);
          tasks.delete(doomedId);
        }
        finish(200, { success: true, deletedIds: doomed });
        return;
      }
    }
    finish(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, deletes, tasks };
}

describe("tasks --delete in SaaS mode", () => {
  it("without --yes previews and deletes nothing; with --yes it DELETEs", async () => {
    const store = freshDir("delete-saas-store-");
    const home = freshDir("delete-saas-home-");
    const { url, deletes, tasks } = await startFakeBackend();
    setupSaaSMode({ home, store, apiUrl: url });
    const env = { VIBEFLOW_API_URL: url };

    const preview = await spawnCli(["tasks", store, "--delete", "s1"], {
      cwd: store,
      home,
      env,
    });
    expect(preview.code).not.toBe(0);
    expect(preview.stdout).toContain("s1");
    expect(tasks.has("s1")).toBe(true);
    expect(deletes).toEqual([]);

    const r = await spawnCli(["tasks", store, "--delete", "s1", "--yes", "--json"], {
      cwd: store,
      home,
      env,
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      ok: true,
      deleted: true,
      id: "s1",
      deletedIds: ["s1"],
    });
    expect(tasks.has("s1")).toBe(false);
    expect(deletes).toEqual(["s1"]);
  });

  it("--yes --dry-run deletes nothing: exit 0, dryRun payload, no DELETE sent", async () => {
    const store = freshDir("delete-saas-store-");
    const home = freshDir("delete-saas-home-");
    const { url, deletes, tasks } = await startFakeBackend();
    setupSaaSMode({ home, store, apiUrl: url });
    const env = { VIBEFLOW_API_URL: url };

    const r = await spawnCli(
      ["tasks", store, "--delete", "s1", "--yes", "--dry-run", "--json"],
      { cwd: store, home, env },
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      ok: true,
      dryRun: true,
      id: "s1",
      deletedIds: ["s1"],
    });
    // ZERO mutations: no DELETE reached the fake and the task survives.
    expect(deletes).toEqual([]);
    expect(tasks.has("s1")).toBe(true);
  });

  it("a parent delete warns of the cascade, deletes the cone, and reports deletedIds", async () => {
    const store = freshDir("delete-saas-store-");
    const home = freshDir("delete-saas-home-");
    const { url, deletes, tasks } = await startFakeBackend();
    setupSaaSMode({ home, store, apiUrl: url });
    const env = { VIBEFLOW_API_URL: url };

    // The preview names the cascade and deletes nothing.
    const preview = await spawnCli(["tasks", store, "--delete", "p1"], {
      cwd: store,
      home,
      env,
    });
    expect(preview.code).not.toBe(0);
    expect(preview.stdout).toContain("CASCADE");
    expect(preview.stdout).toContain("c1");
    expect(tasks.has("p1")).toBe(true);
    expect(tasks.has("c1")).toBe(true);
    expect(deletes).toEqual([]);

    const r = await spawnCli(["tasks", store, "--delete", "p1", "--yes", "--json"], {
      cwd: store,
      home,
      env,
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      ok: true,
      deleted: true,
      id: "p1",
      deletedIds: ["p1", "c1"],
    });
    // The cone is gone server-side: the parent AND the child.
    expect(tasks.has("p1")).toBe(false);
    expect(tasks.has("c1")).toBe(false);
    expect(deletes).toEqual(["p1", "c1"]);
  });

  it("refuses an empty id cleanly and sends no DELETE", async () => {
    const store = freshDir("delete-saas-store-");
    const home = freshDir("delete-saas-home-");
    const { url, deletes, tasks } = await startFakeBackend();
    setupSaaSMode({ home, store, apiUrl: url });
    const env = { VIBEFLOW_API_URL: url };

    const r = await spawnCli(["tasks", store, "--delete", "", "--yes", "--json"], {
      cwd: store,
      home,
      env,
    });
    expect(r.code).not.toBe(0);
    const envelope = JSON.parse(r.stderr) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("TASK_NOT_FOUND");
    expect(deletes).toEqual([]);
    expect(tasks.size).toBe(6);
  });

  it("refuses unknown and ambiguous ids before any DELETE", async () => {
    const store = freshDir("delete-saas-store-");
    const home = freshDir("delete-saas-home-");
    const { url, deletes } = await startFakeBackend();
    setupSaaSMode({ home, store, apiUrl: url });
    const env = { VIBEFLOW_API_URL: url };

    const unknown = await spawnCli(["tasks", store, "--delete", "ghost", "--yes", "--json"], {
      cwd: store,
      home,
      env,
    });
    expect(unknown.code).not.toBe(0);
    expect(
      (JSON.parse(unknown.stderr) as { error: { code: string } }).error.code,
    ).toBe("TASK_NOT_FOUND");

    const ambiguous = await spawnCli(["tasks", store, "--delete", "ab", "--yes", "--json"], {
      cwd: store,
      home,
      env,
    });
    expect(ambiguous.code).not.toBe(0);
    const ambEnvelope = JSON.parse(ambiguous.stderr) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(ambEnvelope.error.code).toBe("E_AMBIGUOUS");
    expect(ambEnvelope.error.message).toContain("ab1");
    expect(ambEnvelope.error.message).toContain("ab2");

    expect(deletes).toEqual([]);
  });

  it("finds a child beyond the old page window: the cascade warning names it", async () => {
    // The listing used to stop after 50 pages: a child reparented onto a
    // later page fell outside the window and the guard missed it. The
    // board below puts the parent on page 1 and its child on page 56
    // (pageSize 1) — past the old cap — so a half-read board would delete
    // the parent without ever naming the child.
    const store = freshDir("delete-saas-store-");
    const home = freshDir("delete-saas-home-");
    const { url, deletes, tasks } = await startFakeBackend({ pageSize: 1 });
    setupSaaSMode({ home, store, apiUrl: url });
    // Widen the board: the default 5 stay on pages 1-5; 50 fillers push
    // the reparented child c1 to page 56 by re-inserting it last.
    const child = tasks.get("c1")!;
    tasks.delete("c1");
    for (let i = 0; i < 50; i++) {
      const id = `f${String(i).padStart(2, "0")}`;
      tasks.set(id, { id, title: `Filler ${i}`, status: "todo", links: [] });
    }
    tasks.set("c1", child);
    const env = { VIBEFLOW_API_URL: url };

    const preview = await spawnCli(["tasks", store, "--delete", "p1"], {
      cwd: store,
      home,
      env,
    });
    expect(preview.code).not.toBe(0);
    expect(preview.stdout).toContain("CASCADE");
    expect(preview.stdout).toContain("c1");
    expect(deletes).toEqual([]);

    const r = await spawnCli(["tasks", store, "--delete", "p1", "--yes", "--json"], {
      cwd: store,
      home,
      env,
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      ok: true,
      deleted: true,
      id: "p1",
      deletedIds: ["p1", "c1"],
    });
    expect(tasks.has("p1")).toBe(false);
    expect(tasks.has("c1")).toBe(false);
  });

  it("an online delete drops the local record so a later push cannot recreate it", async () => {
    const store = freshDir("delete-saas-store-");
    const home = freshDir("delete-saas-home-");
    const { url, tasks } = await startFakeBackend();
    setupSaaSMode({ home, store, apiUrl: url });
    const env = { VIBEFLOW_API_URL: url };
    // The same ids live in BOTH stores: the fake board carries s1/s2 and
    // local rows with the same ids are seeded beside them. s2 is the
    // control that stays everywhere; s1 is deleted.
    seedTask(store, { id: "s1", title: "Solo", status: "todo" });
    seedTask(store, { id: "s2", title: "Solo two", status: "todo" });

    const r = await spawnCli(["tasks", store, "--delete", "s1", "--yes", "--json"], {
      cwd: store,
      home,
      env,
    });
    expect(r.code).toBe(0);
    expect(tasks.has("s1")).toBe(false);
    // The local record for the remotely-deleted id is gone too...
    expect(listTasks(store).some((t) => t.id === "s1")).toBe(false);

    // ...so a later push has nothing to re-push: the board already holds
    // every remaining local task and the push set is empty.
    const pushed = await spawnCli(
      ["push", store, "--board", "board-1", "--dry-run"],
      { cwd: store, home, env },
    );
    // Wording fix: the no-op line is now "Nothing to push ..." — a
    // zero-create is not a push, so it never reads "Pushed 0".
    expect(pushed.stdout).toContain("Nothing to push");
  });
});
