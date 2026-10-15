/**
 * CLI e2e — parent links in SaaS (online) mode are HONOURED, never refused.
 *
 * The v0 backend CAN express parent links (`links: [{ taskId, type }]`
 * on POST and PATCH), so the CLI-online `--add --parent` /
 * `--edit --set-parent` / `--no-parent` flags write them instead of
 * answering E_USAGE — the same answer the hosted MCP surface gives for
 * `create_task {parent}` / `update_task {parent}` (parity ticket
 * 53c2b790edc71d977ad4250565ddbb, governing contract 831590027ba7d8056c09c39deb4720).
 *
 * The fake backend below emulates the v0 validation the real server does
 * (parent targets must exist; self-links refused) so the refusal-code
 * assertions (INVALID_LINKS, verbatim) prove the CLI surfaces the backend's
 * own code rather than inventing its own.
 *
 * Non-vacuity proof: with the `links` pass-through removed from
 * `createSaasTask`/`updateSaasTask`, the "honoured" tests fail (no links
 * reach the backend / PATCH body has no links key); with the serverCode
 * mapping removed, the INVALID_LINKS tests fail (E_BACKEND_UNAVAILABLE).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { spawnCli } from "./mcp-helpers.js";

const cleanups: Array<() => void> = [];
function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A home directory that makes the CLI take the online (SaaS) branch. */
function saasHome(): string {
  const home = freshDir("saas-parent-home-");
  mkdirSync(join(home, ".vibeflow"), { recursive: true });
  writeFileSync(join(home, ".vibeflow", "token"), "test-token", "utf-8");
  return home;
}

type RecordedRequest = { method: string; url: string; body: string };
type Link = { taskId: string; type: string };
type FakeTask = {
  id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  type: string;
  boardId: string;
  createdAt: string;
  updatedAt: string;
  links: Link[];
};

function makeTask(id: string, title: string, links: Link[] = []): FakeTask {
  return {
    id,
    title,
    description: "",
    status: "todo",
    priority: "Medium",
    type: "Task",
    boardId: "board-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    links,
  };
}

/**
 * A fake v0 backend with an in-memory board: parents p1/p2, a peer r1, and
 * a child c1 (parent p1 + a relates link to r1, so the swap/clear tests
 * prove relates links survive). POST validates parent targets exist;
 * PATCH replaces the whole link set and validates parent entries
 * (exists, not self) — the same INVALID_LINKS refusals the real routes
 * answer.
 */
