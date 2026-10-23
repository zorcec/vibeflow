/**
 * CLI e2e — online (SaaS) write effects characterization (ticket efcd6992, P4 step 1).
 *
 * Pins TODAY's observable behaviour of the online `--add` / `--edit` write
 * path before the P4 extraction routes it through the shared operations:
 * request shapes and counts, envelope bytes, exits, and side effects.
 *
 * What is pinned (and must survive the extraction byte-for-byte):
 * - edit + --comment awaits the comment POST before reporting success: one
 *   PATCH, one comment POST, exit 0, `ok:true`.
 * - a failed comment POST after a landed PATCH is the truthful partial
 *   `E_COMMENT_SAVE` refusal (exit 1): the PATCH is NOT rolled back, the
 *   message names the re-add remedy.
 * - a `cannot` verdict PATCHes `verified:null` AND records the reason as a
 *   `**Cannot verify:**` comment POST (the reason has no column on either
 *   side, so dropping it would lose task data).
 * - a server `warning` rides the payload as the bare passthrough STRING
 *   `warning` (human: `Server warning:` line) — never folded into the
 *   structured `notices` array, which stays the CLI's own vocabulary.
 * - online create sends NO `author` member (identity is server-stamped);
 *   the success `task` is the server view.
 * - online review with no local clone performs NO auto-commit (nothing
 *   local to commit): exit 0, git history untouched.
 *
 * Two verdict-gating divergences are pinned with flip notes (P4 step 5
 * moves the preflight into the update operation over the AUTHORITATIVE
 * task; the CLI probes below read LOCAL files even in online mode):
 * - a standalone `--set-verify` verdict on a REMOTE Research task with no
 *   local clone is NOT refused — the PATCH carries the verdict.
 * - review of a REMOTE annotated task with no local clone and no verdict
 *   currently PASSES the gate (the local probe finds no task, so the
 *   verify gates skip) and PATCHes.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { execFileSync } from "node:child_process";
import { spawnCli } from "./mcp-helpers.js";
import { gitEnvWithCleanLocation } from "../../src/core/git-env.js";

const cleanups: Array<() => void> = [];
function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A home directory that makes the CLI take the online (SaaS) branch. */
function saasHome(): string {
  const home = freshDir("write-fx-home-");
  mkdirSync(join(home, ".vibeflow"), { recursive: true });
  writeFileSync(join(home, ".vibeflow", "token"), "test-token", "utf-8");
  return home;
}

type RecordedRequest = { method: string; url: string; body: string };

function boardTask(
  id: string,
  title: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id,
    title,
    description: "",
    status: "todo",
    author: "server-stamped-author",
    priority: "Medium",
    type: "Task",
    boardId: "board-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

const gitEnv = gitEnvWithCleanLocation();
function git(dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    env: gitEnv,
    stdio: ["ignore", "pipe", "ignore"],
  }).toString();
}

/**
 * Fake online backend with mutable server state: PATCH merges into the
 * stored row (like the real route), comment POSTs append to an in-memory
 * log, and both can be forced to fail per test.
 */
