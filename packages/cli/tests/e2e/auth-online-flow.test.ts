/**
 * CLI e2e — online auth domain + the 3ac40717 boards-envelope fix.
 *
 * Proves login → push → create → retrieve end to end against a stub v0
 * backend (recorded-contract shape, never production): the stub speaks the
 * documented envelopes (`GET /api/v0/boards` → `{ items, nextCursor }`,
 * `GET /api/v0/me` → bare principal, `GET /api/v0/settings` →
 * `{ settings }`), enforces the Bearer header on every non-device route,
 * and stores created tasks in memory so the retrieve step reads back what
 * push/create wrote.
 *
 * Non-vacuity proof:
 * - Boards parse: the pre-fix login code read only the legacy
 *   `{ workspaces }` envelope, so the main login test FAILS on it (the stub
 *   answers `{ items }`, the CLI prints "No boards found" and writes no
 *   workspace). Verified red against the pre-fix build, green after.
 * - Auth header: the bad-token test 401s without a valid Bearer — it goes
 *   green only because the CLI actually sends the stored token.
 * - Empty boards: the guidance test asserts the new next-step message, so a
 *   revert to the old one-liner fails it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { seedTask, isolatedEnv } from "./mcp-helpers.js";
import { setupSaaSMode } from "../helpers/saas-auth.js";
// Module-anchored CLI entry (ticket 8ac96ef9) — never process.cwd().
// The env still comes from the isolated chokepoint (isolatedEnv delegates
// to isolatedCliEnv); only the entry constant moved.
import { CLI_ENTRY as CLI_PATH } from "./spawn-isolated.js";

process.env.VIBEFLOW_TELEMETRY = "0";

const TOKEN = "e2e-online-token";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanups.splice(0)) fn();
});

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A HOME directory for the CLI run — empty (offline) by default. */
function cliHome(): string {
  return freshDir("online-flow-home-");
}

function readCredentialEntry(home: string, apiUrl: string): Record<string, unknown> | null {
  const path = join(home, ".vibeflow", "credentials.json");
  if (!existsSync(path)) return null;
  const all = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
  return (all[apiUrl] as Record<string, unknown> | undefined) ?? null;
}

function spawnCliStdin(
  args: string[],
  opts: { cwd: string; home: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number },
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI_PATH, ...args], {
      cwd: opts.cwd,
      env: { ...isolatedEnv(opts.home), VIBEFLOW_NO_BROWSER: "1", ...(opts.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 30_000);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code });
    });
    if (opts.stdin !== undefined) {
      child.stdin.write(opts.stdin);
      child.stdin.end();
    } else {
      child.stdin.end();
    }
  });
}

type StubOptions = { boards?: Array<{ id: string; name: string; slug: string; role: string }> };

/**
 * Stub v0 backend with an in-memory task map. Every non-device route
 * requires `Authorization: Bearer <TOKEN>` (else 401) — that is what makes
 * the bad-token refusal test meaningful.
 */