async function startFakeBackend(): Promise<{
  url: string;
  requests: RecordedRequest[];
  tasks: Map<string, FakeTask>;
}> {
  const requests: RecordedRequest[] = [];
  const tasks = new Map<string, FakeTask>([
    ["p1", makeTask("p1", "Parent one")],
    ["p2", makeTask("p2", "Parent two")],
    ["r1", makeTask("r1", "Peer")],
    [
      "c1",
      makeTask("c1", "Child of p1", [
        { taskId: "p1", type: "parent" },
        { taskId: "r1", type: "relates" },
      ]),
    ],
  ]);
  const server: Server = createServer((req, res) => {
    const finish = (code: number, payload: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const url = req.url ?? "";
    if (req.method === "GET" && url.startsWith("/api/v0/tasks")) {
      if (/\/api\/v0\/tasks\/[^/]+\/comments$/.test(url)) {
        finish(200, { comments: [] });
        return;
      }
      if (/\/api\/v0\/tasks\/[^/]+\/files$/.test(url)) {
        finish(200, { files: [] });
        return;
      }
      finish(200, { items: [...tasks.values()], nextCursor: null });
      return;
    }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url, body });
      const parsed = (body ? JSON.parse(body) : {}) as {
        title?: string;
        links?: Link[];
      };
      const checkParent = (
        links: Link[] | undefined,
        selfId?: string,
      ): { code: string; message: string } | null => {
        for (const l of links ?? []) {
          if (l.type !== "parent") continue;
          if (selfId !== undefined && l.taskId === selfId)
            return { code: "INVALID_LINKS", message: "a task cannot link to itself" };
          if (!tasks.has(l.taskId))
            return {
              code: "INVALID_LINKS",
              message: `Parent target task ${l.taskId} not found`,
            };
        }
        return null;
      };
      if (req.method === "POST" && url === "/api/v0/tasks") {
        const bad = checkParent(parsed.links);
        if (bad) {
          finish(400, { error: bad.message, code: bad.code });
          return;
        }
        const created = makeTask(
          `new-${tasks.size + 1}`,
          parsed.title ?? "Untitled",
          parsed.links ?? [],
        );
        tasks.set(created.id, created);
        finish(201, created);
        return;
      }
      const patchMatch = url.match(/^\/api\/v0\/tasks\/([^/]+)$/);
      if (req.method === "PATCH" && patchMatch) {
        const id = decodeURIComponent(patchMatch[1]);
        const existing = tasks.get(id);
        if (!existing) {
          finish(404, { error: "Task not found", code: "NOT_FOUND" });
          return;
        }
        if (parsed.links !== undefined) {
          const bad = checkParent(parsed.links, id);
          if (bad) {
            finish(400, { error: bad.message, code: bad.code });
            return;
          }
          existing.links = parsed.links;
        }
        finish(200, { ...existing });
        return;
      }
      finish(404, { error: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, requests, tasks };
}

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function patchBodies(requests: RecordedRequest[], id: string): unknown[] {
  return requests
    .filter((q) => q.method === "PATCH" && q.url === `/api/v0/tasks/${id}`)
    .map((q) => JSON.parse(q.body || "{}") as unknown);
}

function postBodies(requests: RecordedRequest[]): unknown[] {
  return requests
    .filter((q) => q.method === "POST" && q.url === "/api/v0/tasks")
    .map((q) => JSON.parse(q.body || "{}") as unknown);
}

describe("tasks --add --parent in SaaS mode is honoured", () => {
  it("--add --parent POSTs the parent link and the child reads back linked", async () => {
    const store = freshDir("saas-parent-store-");
    const home = saasHome();
    const { url, requests } = await startFakeBackend();

    const r = await spawnCli(
      ["tasks", store, "--add", "--title", "Kid", "--parent", "p1", "--json"],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(r.code).toBe(0);
    const posts = postBodies(requests);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      title: "Kid",
      links: [{ taskId: "p1", type: "parent" }],
    });
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      task: { id: string; links: Link[] };
    };
    expect(payload.ok).toBe(true);
    expect(
      payload.task.links.some((l) => l.taskId === "p1" && l.type === "parent"),
    ).toBe(true);
  });

  it("--add --parent with a dangling target is refused INVALID_LINKS (the backend code, verbatim)", async () => {
    const store = freshDir("saas-parent-store-");
    const home = saasHome();
    const { url } = await startFakeBackend();

    const r = await spawnCli(
      ["tasks", store, "--add", "--title", "Orphan", "--parent", "ghost", "--json"],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(r.code).not.toBe(0);
    expect(r.stdout.trim()).toBe("");
    const envelope = JSON.parse(r.stderr) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("INVALID_LINKS");
    expect(envelope.error.message).toContain("ghost");
  });

  it("--add --parent --dry-run previews the link and sends no POST", async () => {
    const store = freshDir("saas-parent-store-");
    const home = saasHome();
    const { url, requests } = await startFakeBackend();

    const r = await spawnCli(
      ["tasks", store, "--add", "--title", "Kid", "--parent", "p1", "--dry-run", "--json"],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(r.code).toBe(0);
    expect(postBodies(requests)).toEqual([]);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      dryRun: boolean;
      task: { links?: Link[] };
    };
    expect(payload.ok).toBe(true);
    expect(payload.dryRun).toBe(true);
    expect(payload.task.links).toEqual([{ taskId: "p1", type: "parent" }]);
  });
});

describe("tasks --edit --set-parent/--no-parent in SaaS mode is honoured", () => {
  it("--set-parent swaps the parent and preserves relates links", async () => {
    const store = freshDir("saas-parent-store-");
    const home = saasHome();
    const { url, tasks } = await startFakeBackend();

    const r = await spawnCli(
      ["tasks", store, "--edit", "c1", "--set-parent", "p2", "--json"],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(r.code).toBe(0);
    // Replace semantics: the old parent is swapped out, the relates link kept.
    expect(tasks.get("c1")!.links).toEqual([
      { taskId: "r1", type: "relates" },
      { taskId: "p2", type: "parent" },
    ]);
    const payload = JSON.parse(r.stdout) as { ok: boolean };
    expect(payload.ok).toBe(true);
  });

  it("--no-parent clears the parent and keeps relates links", async () => {
    const store = freshDir("saas-parent-store-");
    const home = saasHome();
    const { url, tasks } = await startFakeBackend();

    const r = await spawnCli(
      ["tasks", store, "--edit", "c1", "--no-parent", "--json"],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(r.code).toBe(0);
    expect(tasks.get("c1")!.links).toEqual([{ taskId: "r1", type: "relates" }]);
  });

  it("--set-parent with a dangling target is refused INVALID_LINKS and writes nothing", async () => {
    const store = freshDir("saas-parent-store-");
    const home = saasHome();
    const { url, requests, tasks } = await startFakeBackend();

    const r = await spawnCli(
      ["tasks", store, "--edit", "c1", "--set-parent", "ghost", "--json"],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(r.code).not.toBe(0);
    expect(r.stdout.trim()).toBe("");
    const envelope = JSON.parse(r.stderr) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("INVALID_LINKS");
    // The refused PATCH wrote nothing: the old parent still stands.
    expect(patchBodies(requests, "c1")).toHaveLength(1);
    expect(tasks.get("c1")!.links).toEqual([
      { taskId: "p1", type: "parent" },
      { taskId: "r1", type: "relates" },
    ]);
  });

  it("--set-parent --dry-run previews the merged links and sends no PATCH", async () => {
    const store = freshDir("saas-parent-store-");
    const home = saasHome();
    const { url, requests } = await startFakeBackend();

    const r = await spawnCli(
      ["tasks", store, "--edit", "c1", "--set-parent", "p2", "--dry-run", "--json"],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(r.code).toBe(0);
    expect(patchBodies(requests, "c1")).toEqual([]);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      dryRun: boolean;
      updates: { links?: Link[] };
    };
    expect(payload.ok).toBe(true);
    expect(payload.dryRun).toBe(true);
    expect(payload.updates.links).toEqual([
      { taskId: "r1", type: "relates" },
      { taskId: "p2", type: "parent" },
    ]);
  });
});

describe("tasks list in SaaS mode hides children by default", () => {
  it("roots exclude the child and hiddenChildren names it; --children includes it", async () => {
    const store = freshDir("saas-parent-store-");
    const home = saasHome();
    const { url } = await startFakeBackend();

    const roots = await spawnCli(["tasks", store, "--json", "--limit", "0"], {
      cwd: store,
      home,
      env: { VIBEFLOW_API_URL: url },
    });
    expect(roots.code).toBe(0);
    const rootPayload = JSON.parse(roots.stdout) as {
      ok: boolean;
      tasks: Array<{ id: string }>;
      hiddenChildren: number;
    };
    const rootIds = rootPayload.tasks.map((t) => t.id);
    expect(rootIds).toContain("p1");
    expect(rootIds).not.toContain("c1");
    expect(rootPayload.hiddenChildren).toBe(1);

    const all = await spawnCli(
      ["tasks", store, "--json", "--limit", "0", "--children"],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(all.code).toBe(0);
    const allPayload = JSON.parse(all.stdout) as {
      ok: boolean;
      tasks: Array<{ id: string }>;
      hiddenChildren: number;
    };
    expect(allPayload.tasks.map((t) => t.id)).toContain("c1");
    expect(allPayload.hiddenChildren).toBe(0);
  });
});
