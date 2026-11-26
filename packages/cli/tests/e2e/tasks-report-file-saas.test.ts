/**
 * CLI e2e — `tasks --edit --report-file` on the HOSTED board (ticket ets0rzn7).
 *
 * The flag was written for the local store only, in two places:
 *   1. the precondition probe read `listTasks(resolve(dir))` — the LOCAL
 *      store — even though the target id had already been resolved through
 *      the online detail request a few hundred lines above. On the hosted
 *      board the local store is empty, so a correctly resolved Research
 *      ticket answered `Task not found` and the documented submission flow
 *      (report + review in one command) could not be performed at all;
 *   2. the upload called `saveTaskFile` — the local file store — so even with
 *      the probe fixed the report would have been written beside a task the
 *      board does not own.
 *
 * Non-vacuity: revert either half and the first test below fails — the probe
 * with `✗ Task not found`, the upload with no POST recorded and no report in
 * the board's file list.
 *
 * The fake backend speaks only the routes the CLI actually uses, and records
 * every one of them: a board listing here would be a regression (the id is
 * exact, so there is nothing to enumerate).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { spawnCli } from "./mcp-helpers.js";
import { setupSaaSMode } from "../helpers/saas-auth.js";

const cleanups: Array<() => void | Promise<void>> = [];

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const RESEARCH_ID = "researchtask0000000000000001";
const TASK_ID = "plaintask00000000000000000002";

interface Recorded {
  method: string;
  path: string;
  contentType: string;
  body: string;
}

/**
 * A fake hosted board with exactly the report-upload surface:
 * detail read (with files inlined so no hydration sub-requests fire), the
 * file list the duplicate check reads, the multipart upload, the status
 * PATCH and the comment POST. Everything is recorded.
 */
async function startFakeBoard(): Promise<{
  url: string;
  requests: Recorded[];
  uploads: () => Recorded[];
  listCalls: () => number;
  statusPatches: () => Recorded[];
}> {
  const requests: Recorded[] = [];
  const tasks = [
    {
      id: RESEARCH_ID,
      title: "Research: how should we do the thing",
      description: "",
      status: "in-progress",
      author: null,
      priority: "High",
      type: "Research",
      boardId: "board-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: TASK_ID,
      title: "A plain task",
      description: "",
      status: "in-progress",
      author: null,
      priority: "Medium",
      type: "Task",
      boardId: "board-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
  ];
  const byId = new Map(tasks.map((t) => [t.id, t]));

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d: Buffer) => chunks.push(d));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const rawUrl = req.url ?? "/";
      const path = rawUrl.split("?")[0] as string;
      const record: Recorded = {
        method: req.method ?? "",
        path,
        contentType: String(req.headers["content-type"] ?? ""),
        body,
      };
      requests.push(record);
      const finish = (code: number, payload: unknown) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (req.method === "GET" && path === "/api/v0/tasks") {
        finish(200, { items: tasks, nextCursor: null });
        return;
      }
      if (req.method === "GET" && path.startsWith("/api/v0/tasks/")) {
        const rest = path.slice("/api/v0/tasks/".length);
        if (rest.endsWith("/files")) {
          finish(200, { files: [] });
          return;
        }
        if (rest.endsWith("/comments")) {
          finish(200, { comments: [] });
          return;
        }
        const hit = byId.get(rest);
        finish(hit ? 200 : 404, hit ? { ...hit, comments: [], files: [] } : {});
        return;
      }
      if (req.method === "POST" && /^\/api\/v0\/tasks\/[^/]+\/files$/.test(path)) {
        const id = path.slice("/api/v0/tasks/".length, -"/files".length);
        const name = /name="file"; filename="([^"]+)"/.exec(body)?.[1] ?? "upload";
        finish(200, {
          id: "file-1",
          taskId: id,
          name,
          size: body.length,
          url: `https://board.test/files/${name}`,
        });
        return;
      }
      if (req.method === "PATCH" && path.startsWith("/api/v0/tasks/")) {
        const id = path.slice("/api/v0/tasks/".length);
        const hit = byId.get(id);
        finish(hit ? 200 : 404, hit ? { ...hit, ...(JSON.parse(body || "{}") as object) } : {});
        return;
      }
      if (req.method === "POST" && path.endsWith("/comments")) {
        // The v0 contract Comment, bare (saas/client.ts `toSaasComment`
        // refuses anything without an id, a createdAt and a text field).
        finish(200, {
          id: "comment-1",
          taskId: path.slice("/api/v0/tasks/".length, -"/comments".length),
          body: "recorded",
          authorId: "user-1",
          createdAt: "2026-01-01T00:00:00.000Z",
        });
        return;
      }
      finish(404, { error: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    uploads: () => requests.filter((r) => r.method === "POST" && r.path.endsWith("/files")),
    listCalls: () => requests.filter((r) => r.method === "GET" && r.path === "/api/v0/tasks").length,
    statusPatches: () =>
      requests.filter(
        (r) => r.method === "PATCH" && r.body.includes('"status"'),
      ),
  };
}

afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

describe("tasks --edit --report-file against the hosted board", () => {
  it("uploads the report from the ONLINE record and consumes the local file", async () => {
    const store = freshDir("saas-report-store-");
    const home = freshDir("saas-report-home-");
    const fake = await startFakeBoard();
    setupSaaSMode({ home, store, apiUrl: fake.url });

    const report = join(store, "research-report.md");
    writeFileSync(report, "# Findings\n\nIt depends.");

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        RESEARCH_ID,
        "--set-status",
        "review",
        "--report-file",
        report,
        "--comment",
        "Research done — report attached.",
        "--json",
      ],
      { cwd: store, home, env: { VIBEFLOW_API_URL: fake.url } },
    );

    // The bug's signature, on the left: a correctly resolved online task used
    // to be reported missing because the probe read the LOCAL store.
    expect(r.stdout + r.stderr).not.toContain("Task not found");
    expect(r.code).toBe(0);

    const uploads = fake.uploads();
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.contentType).toContain("multipart/form-data");
    expect(uploads[0]!.body).toContain("research-report.md");
    expect(uploads[0]!.body).toContain("# Findings");

    // Consumed, exactly like the local flow: the board owns it now.
    expect(existsSync(report)).toBe(false);

    // The transition really happened on the board.
    expect(fake.statusPatches().length).toBeGreaterThan(0);
    expect(fake.statusPatches()[0]!.body).toContain('"review"');

    expect(fake.listCalls()).toBe(0);
  }, 60_000);

  it("reads the task TYPE online, so a non-Research task gets the typed refusal", async () => {
    // With the local-store probe this answered `Task not found` — the wrong
    // refusal for a task that exists. The type has to come from the board.
    const store = freshDir("saas-report-store-");
    const home = freshDir("saas-report-home-");
    const fake = await startFakeBoard();
    setupSaaSMode({ home, store, apiUrl: fake.url });

    const report = join(store, "notes.md");
    writeFileSync(report, "not a research report");

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        TASK_ID,
        "--set-status",
        "review",
        "--report-file",
        report,
        "--comment",
        "x",
        "--json",
      ],
      { cwd: store, home, env: { VIBEFLOW_API_URL: fake.url } },
    );

    expect(r.stdout + r.stderr).not.toContain("Task not found");
    expect(r.stdout + r.stderr).toContain("only supported for Research tasks");
    // Nothing was uploaded and the source file is still the caller's.
    expect(fake.uploads()).toHaveLength(0);
    expect(existsSync(report)).toBe(true);
    // The report file is readable afterwards — the refusal happened before
    // any consumption (this line also proves the fixture's file lived).
    expect(readFileSync(report, "utf8")).toContain("not a research report");
  }, 60_000);
});
