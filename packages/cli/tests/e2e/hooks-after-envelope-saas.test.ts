/**
 * After-envelope SaaS e2e (ticket 431ee1c0): the index.ts inline online
 * paths (`--add` / `--edit` in SaaS mode) thread the CONFIRMED server
 * record through `toLocalTask` into the after-envelope `task` snapshot.
 *
 * Fake v0 backend + `setupSaaSMode`, mirroring
 * `tasks-edit-saas-nolist.test.ts`. The hook child env carries
 * PATH+HOME only, so the capture path is baked into the hook body.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
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

function boardTask(id: string, title: string, status = "todo"): Record<string, unknown> {
  return {
    id,
    title,
    description: "",
    status,
    author: null,
    priority: "Medium",
    type: "Task",
    boardId: "board-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

async function startFakeBackend(): Promise<{
  url: string;
  created: Array<Record<string, unknown>>;
}> {
  const created: Array<Record<string, unknown>> = [];
  const tasks = [boardTask("saas-task-00000000000000000001", "Saas one")];
  const byId = new Map(tasks.map((t) => [t.id as string, t]));
  let counter = 0;
  const server: Server = createServer((req, res) => {
    const finish = (code: number, payload: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const rawUrl = req.url ?? "/";
    const pathname = rawUrl.split("?")[0] as string;
    if (req.method === "GET" && pathname === "/api/v0/tasks") {
      finish(200, { items: [...tasks, ...created], nextCursor: null });
      return;
    }
    if (req.method === "GET" && pathname.startsWith("/api/v0/tasks/")) {
      const rest = pathname.slice("/api/v0/tasks/".length);
      if (rest.endsWith("/comments")) {
        finish(200, { comments: [] });
        return;
      }
      if (rest.endsWith("/files")) {
        finish(200, { files: [] });
        return;
      }
      const hit =
        byId.get(rest) ??
        created.find((t) => (t as { id: string }).id === rest);
      if (hit) {
        finish(200, { ...(hit as object), comments: [], files: [] });
        return;
      }
      finish(404, { error: "not found" });
      return;
    }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = (JSON.parse(body || "{}") as Record<string, unknown>);
      if (req.method === "POST" && pathname === "/api/v0/tasks") {
        counter += 1;
        const record = {
          ...boardTask(`remote-created-${counter}`, String(parsed.title ?? "untitled")),
          description: (parsed.description as string) ?? "",
        };
        created.push(record);
        finish(201, record);
        return;
      }
      if (req.method === "PATCH" && pathname.startsWith("/api/v0/tasks/")) {
        const id = pathname.slice("/api/v0/tasks/".length);
        const hit =
          byId.get(id) ?? created.find((t) => (t as { id: string }).id === id);
        if (hit) {
          finish(200, { ...(hit as object), ...(parsed as object) });
          return;
        }
      }
      if (req.method === "POST" && pathname.endsWith("/comments")) {
        finish(200, {
          id: "comment-1",
          author: "agent",
          text: parsed.text,
          createdAt: "2026-01-01T00:00:00.000Z",
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
  return { url: `http://127.0.0.1:${port}`, created };
}

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

const HOOK_ENV = {
  VIBEFLOW_HOOKS: "1",
  VIBEFLOW_TRUST_HOOKS: "1",
  VIBEFLOW_API_URL: "",
};

function writeCaptureHook(store: string, event: string, capture: string): void {
  const dir = join(store, ".vibeflow-hooks", "after");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `after-${event}.mjs`),
    `import { appendFileSync } from "node:fs";\n` +
      `let s="";process.stdin.setEncoding("utf8").on("data",c=>s+=c).on("end",()=>{appendFileSync(${JSON.stringify(capture)},s+"\\n");process.stdout.write(JSON.stringify({}));});\n`,
  );
}

function readCaptures(capture: string): Array<Record<string, unknown>> {
  return readFileSync(capture, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("after-envelope saas paths live (ticket 431ee1c0)", () => {
  it("saas --add after-envelope carries the mapped server record", async () => {
    const store = freshDir("saas-env-add-store-");
    const home = freshDir("saas-env-add-home-");
    const capture = join(store, "capture-saas-add.jsonl");
    const fake = await startFakeBackend();
    setupSaaSMode({ home, store, apiUrl: fake.url });
    writeCaptureHook(store, "task.create", capture);

    const r = await spawnCli(
      ["tasks", store, "--add", "--title", "Saas snapshot", "--json"],
      { cwd: store, home, env: { ...HOOK_ENV, VIBEFLOW_API_URL: fake.url } },
    );
    expect(r.code).toBe(0);
    const payload = JSON.parse(r.stdout) as { ok: boolean; task: { id: string } };
    expect(payload.ok).toBe(true);
    const envelopes = readCaptures(capture);
    expect(envelopes).toHaveLength(1);
    const env = envelopes[0];
    const task = env.task as Record<string, unknown>;
    // Pre-fix this was null — the live proof for the online add path.
    expect(task).not.toBeNull();
    expect(task.id).toBe(payload.task.id);
    expect(task.title).toBe("Saas snapshot");
    expect(task.status).toBe("todo");
  });

  it("saas --edit after-envelopes carry the mapped record + comment", async () => {
    const store = freshDir("saas-env-edit-store-");
    const home = freshDir("saas-env-edit-home-");
    const updateCapture = join(store, "capture-saas-update.jsonl");
    const commentCapture = join(store, "capture-saas-comment.jsonl");
    const fake = await startFakeBackend();
    setupSaaSMode({ home, store, apiUrl: fake.url });
    writeCaptureHook(store, "task.update", updateCapture);
    writeCaptureHook(store, "task.comment", commentCapture);

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        "saas-task-00000000000000000001",
        "--title",
        "Saas renamed",
        "--comment",
        "saas live note",
        "--json",
      ],
      { cwd: store, home, env: { ...HOOK_ENV, VIBEFLOW_API_URL: fake.url } },
    );
    expect(r.code).toBe(0);
    const updates = readCaptures(updateCapture);
    expect(updates).toHaveLength(1);
    const updateTask = updates[0].task as Record<string, unknown>;
    expect(updateTask).not.toBeNull();
    expect(updateTask.id).toBe("saas-task-00000000000000000001");
    expect(updateTask.title).toBe("Saas renamed");
    const changed = (updates[0].activityObject as { changed: string[] }).changed;
    expect(changed).toContain("title");
    const comments = readCaptures(commentCapture);
    expect(comments).toHaveLength(1);
    const commentTask = comments[0].task as Record<string, unknown>;
    expect(commentTask).not.toBeNull();
    expect(commentTask.id).toBe("saas-task-00000000000000000001");
    expect(
      (comments[0].activityObject as Record<string, unknown>).body,
    ).toBe("saas live note");
  });
});
