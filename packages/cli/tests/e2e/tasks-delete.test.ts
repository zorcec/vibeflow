/**
 * CLI e2e — `tasks --delete <id> [--yes]` in local and SaaS (online) mode.
 *
 * Deleting is a destructive operation, so the command is a two-step:
 * without --yes it only prints what WOULD be deleted and exits non-zero;
 * with --yes it deletes. A parent with children is refused even WITH --yes
 * (neither the local server route nor the online DELETE cascades — deleting
 * the row would leave the children with a dangling parent link — so the CLI
 * refuses rather than silently orphaning them; delete the children first).
 *
 * Non-vacuity proof: with the `--yes` gate removed, the "refuses without
 * --yes" tests fail (the task is gone); with the children check removed, the
 * parent tests fail (the parent is gone and the child is orphaned); with the
 * SaaS DELETE replaced by a PATCH, the online tests fail (the fake has no
 * PATCH-detail route for the delete path — the task survives).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { spawnCli, seedTask } from "./mcp-helpers.js";

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

/** A home that makes the CLI take the online (SaaS) branch. */
function saasHome(): string {
  const home = freshDir("delete-saas-home-");
  mkdirSync(join(home, ".vibeflow"), { recursive: true });
  writeFileSync(join(home, ".vibeflow", "token"), "test-token", "utf-8");
  return home;
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

  it("with --yes deletes; --get afterwards is TASK_NOT_FOUND; --json carries { ok, deleted, id }", async () => {
    const store = freshDir("delete-local-store-");
    const home = localHome();
    const id = await addTask(store, home, ["--title", "Doomed"]);

    const r = await spawnCli(["tasks", store, "--delete", id, "--yes", "--json"], {
      cwd: store,
      home,
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, deleted: true, id });
    expect(await getCode(store, home, id)).not.toBe(0);
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
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, deleted: true, id });
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
 * single-row DELETE (404 when the row is already gone). No cascade: deleting
 * a parent leaves its children in place, which is exactly why the CLI
 * refuses parents with children before ever sending the request.
 */
async function startFakeBackend(): Promise<{
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
    { id: "ab1", title: "Ambig one", status: "todo", links: [] },
    { id: "ab2", title: "Ambig two", status: "todo", links: [] },
  ].map((t) => [t.id, t]));
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
      finish(200, {
        items: [...tasks.values()].map((t) => ({ ...t, comments: [], files: [] })),
        nextCursor: null,
      });
      return;
    }
    if (req.method === "DELETE") {
      const match = url.match(/^\/api\/v0\/tasks\/([^/?]+)/);
      if (match) {
        const id = decodeURIComponent(match[1]);
        deletes.push(id);
        if (!tasks.has(id)) {
          finish(404, { error: "Task not found", code: "NOT_FOUND" });
          return;
        }
        tasks.delete(id);
        finish(200, { success: true });
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
    const home = saasHome();
    const { url, deletes, tasks } = await startFakeBackend();
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
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, deleted: true, id: "s1" });
    expect(tasks.has("s1")).toBe(false);
    expect(deletes).toEqual(["s1"]);
  });

  it("refuses a parent with children even WITH --yes and sends no DELETE", async () => {
    const store = freshDir("delete-saas-store-");
    const home = saasHome();
    const { url, deletes, tasks } = await startFakeBackend();
    const env = { VIBEFLOW_API_URL: url };

    const r = await spawnCli(["tasks", store, "--delete", "p1", "--yes", "--json"], {
      cwd: store,
      home,
      env,
    });
    expect(r.code).not.toBe(0);
    const envelope = JSON.parse(r.stderr) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(envelope.error.code).toBe("HAS_CHILDREN");
    expect(envelope.error.message).toContain("c1");
    expect(tasks.has("p1")).toBe(true);
    expect(deletes).toEqual([]);
  });

  it("refuses unknown and ambiguous ids before any DELETE", async () => {
    const store = freshDir("delete-saas-store-");
    const home = saasHome();
    const { url, deletes } = await startFakeBackend();
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
});
