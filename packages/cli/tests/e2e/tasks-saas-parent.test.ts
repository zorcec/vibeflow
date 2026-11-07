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
 * Id-like flag values are resolved against the online board BEFORE the
 * write: an exact id is used as-is, a unique prefix resolves to the full
 * id, an ambiguous prefix is refused naming the candidates, and an unknown
 * --parent / --set-parent value is refused INVALID_LINKS by the CLI's own
 * client-side pre-check (a dangling parent is a LINK problem — the same
 * code the server answers for the same mistake, and the same code the
 * local path reports) — none of them ever reach the server unresolved. The fake backend
 * below emulates the v0 validation the real server does (parent targets
 * must exist; self-links refused) so the remaining refusal-code assertions
 * (INVALID_LINKS, verbatim) prove the CLI surfaces the backend's own code
 * for server-side refusals (e.g. cycles) rather than inventing its own.
 *
 * Non-vacuity proof: with the `links` pass-through removed from
 * `createSaasTask`/`updateSaasTask`, the "honoured" tests fail (no links
 * reach the backend / PATCH body has no links key); with the serverCode
 * mapping removed, the self-link test fails (E_BACKEND_UNAVAILABLE); with
 * the pre-write resolution removed, the prefix tests fail (the raw prefix
 * hits the backend and is refused INVALID_LINKS) and the dangling tests
 * fail (no pre-check code, and a POST/PATCH is sent).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { spawnCli } from "./mcp-helpers.js";
import { setupSaaSMode } from "../helpers/saas-auth.js";

