/**
 * CLI e2e — `tasks --edit <id>` in SaaS (online) mode must not enumerate the
 * whole board to resolve an exact id.
 *
 * Before the fix, every online edit unconditionally called `fetchSaasTasks`
 * (O(board pages) per edit, loud BOARD_TRUNCATED failure for a valid id when
 * the board exceeds the 500-page cap) even for `--edit <exact-id> --title`.
 * The rule now mirrors `--get`: a FULL id hits ONE detail request and never
 * lists; only a 404 falls back to ONE unhydrated listing for prefix
 * resolution through the same ONE resolver (unique → resolve, ambiguous →
 * E_AMBIGUOUS naming the candidates, unknown → TASK_NOT_FOUND).
 *
 * Non-vacuity proof: with the `fetchSaasTaskDetail` probe in the saas edit
 * branch of `packages/cli/src/index.ts` reverted to an unconditional
 * `fetchSaasTasks`, the "exact id" test below fails (1 listing recorded);
 * with the probe restored it passes.
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
  const home = freshDir("saas-nolist-home-");
  mkdirSync(join(home, ".vibeflow"), { recursive: true });
  writeFileSync(join(home, ".vibeflow", "token"), "test-token", "utf-8");
  return home;
}

type RecordedRequest = { method: string; url: string; body: string };

function boardTask(id: string, title: string): Record<string, unknown> {
  return {
    id,
    title,
    description: "",
    status: "todo",
    author: null,
    priority: "Medium",
    type: "Task",
    boardId: "board-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

/**
 * A fake online backend that separates the routes the CLI actually speaks:
 * - `GET /api/v0/tasks` (no extra segment) is the BOARD LISTING — recorded
 *   as a list call, answers the v0 `{ items, nextCursor }` envelope.
 * - `GET /api/v0/tasks/:id` is the DETAIL read — a known full id answers
 *   the bare task (comments/files inlined so no hydration sub-requests
 *   fire); anything else answers 404.
 * - `PATCH /api/v0/tasks/:id` records every mutating request.
 */
async function startFakeBackend(): Promise<{
  url: string;
  requests: RecordedRequest[];
  listCalls: () => number;
  patchCalls: () => number;
}> {
  const requests: RecordedRequest[] = [];
  const tasks = [
    boardTask("aaabbbccc0000000000000000000001", "Alpha one"),
    boardTask("aaabbbccc0000000000000000000002", "Alpha two"),
    boardTask("zzzunrelatedtask00000000000001", "Solo"),
  ];
  const byId = new Map(tasks.map((t) => [t.id as string, t]));
  const server: Server = createServer((req, res) => {
    const finish = (code: number, payload: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const rawUrl = req.url ?? "/";
    const pathname = rawUrl.split("?")[0] as string;
    if (req.method === "GET" && pathname === "/api/v0/tasks") {
      requests.push({ method: "GET", url: "__list__", body: "" });
      finish(200, { items: tasks, nextCursor: null });
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
      const hit = byId.get(rest);
      if (hit) {
        finish(200, { ...hit, comments: [], files: [] });
        return;
      }
      finish(404, { error: "not found" });
      return;
    }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url: rawUrl, body });
      if (req.method === "PATCH" && pathname.startsWith("/api/v0/tasks/")) {
        const id = pathname.slice("/api/v0/tasks/".length);
        const hit = byId.get(id);
        if (hit) {
          finish(200, { ...hit, ...(JSON.parse(body || "{}") as object) });
          return;
        }
      }
      finish(404, { error: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    listCalls: () => requests.filter((q) => q.url === "__list__").length,
    patchCalls: () =>
      requests.filter((q) => q.method === "PATCH").length,
  };
}

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

describe("tasks --edit in SaaS mode skips the board listing for a full id", () => {
  it("exact id performs ZERO list calls and PATCHes once", async () => {
    const store = freshDir("saas-nolist-store-");
    const home = saasHome();
    const fake = await startFakeBackend();

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        "zzzunrelatedtask00000000000001",
        "--title",
        "New title",
        "--json",
      ],
      { cwd: store, home, env: { VIBEFLOW_API_URL: fake.url } },
    );
    expect(r.code).toBe(0);
    expect(fake.listCalls()).toBe(0);
    expect(fake.patchCalls()).toBe(1);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      task: { id: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.task.id).toBe("zzzunrelatedtask00000000000001");
  });

  it("unique prefix performs exactly ONE listing and PATCHes once", async () => {
    const store = freshDir("saas-nolist-store-");
    const home = saasHome();
    const fake = await startFakeBackend();

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        "zzzunrelated",
        "--title",
        "New title",
        "--json",
      ],
      { cwd: store, home, env: { VIBEFLOW_API_URL: fake.url } },
    );
    expect(r.code).toBe(0);
    expect(fake.listCalls()).toBe(1);
    expect(fake.patchCalls()).toBe(1);
    const payload = JSON.parse(r.stdout) as {
      ok: boolean;
      task: { id: string };
    };
    expect(payload.ok).toBe(true);
    expect(payload.task.id).toBe("zzzunrelatedtask00000000000001");
  });

  it("ambiguous prefix fails with E_AMBIGUOUS and does not PATCH", async () => {
    const store = freshDir("saas-nolist-store-");
    const home = saasHome();
    const fake = await startFakeBackend();

    const r = await spawnCli(
      [
        "tasks",
        store,
        "--edit",
        "aaabbbccc",
        "--title",
        "New title",
        "--json",
      ],
      { cwd: store, home, env: { VIBEFLOW_API_URL: fake.url } },
    );
    expect(r.code).not.toBe(0);
    expect(fake.patchCalls()).toBe(0);
    const envelope = JSON.parse(r.stderr) as {
      ok: boolean;
      error: { code: string; message: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("E_AMBIGUOUS");
    // The refusal names the candidates — never a bare "not found".
    expect(envelope.error.message).toContain("aaabbbccc0000000000000000000001");
    expect(envelope.error.message).toContain("aaabbbccc0000000000000000000002");
  });
});