async function startFakeBackend(opts?: {
  failComment?: boolean;
  warning?: string;
}): Promise<{
  url: string;
  requests: RecordedRequest[];
  commentPosts: () => RecordedRequest[];
  patchBodies: () => Array<Record<string, unknown>>;
  createBodies: () => Array<Record<string, unknown>>;
  taskState: (id: string) => Record<string, unknown> | undefined;
}> {
  const requests: RecordedRequest[] = [];
  const tasks = new Map<string, Record<string, unknown>>([
    ["taskone00000000000000000000001", boardTask("taskone00000000000000000000001", "Online one")],
    [
      "research0000000000000000000001",
      boardTask("research0000000000000000000001", "Remote research", {
        type: "Research",
      }),
    ],
    [
      "annotated000000000000000000001",
      boardTask("annotated000000000000000000001", "Remote annotated", {
        url: "https://example.com/app",
        selector: "#cta",
      }),
    ],
  ]);
  const server: Server = createServer((req, res) => {
    const finish = (code: number, payload: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const rawUrl = req.url ?? "/";
    const pathname = rawUrl.split("?")[0] as string;
    if (req.method === "GET" && pathname === "/api/v0/tasks") {
      finish(200, { items: [...tasks.values()], nextCursor: null });
      return;
    }
    const detailMatch = pathname.match(/^\/api\/v0\/tasks\/([^/]+)$/);
    if (req.method === "GET" && detailMatch) {
      const hit = tasks.get(detailMatch[1]);
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
      if (req.method === "POST" && pathname === "/api/v0/tasks") {
        const parsed = (JSON.parse(body || "{}") as Record<string, unknown>);
        const id = (parsed.id as string) ?? "server-minted-id";
        const row = { ...boardTask(id, (parsed.title as string) ?? ""), ...parsed };
        tasks.set(id, row);
        finish(201, row);
        return;
      }
      if (detailMatch && req.method === "PATCH") {
        const hit = tasks.get(detailMatch[1]);
        if (!hit) {
          finish(404, { error: "not found" });
          return;
        }
        const merged = { ...hit, ...(JSON.parse(body || "{}") as object) };
        tasks.set(detailMatch[1], merged as Record<string, unknown>);
        if (opts?.warning) finish(200, { ...merged, warning: opts.warning });
        else finish(200, merged);
        return;
      }
      if (pathname.endsWith("/comments") && req.method === "POST") {
        if (opts?.failComment) {
          finish(500, { error: "comment store unavailable" });
          return;
        }
        // The v0 contract Comment carries `text` (not `body`) — see
        // `toSaasComment`; any other shape is a malformed response.
        finish(200, {
          id: "comment-1",
          text: (JSON.parse(body || "{}") as { text?: string }).text ?? "",
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
  const parsed = (r: RecordedRequest) =>
    JSON.parse(r.body || "{}") as Record<string, unknown>;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    commentPosts: () =>
      requests.filter((r) => r.method === "POST" && r.url.endsWith("/comments")),
    patchBodies: () =>
      requests.filter((r) => r.method === "PATCH").map(parsed),
    createBodies: () =>
      requests
        .filter((r) => r.method === "POST" && r.url.split("?")[0] === "/api/v0/tasks")
        .map(parsed),
    taskState: (id: string) => tasks.get(id),
  };
}

afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

describe("online write effects (characterization)", () => {
  it("edit --title + --comment: one PATCH, one awaited comment POST, ok:true, exit 0", async () => {
    const store = freshDir("write-fx-store-");
    const home = saasHome();
    const fake = await startFakeBackend();

    const r = await spawnCli(
      [
        "tasks", store,
        "--edit", "taskone00000000000000000000001",
        "--title", "Renamed online",
        "--comment", "NOTE-ONLINE",
        "--json",
      ],
      { cwd: store, home, env: { VIBEFLOW_API_URL: fake.url } },
    );
    expect(r.code).toBe(0);
    expect(fake.patchBodies()).toHaveLength(1);
    expect(fake.patchBodies()[0]).toMatchObject({ title: "Renamed online" });
    const comments = fake.commentPosts();
    expect(comments).toHaveLength(1);
    expect(JSON.parse(comments[0].body)).toMatchObject({ text: "NOTE-ONLINE" });
    const envelope = JSON.parse(r.stdout) as { ok: boolean; task: { id: string; title: string } };
    expect(envelope.ok).toBe(true);
    expect(envelope.task.title).toBe("Renamed online");
    // The PATCH landed server-side: the mutation is durable, not echoed.
    expect(fake.taskState("taskone00000000000000000000001")?.title).toBe(
      "Renamed online",
    );
  });

  it("a failed comment POST after a landed PATCH is E_COMMENT_SAVE (exit 1), and the PATCH is kept", async () => {
    const store = freshDir("write-fx-store-");
    const home = saasHome();
    const fake = await startFakeBackend({ failComment: true });

    const r = await spawnCli(
      [
        "tasks", store,
        "--edit", "taskone00000000000000000000001",
        "--title", "Renamed anyway",
        "--comment", "LOST-NOTE",
        "--json",
      ],
      { cwd: store, home, env: { VIBEFLOW_API_URL: fake.url } },
    );
    expect(r.code).toBe(1);
    const envelope = JSON.parse(r.stderr) as {
      ok: boolean;
      error: { code: string; message: string; suggestion?: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("E_COMMENT_SAVE");
    expect(envelope.error.suggestion).toContain("--comment");
    // Truthful partial: the title PATCH landed even though the comment did not.
    expect(fake.taskState("taskone00000000000000000000001")?.title).toBe(
      "Renamed anyway",
    );
  });

  it("--set-verify cannot PATCHes verified:null and records the reason as a comment", async () => {
    const store = freshDir("write-fx-store-");
    const home = saasHome();
    const fake = await startFakeBackend();

    const r = await spawnCli(
      [
        "tasks", store,
        "--edit", "taskone00000000000000000000001",
        "--set-verify", "cannot",
        "--verify-reason", "staging is down",
        "--json",
      ],
      { cwd: store, home, env: { VIBEFLOW_API_URL: fake.url } },
    );
    expect(r.code).toBe(0);
    expect(fake.patchBodies()).toHaveLength(1);
    expect(fake.patchBodies()[0].verified).toBeNull();
    const comments = fake.commentPosts();
    expect(comments).toHaveLength(1);
    expect(JSON.parse(comments[0].body).text).toContain("staging is down");
  });

  it("a server warning rides the payload as a bare `warning` string, not a notice", async () => {
    const store = freshDir("write-fx-store-");
    const home = saasHome();
    const fake = await startFakeBackend({ warning: "already claimed by X" });

    const r = await spawnCli(
      [
        "tasks", store,
        "--edit", "taskone00000000000000000000001",
        "--title", "Warned",
        "--json",
      ],
      { cwd: store, home, env: { VIBEFLOW_API_URL: fake.url } },
    );
    expect(r.code).toBe(0);
    const envelope = JSON.parse(r.stdout) as {
      ok: boolean;
      task: unknown;
      warning?: unknown;
      notices?: unknown;
    };
    expect(envelope.ok).toBe(true);
    expect(envelope.warning).toBe("already claimed by X");

    const human = await spawnCli(
      [
        "tasks", store,
        "--edit", "taskone00000000000000000000001",
        "--title", "Warned again",
      ],
      { cwd: store, home, env: { VIBEFLOW_API_URL: fake.url } },
    );
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("Server warning:");
  });

  it("online --add sends no `author` member; the task is the server view", async () => {
    const store = freshDir("write-fx-store-");
    const home = saasHome();
    const fake = await startFakeBackend();

    const r = await spawnCli(
      ["tasks", store, "--add", "--title", "Online created", "--json"],
      { cwd: store, home, env: { VIBEFLOW_API_URL: fake.url } },
    );
    expect(r.code).toBe(0);
    const creates = fake.createBodies();
    expect(creates).toHaveLength(1);
    expect(creates[0]).not.toHaveProperty("author");
    const envelope = JSON.parse(r.stdout) as {
      ok: boolean;
      task: { id: string; author: string; boardId: string; createdAt: string };
    };
    expect(envelope.ok).toBe(true);
    // Identity is server-stamped, and the envelope carries the server view.
    expect(envelope.task.author).toBe("server-stamped-author");
    expect(envelope.task.boardId).toBe("board-1");
    expect(typeof envelope.task.createdAt).toBe("string");
  });

  it("online review with no local clone performs no auto-commit and still exits 0", async () => {
    const store = freshDir("write-fx-store-");
    git(store, ["init", "-q"]);
    git(store, ["config", "user.email", "e2e@test.local"]);
    git(store, ["config", "user.name", "E2E"]);
    git(store, ["commit", "-q", "--allow-empty", "-m", "init"]);
    mkdirSync(join(store, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(store, ".vibeflow", "settings.json"),
      JSON.stringify({ autoCommit: true, autoPush: false }),
    );
    const home = saasHome();
    const fake = await startFakeBackend();
    const commitsBefore = git(store, ["rev-list", "--count", "HEAD"]).trim();

    const r = await spawnCli(
      [
        "tasks", store,
        "--edit", "taskone00000000000000000000001",
        "--set-status", "review",
        "--comment", "done online",
        "--commit-message", "feat: online review",
        "--json",
      ],
      { cwd: store, home, env: { VIBEFLOW_API_URL: fake.url } },
    );
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout) as { ok: boolean }).toMatchObject({ ok: true });
    // The review PATCH landed, but there was no local record to commit.
    expect(fake.taskState("taskone00000000000000000000001")?.status).toBe(
      "review",
    );
    expect(git(store, ["rev-list", "--count", "HEAD"]).trim()).toBe(
      commitsBefore,
    );
  });

  it("FLIP: standalone --set-verify on a remote Research task with no local clone is NOT refused today", async () => {
    const store = freshDir("write-fx-store-");
    const home = saasHome();
    const fake = await startFakeBackend();

    // FLIP NOTE (efcd6992 step 5): the preflight must run over the
    // AUTHORITATIVE (remote) task, so this call must refuse with
    // RESEARCH_VERIFY_NOT_ALLOWED and PATCH nothing.
    const r = await spawnCli(
      [
        "tasks", store,
        "--edit", "research0000000000000000000001",
        "--set-verify", "pass",
        "--json",
      ],
      { cwd: store, home, env: { VIBEFLOW_API_URL: fake.url } },
    );
    expect(r.code).toBe(0);
    expect(fake.patchBodies()).toHaveLength(1);
    expect(fake.patchBodies()[0].verified).toBe(true);
  });

  it("FLIP: review of a remote annotated task with no local clone and no verdict PASSES today", async () => {
    const store = freshDir("write-fx-store-");
    mkdirSync(join(store, ".vibeflow"), { recursive: true });
    writeFileSync(
      join(store, ".vibeflow", "settings.json"),
      JSON.stringify({ autoCommit: false, autoPush: false }),
    );
    const home = saasHome();
    const fake = await startFakeBackend();

    // FLIP NOTE (efcd6992 step 5): the gate must run over the AUTHORITATIVE
    // (remote) task, so this must refuse (VERIFY_REQUIRED) before any PATCH.
    const r = await spawnCli(
      [
        "tasks", store,
        "--edit", "annotated000000000000000000001",
        "--set-status", "review",
        "--comment", "review without verdict",
        "--commit-message", "x",
        "--json",
      ],
      { cwd: store, home, env: { VIBEFLOW_API_URL: fake.url } },
    );
    expect(r.code).toBe(0);
    expect(fake.patchBodies()).toHaveLength(1);
    expect(fake.taskState("annotated000000000000000000001")?.status).toBe(
      "review",
    );
  });
});
