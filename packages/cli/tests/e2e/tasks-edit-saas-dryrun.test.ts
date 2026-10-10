/**
 * CLI e2e — `tasks --edit --dry-run` in SaaS (online) mode must not mutate.
 *
 * The `editMode === "saas"` branch used to call `updateSaasTask` (a remote
 * PATCH of shared state) with no dry-run guard — the local dry-run preview
 * sits AFTER that branch, so it never protected it. This file pins the
 * invariant: under `--dry-run` the fake backend receives NO update/PATCH (and
 * no comment POST) while the preview is still printed; a real run PATCHes
 * exactly once.
 *
 * Non-vacuity proof: with the `if (opts.dryRun)` guard in the saas branch of
 * `packages/cli/src/index.ts` temporarily removed, the "--dry-run" tests below
 * fail (the fake server records 1 PATCH); with the guard restored they pass.
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
  const home = freshDir("saas-dryrun-home-");
  mkdirSync(join(home, ".vibeflow"), { recursive: true });
  writeFileSync(join(home, ".vibeflow", "token"), "test-token", "utf-8");
  return home;
}

type RecordedRequest = { method: string; url: string; body: string };

/**
 * A tiny fake online backend. GET /api/cli/tasks answers the read-only
 * conflict-detection fetch; PATCH /api/cli/tasks/:id and
 * POST /api/cli/tasks/:id/comments RECORD every mutating request instead of
 * applying it, so the tests can assert on the count.
 */