async function startStub(opts?: StubOptions): Promise<{
  url: string;
  requests: Array<{ method: string; url: string; authed: boolean }>;
  tasks: Map<string, Record<string, unknown>>;
}> {
  const requests: Array<{ method: string; url: string; authed: boolean }> = [];
  const tasks = new Map<string, Record<string, unknown>>();
  let created = 0;
  const boards = opts?.boards ?? [{ id: "board-e2e", name: "E2E Board", slug: "e2e", role: "owner" }];

  const server: Server = createServer((req, res) => {
    const finish = (code: number, payload: unknown, contentType = "application/json") => {
      res.writeHead(code, { "Content-Type": contentType });
      res.end(contentType === "application/json" ? JSON.stringify(payload) : (payload as string));
    };
    const url = req.url ?? "";
    const authed = req.headers.authorization === `Bearer ${TOKEN}`;
    if (req.method === "POST" && url === "/api/v0/auth/device-init") {
      finish(200, {
        deviceCode: "e2e-dev-code",
        userCode: "E2E-123",
        verificationUrl: "http://127.0.0.1/e2e-verify",
        expiresIn: 300,
      });
      return;
    }
    if (req.method === "POST" && url === "/api/v0/auth/device-poll") {
      finish(200, { token: TOKEN });
      return;
    }
    if (!url.startsWith("/api/v0/")) {
      finish(404, { error: "not found" });
      return;
    }
    if (!authed) {
      finish(401, { error: "unauthorized", code: "UNAUTHENTICATED" });
      return;
    }
    requests.push({ method: req.method ?? "", url, authed });
    if (req.method === "GET" && url === "/api/v0/boards") {
      finish(200, { items: boards, nextCursor: null });
      return;
    }
    if (req.method === "GET" && url === "/api/v0/me") {
      finish(200, { id: "user_e2e", name: "E2E", email: "e2e@example.com", image: null });
      return;
    }
    if (req.method === "GET" && url === "/api/v0/settings") {
      finish(200, { settings: {} });
      return;
    }
    const commentsMatch = url.match(/^\/api\/v0\/tasks\/([^/]+)\/comments$/);
    if (req.method === "GET" && commentsMatch) {
      finish(200, {
        comments: [
          {
            id: "c-e2e-1",
            text: "Looks correct, shipping it.",
            author: "agent",
            createdAt: "2026-10-17T10:00:00.000Z",
          },
        ],
      });
      return;
    }
    const filesMatch = url.match(/^\/api\/v0\/tasks\/([^/]+)\/files$/);
    if (req.method === "GET" && filesMatch) {
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      finish(200, { files: [{ name: "notes.md", size: 19, url: `${origin}/api/v0/files/note` }] });
      return;
    }
    if (req.method === "GET" && url === "/api/v0/files/note") {
      finish(200, "hydrated file body", "text/plain");
      return;
    }
    // Detail contract (GET /api/v0/tasks/:id answers the bare task): the
    // listing branch below matches by prefix, so without this route a
    // detail read falls into the listing envelope and the caller renders
    // a task with undefined title/id. Unknown ids 404 (drives the CLI's
    // prefix-resolution fallback), never an empty listing.
    const detailMatch = url.match(/^\/api\/v0\/tasks\/([^/?]+)$/);
    if (req.method === "GET" && detailMatch) {
      const found = tasks.get(detailMatch[1]);
      if (!found) {
        finish(404, { error: "not found" });
        return;
      }
      finish(200, found);
      return;
    }
    if (req.method === "GET" && url.startsWith("/api/v0/tasks")) {
      finish(200, { items: [...tasks.values()], nextCursor: null });
      return;
    }
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const parsed = (body ? JSON.parse(body) : {}) as Record<string, unknown>;
      if (req.method === "POST" && url === "/api/v0/tasks") {
        created++;
        const task = {
          id: `t-created-${created}`,
          title: parsed.title ?? "Untitled",
          description: parsed.description ?? "",
          status: "todo",
          priority: "Medium",
          type: "Task",
          boardId: "board-e2e",
          createdAt: "2026-10-17T10:00:00.000Z",
          updatedAt: "2026-10-17T10:00:00.000Z",
          links: [],
        };
        tasks.set(task.id, task);
        finish(201, task);
        return;
      }
      finish(404, { error: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, requests, tasks };
}

describe("online auth flow: login → push → create → retrieve in great detail", () => {
  it("logs in against the v0 boards envelope, pushes a local task, creates one, and retrieves it with comments and hydrated files", async () => {
    const store = freshDir("online-flow-store-");
    seedTask(store, { id: "local-1", title: "Local seed", status: "todo" });
    const home = cliHome();
    const { url, requests } = await startStub();
    const env = { VIBEFLOW_API_URL: url };

    // 1. login (decline the push prompt — the explicit push below covers it)
    const loginRes = await spawnCliStdin(["login"], { cwd: store, home, env, stdin: "n\n" });
    expect(loginRes.code).toBe(0);
    expect(loginRes.stdout).toContain("Logged in successfully. Now operating in online mode.");
    expect(loginRes.stdout).toContain("E2E Board");
    expect(loginRes.stdout).not.toContain("No boards found");
    // Project-scoped persistence (ADR-0005): the PAT lands user-scoped
    // keyed by apiUrl, the board becomes THIS project's pointer.
    expect(readCredentialEntry(home, url)?.token).toBe(TOKEN);
    const pointer = JSON.parse(readFileSync(join(store, ".vibeflow", "settings.json"), "utf-8")) as {
      workspace?: { apiUrl: string; id: string };
    };
    expect(pointer.workspace?.id).toBe("board-e2e");

    // 2. push the seeded local task
    const pushRes = await spawnCliStdin(["push", store, "--keep-local-files"], { cwd: store, home, env });
    expect(pushRes.code).toBe(0);
    // Wording fix: the result block reads "N created" instead of
    // "Pushed N task(s) online".
    expect(pushRes.stdout).toContain("Push complete: 1 created");
    expect(pushRes.stdout).not.toContain("SaaS");

    // 3. create a ticket online
    const addRes = await spawnCliStdin(
      ["tasks", store, "--add", "--title", "Online ticket", "--description", "detailed description here", "--json"],
      { cwd: store, home, env },
    );
    expect(addRes.code).toBe(0);
    const created = JSON.parse(addRes.stdout) as { ok: boolean; task: { id: string } };
    expect(created.ok).toBe(true);
    const createdId = created.task.id;
    expect(createdId).toMatch(/^t-created-/);

    // 4. retrieve it in great detail (human surface: title, meta, description,
    //    comments, linked files with hydrated content)
    const getRes = await spawnCliStdin(["tasks", store, "--get", createdId], { cwd: store, home, env });
    expect(getRes.code).toBe(0);
    for (const needle of [
      "Online ticket",
      createdId,
      "detailed description here",
      "Looks correct, shipping it.",
      "notes.md",
      "hydrated file body",
    ]) {
      expect(getRes.stdout).toContain(needle);
    }

    // Every cloud route the flow touched carried the Bearer header (the stub
    // 401s otherwise, so green here means the header was really sent).
    expect(requests.length).toBeGreaterThan(0);
    expect(requests.every((r) => r.authed)).toBe(true);
  }, 60_000);

  it("auth status shows mode and account, never secret values", async () => {
    const store = freshDir("online-flow-status-");
    const home = cliHome();
    const { url } = await startStub();
    // Bind a board (project pointer) plus the user-scoped credential so
    // the status has a link to show.
    setupSaaSMode({ home, store, apiUrl: url, token: TOKEN, workspaceId: "board-e2e" });
    const env = { VIBEFLOW_API_URL: url };

    for (const args of [["auth", "status"], ["auth"]]) {
      const r = await spawnCliStdin(args, { cwd: store, home, env });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("Online");
      expect(r.stdout).toContain("(online mode)");
      // Project-scoped status (ADR-0005): board id + API base, never the
      // board name/email from the retired global workspace file, never secrets.
      expect(r.stdout).toContain("board-e2e");
      expect(r.stdout).toContain(url);
      expect(r.stdout).not.toContain(TOKEN);
      expect(r.stdout).not.toContain("SaaS");
    }
  });

  it("keeps bare login/logout working as deprecated aliases with a redirect notice", async () => {
    const store = freshDir("online-flow-deprecated-");
    const home = cliHome();
    const { url } = await startStub();
    const env = { VIBEFLOW_API_URL: url };
    setupSaaSMode({ home, store, apiUrl: url, token: TOKEN, workspaceId: "board-e2e" });

    const logoutRes = await spawnCliStdin(["logout"], { cwd: store, home, env });
    expect(logoutRes.code).toBe(0);
    expect(logoutRes.stdout).toContain("deprecated");
    expect(logoutRes.stdout).toContain("vibeflow auth logout");
    // Project-scoped logout removes the credential for the project's API.
    expect(readCredentialEntry(home, url)).toBeNull();

    const loginRes = await spawnCliStdin(["login"], { cwd: store, home, env, stdin: "n\n" });
    expect(loginRes.code).toBe(0);
    expect(loginRes.stdout).toContain("deprecated");
    expect(loginRes.stdout).toContain("vibeflow auth login");
    expect(loginRes.stdout).toContain("Logged in successfully. Now operating in online mode.");
    expect(readCredentialEntry(home, url)?.token).toBe(TOKEN);
  }, 60_000);
});

describe("online refusals and the empty-boards guidance", () => {
  it("a wrong stored token is refused, proving the Bearer header is checked", async () => {
    const store = freshDir("online-flow-badtoken-");
    const home = cliHome();
    const { url } = await startStub();
    setupSaaSMode({ home, store, apiUrl: url, token: "wrong-token", workspaceId: "board-e2e" });

    const r = await spawnCliStdin(["tasks", store, "--get", "t-created-1", "--json"], {
      cwd: store,
      home,
      env: { VIBEFLOW_API_URL: url },
    });
    expect(r.code).not.toBe(0);
    expect(r.stdout.trim()).toBe("");
    const envelope = JSON.parse(r.stderr) as { ok: boolean; error: { code: string; suggestion: string } };
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe("E_NOT_AUTHENTICATED");
    expect(envelope.error.suggestion).toContain("vibeflow auth login");
  });

  it("an account with no boards gets next-step guidance and no workspace binding", async () => {
    const store = freshDir("online-flow-empty-");
    // A resolvable project (ADR-0005): the CLI refuses outside one.
    mkdirSync(join(store, ".vibeflow"), { recursive: true });
    writeFileSync(join(store, ".vibeflow", "settings.json"), "{}");
    const home = cliHome();
    const { url } = await startStub({ boards: [] });

    const r = await spawnCliStdin(["login"], {
      cwd: store,
      home,
      env: { VIBEFLOW_API_URL: url },
      stdin: "n\n",
    });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Logged in successfully. Now operating in online mode.");
    expect(r.stdout).toContain("No boards found on this account yet.");
    expect(r.stdout).toContain("vibeflow auth login");
    // Login itself succeeded (PAT stored), but nothing was bound: no
    // project pointer, no workspace on the credential.
    expect(readCredentialEntry(home, url)?.token).toBe(TOKEN);
    expect(readCredentialEntry(home, url)?.workspaceId).toBeUndefined();
    expect(
      (JSON.parse(readFileSync(join(store, ".vibeflow", "settings.json"), "utf-8")) as Record<string, unknown>).workspace,
    ).toBeUndefined();
  }, 60_000);
});