const cleanups: Array<() => void> = [];
function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
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
  /** Annotation fields the real v0 view carries (tickets 9029e53c/684114fb). */
  url?: string;
  selector?: string;
  cssSelector?: string;
  tags?: string[];
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
 * A fake v0 backend with an in-memory board: parents 9f2c7a41aa01/9f2c7a41bb02, a peer 7d1e0b55cc03, and
 * a child 3b8f9d12dd04 (parent 9f2c7a41aa01 + a relates link to 7d1e0b55cc03, so the swap/clear tests
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
    ["9f2c7a41aa01", makeTask("9f2c7a41aa01", "Parent one")],
    ["9f2c7a41bb02", makeTask("9f2c7a41bb02", "Parent two")],
    ["7d1e0b55cc03", makeTask("7d1e0b55cc03", "Peer")],
    [
      "3b8f9d12dd04",
      makeTask("3b8f9d12dd04", "Child of 9f2c7a41aa01", [
        { taskId: "9f2c7a41aa01", type: "parent" },
        { taskId: "7d1e0b55cc03", type: "relates" },
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
      // The v0 detail route answers the bare task (never the list envelope)
      // so the CLI's single-detail reads see the task's current links.
      const detailMatch = url.match(/^\/api\/v0\/tasks\/([^/?]+)/);
      if (detailMatch) {
        const task = tasks.get(decodeURIComponent(detailMatch[1]));
        if (!task) {
          finish(404, { error: "Task not found", code: "NOT_FOUND" });
          return;
        }
        finish(200, task);
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
        url?: string;
        selector?: string;
        cssSelector?: string;
        type?: string;
        priority?: string;
        tags?: string[];
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
        // Echo the annotation fields the real server stores, so read-back
        // tests round-trip instead of asserting against a lossy fake.
        if (typeof parsed.url === "string") created.url = parsed.url;
        if (typeof parsed.selector === "string") created.selector = parsed.selector;
        if (typeof parsed.cssSelector === "string") created.cssSelector = parsed.cssSelector;
        if (typeof parsed.type === "string") created.type = parsed.type;
        if (typeof parsed.priority === "string") created.priority = parsed.priority;
        if (Array.isArray(parsed.tags)) created.tags = parsed.tags;
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
    const home = freshDir("saas-parent-home-");
    const { url, requests } = await startFakeBackend();
    setupSaaSMode({ home, store, apiUrl: url });

    const r = await spawnCli(
      ["tasks", store, "--add", "--title", "Kid", "--parent", "9f2c7a41aa01", "--json"],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(r.code).toBe(0);
    const posts = postBodies(requests);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      title: "Kid",
      links: [{ taskId: "9f2c7a41aa01", type: "parent" }],
    });
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      task: { id: string; links: Link[] };
    };
    expect(payload.ok).toBe(true);
    expect(
      payload.task.links.some((l) => l.taskId === "9f2c7a41aa01" && l.type === "parent"),
    ).toBe(true);
  });

  it("--add --parent with a dangling target is refused INVALID_LINKS before any POST", async () => {
    const store = freshDir("saas-parent-store-");
    const home = freshDir("saas-parent-home-");
    const { url, requests } = await startFakeBackend();
    setupSaaSMode({ home, store, apiUrl: url });

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
    // Resolved BEFORE the online request: no POST was attempted.
    expect(postBodies(requests)).toEqual([]);
  });

  it("--add --parent resolves a unique prefix to the full id", async () => {
    const store = freshDir("saas-parent-store-");
    const home = freshDir("saas-parent-home-");
    const { url, requests } = await startFakeBackend();
    setupSaaSMode({ home, store, apiUrl: url });

    const r = await spawnCli(
      ["tasks", store, "--add", "--title", "Kid", "--parent", "3b8f9d12", "--json"],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(r.code).toBe(0);
    const posts = postBodies(requests);
    expect(posts).toHaveLength(1);
    // "3b8f9d12" is a shortened (8-of-12) prefix of "3b8f9d12dd04" — the POST carries the full id.
    expect(posts[0]).toMatchObject({
      title: "Kid",
      links: [{ taskId: "3b8f9d12dd04", type: "parent" }],
    });
  });

  it("--add --parent refuses an ambiguous prefix, naming the candidates", async () => {
    const store = freshDir("saas-parent-store-");
    const home = freshDir("saas-parent-home-");
    const { url, requests } = await startFakeBackend();
    setupSaaSMode({ home, store, apiUrl: url });

    const r = await spawnCli(
      ["tasks", store, "--add", "--title", "Kid", "--parent", "9f2c7a41", "--json"],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(r.code).not.toBe(0);
    expect(r.stdout.trim()).toBe("");
    const envelope = JSON.parse(r.stderr) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("E_AMBIGUOUS");
    // "9f2c7a41" prefixes both parents — both candidates are named.
    expect(envelope.error.message).toContain("9f2c7a41aa01");
    expect(envelope.error.message).toContain("9f2c7a41bb02");
    expect(postBodies(requests)).toEqual([]);
  });

  it("--add --parent --dry-run previews the link and sends no POST", async () => {
    const store = freshDir("saas-parent-store-");
    const home = freshDir("saas-parent-home-");
    const { url, requests } = await startFakeBackend();
    setupSaaSMode({ home, store, apiUrl: url });

    const r = await spawnCli(
      ["tasks", store, "--add", "--title", "Kid", "--parent", "9f2c7a41aa", "--dry-run", "--json"],
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
    expect(payload.task.links).toEqual([{ taskId: "9f2c7a41aa01", type: "parent" }]);
  });
});

describe("tasks --edit --set-parent/--no-parent in SaaS mode is honoured", () => {
  it("--set-parent swaps the parent and preserves relates links", async () => {
    const store = freshDir("saas-parent-store-");
    const home = freshDir("saas-parent-home-");
    const { url, tasks } = await startFakeBackend();
    setupSaaSMode({ home, store, apiUrl: url });

    const r = await spawnCli(
      ["tasks", store, "--edit", "3b8f9d12dd04", "--set-parent", "9f2c7a41bb", "--json"],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(r.code).toBe(0);
    // Replace semantics: the old parent is swapped out, the relates link kept.
    expect(tasks.get("3b8f9d12dd04")!.links).toEqual([
      { taskId: "7d1e0b55cc03", type: "relates" },
      { taskId: "9f2c7a41bb02", type: "parent" },
    ]);
    const payload = JSON.parse(r.stdout) as { ok: boolean };
    expect(payload.ok).toBe(true);
  });

  it("--no-parent clears the parent and keeps relates links", async () => {
    const store = freshDir("saas-parent-store-");
    const home = freshDir("saas-parent-home-");
    const { url, tasks } = await startFakeBackend();
    setupSaaSMode({ home, store, apiUrl: url });

    const r = await spawnCli(
      ["tasks", store, "--edit", "3b8f9d12dd04", "--no-parent", "--json"],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(r.code).toBe(0);
    expect(tasks.get("3b8f9d12dd04")!.links).toEqual([{ taskId: "7d1e0b55cc03", type: "relates" }]);
  });

  it("--set-parent with a dangling target is refused INVALID_LINKS and sends no PATCH", async () => {
    const store = freshDir("saas-parent-store-");
    const home = freshDir("saas-parent-home-");
    const { url, requests, tasks } = await startFakeBackend();
    setupSaaSMode({ home, store, apiUrl: url });

    const r = await spawnCli(
      ["tasks", store, "--edit", "3b8f9d12dd04", "--set-parent", "ghost", "--json"],
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
    // Resolved BEFORE the online request: no PATCH was attempted and the
    // old parent still stands.
    expect(patchBodies(requests, "3b8f9d12dd04")).toEqual([]);
    expect(tasks.get("3b8f9d12dd04")!.links).toEqual([
      { taskId: "9f2c7a41aa01", type: "parent" },
      { taskId: "7d1e0b55cc03", type: "relates" },
    ]);
  });

  it("--set-parent resolves a unique prefix to the full id", async () => {
    const store = freshDir("saas-parent-store-");
    const home = freshDir("saas-parent-home-");
    const { url, tasks } = await startFakeBackend();
    setupSaaSMode({ home, store, apiUrl: url });

    // "9f2c7a41" is ambiguous (aa01, bb02) but "9f2c7a41bb" resolves uniquely.
    const r = await spawnCli(
      ["tasks", store, "--edit", "3b8f9d12dd04", "--set-parent", "9f2c7a41bb", "--json"],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(r.code).toBe(0);
    expect(tasks.get("3b8f9d12dd04")!.links).toEqual([
      { taskId: "7d1e0b55cc03", type: "relates" },
      { taskId: "9f2c7a41bb02", type: "parent" },
    ]);
  });

  it("--set-parent refuses an ambiguous prefix, naming the candidates", async () => {
    const store = freshDir("saas-parent-store-");
    const home = freshDir("saas-parent-home-");
    const { url, requests, tasks } = await startFakeBackend();
    setupSaaSMode({ home, store, apiUrl: url });

    const r = await spawnCli(
      ["tasks", store, "--edit", "3b8f9d12dd04", "--set-parent", "9f2c7a41", "--json"],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(r.code).not.toBe(0);
    expect(r.stdout.trim()).toBe("");
    const envelope = JSON.parse(r.stderr) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("E_AMBIGUOUS");
    expect(envelope.error.message).toContain("9f2c7a41aa01");
    expect(envelope.error.message).toContain("9f2c7a41bb02");
    expect(patchBodies(requests, "3b8f9d12dd04")).toEqual([]);
    expect(tasks.get("3b8f9d12dd04")!.links).toEqual([
      { taskId: "9f2c7a41aa01", type: "parent" },
      { taskId: "7d1e0b55cc03", type: "relates" },
    ]);
  });

  it("--relates resolves a unique prefix and preserves the other links", async () => {
    const store = freshDir("saas-parent-store-");
    const home = freshDir("saas-parent-home-");
    const { url, tasks } = await startFakeBackend();
    setupSaaSMode({ home, store, apiUrl: url });

    // 9f2c7a41aa01 already parents the child; adding it as relates is a distinct pair.
    const r = await spawnCli(
      ["tasks", store, "--edit", "3b8f9d12dd04", "--relates", "9f2c7a41", "--json"],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    // "9f2c7a41" is ambiguous (aa01, bb02) — refused, nothing written.
    expect(r.code).not.toBe(0);
    expect(tasks.get("3b8f9d12dd04")!.links).toEqual([
      { taskId: "9f2c7a41aa01", type: "parent" },
      { taskId: "7d1e0b55cc03", type: "relates" },
    ]);

    const r2 = await spawnCli(
      ["tasks", store, "--edit", "3b8f9d12dd04", "--relates", "9f2c7a41bb", "--json"],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(r2.code).toBe(0);
    expect(tasks.get("3b8f9d12dd04")!.links).toEqual([
      { taskId: "9f2c7a41aa01", type: "parent" },
      { taskId: "7d1e0b55cc03", type: "relates" },
      { taskId: "9f2c7a41bb02", type: "relates" },
    ]);
  });

  it("--unrelates removes exactly the named pair and keeps the rest", async () => {
    const store = freshDir("saas-parent-store-");
    const home = freshDir("saas-parent-home-");
    const { url, tasks } = await startFakeBackend();
    setupSaaSMode({ home, store, apiUrl: url });

    const r = await spawnCli(
      ["tasks", store, "--edit", "3b8f9d12dd04", "--unrelates", "7d1e0b55", "--json"],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(r.code).toBe(0);
    expect(tasks.get("3b8f9d12dd04")!.links).toEqual([
      { taskId: "9f2c7a41aa01", type: "parent" },
    ]);
  });

  it("--set-parent --dry-run previews the merged links and sends no PATCH", async () => {
    const store = freshDir("saas-parent-store-");
    const home = freshDir("saas-parent-home-");
    const { url, requests } = await startFakeBackend();
    setupSaaSMode({ home, store, apiUrl: url });

    const r = await spawnCli(
      ["tasks", store, "--edit", "3b8f9d12dd04", "--set-parent", "9f2c7a41bb", "--dry-run", "--json"],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(r.code).toBe(0);
    expect(patchBodies(requests, "3b8f9d12dd04")).toEqual([]);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      dryRun: boolean;
      updates: { links?: Link[] };
    };
    expect(payload.ok).toBe(true);
    expect(payload.dryRun).toBe(true);
    expect(payload.updates.links).toEqual([
      { taskId: "7d1e0b55cc03", type: "relates" },
      { taskId: "9f2c7a41bb02", type: "parent" },
    ]);
  });
});

describe("tasks list in SaaS mode hides children by default", () => {
  it("roots exclude the child and hiddenChildren names it; --children includes it", async () => {
    const store = freshDir("saas-parent-store-");
    const home = freshDir("saas-parent-home-");
    const { url } = await startFakeBackend();
    setupSaaSMode({ home, store, apiUrl: url });

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
    expect(rootIds).toContain("9f2c7a41aa01");
    expect(rootIds).not.toContain("3b8f9d12dd04");
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
    expect(allPayload.tasks.map((t) => t.id)).toContain("3b8f9d12dd04");
    expect(allPayload.hiddenChildren).toBe(0);
  });
});

describe("tasks --add forwards annotation fields in SaaS mode (ticket 684114fb)", () => {
  it("--type/--priority/--tag/--url/--selector all reach the POST body", async () => {
    const store = freshDir("saas-create-fields-store-");
    const home = freshDir("saas-create-fields-home-");
    const { url, requests } = await startFakeBackend();
    setupSaaSMode({ home, store, apiUrl: url });

    const r = await spawnCli(
      [
        "tasks", store, "--add",
        "--title", "Research spike",
        "--type", "Research",
        "--priority", "High",
        "--tag", "public",
        "--url", "https://example.com/pricing",
        "--selector", "#cta",
        "--json",
      ],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(r.code).toBe(0);
    const posts = postBodies(requests);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      title: "Research spike",
      type: "Research",
      priority: "High",
      tags: ["public"],
      url: "https://example.com/pricing",
      selector: "#cta",
    });
    // sortKey has no v0 create column — never sent (strict record schema, c0557b6c).
    expect(posts[0]).not.toHaveProperty("sortKey");
  });

  it("round trip: --add --url/--selector then --get reads the SAME values back (ticket 9029e53c)", async () => {
    const store = freshDir("saas-annot-store-");
    const home = freshDir("saas-annot-home-");
    const { url } = await startFakeBackend();
    setupSaaSMode({ home, store, apiUrl: url });

    const add = await spawnCli(
      ["tasks", store, "--add", "--title", "Annotated probe",
       "--url", "https://example.com/x", "--selector", "#z", "--json"],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(add.code).toBe(0);
    const created = (JSON.parse(add.stdout) as { task: { id: string } }).task;

    // json read-back carries the stored annotation (was: selector hardcoded
    // "/" through toLocalTask, url never mapped).
    const read = await spawnCli(
      ["tasks", store, "--get", created.id, "--json"],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(read.code).toBe(0);
    const task = (JSON.parse(read.stdout) as {
      task: { url?: string; selector?: string };
    }).task;
    expect(task.url).toBe("https://example.com/x");
    expect(task.selector).toBe("#z");

    // human read-back prints the REAL selector + url (was a hardcoded
    // "selector: /" line and no url line at all).
    const human = await spawnCli(
      ["tasks", store, "--get", created.id],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("selector: #z");
    expect(human.stdout).toContain("url:      https://example.com/x");
    expect(human.stdout).not.toContain("selector: /");
  });

  it("--get --fields projects online exactly like local (was a silent no-op, ticket 13ab0652)", async () => {
    const store = freshDir("saas-fields-store-");
    const home = freshDir("saas-fields-home-");
    const { url } = await startFakeBackend();
    setupSaaSMode({ home, store, apiUrl: url });

    const add = await spawnCli(
      ["tasks", store, "--add", "--title", "Fields probe", "--type", "Research", "--json"],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(add.code).toBe(0);
    const created = (JSON.parse(add.stdout) as { task: { id: string } }).task;

    const picked = await spawnCli(
      ["tasks", store, "--get", created.id, "--fields", "type,title", "--json"],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(picked.code).toBe(0);
    const pickedTask = (JSON.parse(picked.stdout) as { task: Record<string, unknown> }).task;
    expect(Object.keys(pickedTask).sort()).toEqual(["title", "type"]);
    expect(pickedTask.type).toBe("Research");

    // without --fields the full task still comes back
    const full = await spawnCli(
      ["tasks", store, "--get", created.id, "--json"],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    const fullTask = (JSON.parse(full.stdout) as { task: Record<string, unknown> }).task;
    expect(Object.keys(fullTask).length).toBeGreaterThan(2);
    expect(fullTask).toHaveProperty("description");
  });
});