async function startFakeBackend(): Promise<{
  url: string;
  requests: RecordedRequest[];
}> {
  const requests: RecordedRequest[] = [];
  const task = {
    id: "onlinetask1",
    title: "Online task",
    description: "",
    status: "todo",
    author: null,
    priority: "Medium",
    type: "Task",
    boardId: "board-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
  const server: Server = createServer((req, res) => {
    const finish = (code: number, payload: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.method === "GET" && req.url?.startsWith("/api/cli/tasks")) {
      finish(200, { tasks: [task], boardId: "board-1" });
      return;
    }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", body });
      if (
        req.method === "PATCH" &&
        req.url === `/api/cli/tasks/${task.id}`
      ) {
        finish(200, { task: { ...task, ...JSON.parse(body || "{}") } });
        return;
      }
      if (
        req.method === "POST" &&
        req.url === `/api/cli/tasks/${task.id}/comments`
      ) {
        finish(200, {
          comment: {
            id: "c1",
            taskId: task.id,
            body: "x",
            authorId: "u1",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        });
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
  return { url: `http://127.0.0.1:${port}`, requests };
}

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

describe("tasks --edit --dry-run in SaaS mode never mutates", () => {
  it("--dry-run (JSON) sends no PATCH/POST and previews with dryRun:true", async () => {
    const store = freshDir("saas-dryrun-store-");
    const home = saasHome();
    const { url, requests } = await startFakeBackend();

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        "onlinetask1",
        "--set-status",
        "in-progress",
        "--title",
        "New title",
        "--comment",
        "a note",
        "--dry-run",
        "--json",
      ],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(r.code).toBe(0);
    // The invariant: zero mutating requests reached the backend. A PATCH-only
    // assertion would miss the comment POST, so both are counted.
    expect(
      requests.filter((q) => q.method === "PATCH" || q.method === "POST"),
    ).toEqual([]);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      dryRun: boolean;
      action: string;
      taskId: string;
      updates: Record<string, unknown>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.dryRun).toBe(true);
    expect(payload.action).toBe("update");
    expect(payload.taskId).toBe("onlinetask1");
    expect(payload.updates.status).toBe("in-progress");
    expect(payload.updates.title).toBe("New title");
  });

  it("--dry-run (human) sends no PATCH/POST and prints a [dry-run] preview", async () => {
    const store = freshDir("saas-dryrun-store-");
    const home = saasHome();
    const { url, requests } = await startFakeBackend();

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        "onlinetask1",
        "--set-status",
        "in-progress",
        "--dry-run",
      ],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(r.code).toBe(0);
    expect(
      requests.filter((q) => q.method === "PATCH" || q.method === "POST"),
    ).toEqual([]);
    expect(r.stdout).toContain("[dry-run]");
    expect(r.stdout).toContain("onlinetask1");
  });

  it("a real run still PATCHes exactly once", async () => {
    const store = freshDir("saas-dryrun-store-");
    const home = saasHome();
    const { url, requests } = await startFakeBackend();

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        "onlinetask1",
        "--set-status",
        "in-progress",
        "--json",
      ],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(r.code).toBe(0);
    expect(
      requests.filter(
        (q) => q.method === "PATCH" && q.url === "/api/cli/tasks/onlinetask1",
      ),
    ).toHaveLength(1);
    const payload = JSON.parse(r.stdout) as { ok: boolean };
    expect(payload.ok).toBe(true);
  });
});

describe("tasks --edit --set-verify in SaaS mode reaches the backend", () => {
  function patchBodies(requests: RecordedRequest[]): unknown[] {
    return requests
      .filter(
        (q) => q.method === "PATCH" && q.url === "/api/cli/tasks/onlinetask1",
      )
      .map((q) => JSON.parse(q.body || "{}") as unknown);
  }

  it("--set-verify pass PATCHes verified:true", async () => {
    const store = freshDir("saas-verify-store-");
    const home = saasHome();
    const { url, requests } = await startFakeBackend();

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        "onlinetask1",
        "--set-status",
        "review",
        "--set-verify",
        "pass",
        "--comment",
        "verdict test",
        "--commit-message",
        "verdict test",
        "--json",
      ],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(r.code).toBe(0);
    const bodies = patchBodies(requests);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ status: "review", verified: true });
  });

  it("--set-verify fail PATCHes verified:false", async () => {
    const store = freshDir("saas-verify-store-");
    const home = saasHome();
    const { url, requests } = await startFakeBackend();

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        "onlinetask1",
        "--set-verify",
        "fail",
        "--json",
      ],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(r.code).toBe(0);
    const bodies = patchBodies(requests);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ verified: false });
  });

  it("--set-verify cannot PATCHes verified:null and records the reason as a comment", async () => {
    const store = freshDir("saas-verify-store-");
    const home = saasHome();
    const { url, requests } = await startFakeBackend();

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        "onlinetask1",
        "--set-verify",
        "cannot",
        "--verify-reason",
        "no browser here",
        "--json",
      ],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(r.code).toBe(0);
    // The tri-state boolean column has no free-text reason field on EITHER
    // side, so the reason mirrors the local path: cleared verdict + activity
    // comment. Assert both writes — PATCH null AND the comment POST.
    const bodies = patchBodies(requests);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ verified: null });
    const comments = requests.filter(
      (q) =>
        q.method === "POST" &&
        q.url === "/api/cli/tasks/onlinetask1/comments",
    );
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("no browser here");
  });

  it("no --set-verify leaves the remote verdict untouched (key absent)", async () => {
    const store = freshDir("saas-verify-store-");
    const home = saasHome();
    const { url, requests } = await startFakeBackend();

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        "onlinetask1",
        "--title",
        "New title",
        "--json",
      ],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(r.code).toBe(0);
    const bodies = patchBodies(requests);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).not.toHaveProperty("verified");
  });

  it("claiming (in-progress, no verdict) clears the remote verdict", async () => {
    const store = freshDir("saas-verify-store-");
    const home = saasHome();
    const { url, requests } = await startFakeBackend();

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        "onlinetask1",
        "--set-status",
        "in-progress",
        "--json",
      ],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(r.code).toBe(0);
    const bodies = patchBodies(requests);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      status: "in_progress",
      verified: null,
    });
  });

  it("--dry-run with --set-verify previews verified and sends no PATCH", async () => {
    const store = freshDir("saas-verify-store-");
    const home = saasHome();
    const { url, requests } = await startFakeBackend();

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        "onlinetask1",
        "--set-verify",
        "pass",
        "--dry-run",
        "--json",
      ],
      { cwd: store, home, env: { VIBEFLOW_API_URL: url } },
    );
    expect(r.code).toBe(0);
    expect(patchBodies(requests)).toEqual([]);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      dryRun: boolean;
      updates: Record<string, unknown>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.dryRun).toBe(true);
    expect(payload.updates.verified).toBe(true);
  });
});
