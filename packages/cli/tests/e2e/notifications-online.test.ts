/**
 * `vibeflow notifications --online` end to end (tickets ae96cee7 / ecba6126).
 *
 * The online backend was unit-tested against a stubbed `fetch` and verified by
 * hand against stage — neither runs in CI. This drives the REAL binary against
 * a local HTTP double, so the wire contract is pinned without a deployed
 * environment: the URL it hits, the bearer it sends, the board scope it sends,
 * the envelope it parses, and the refusal it reports when the double answers
 * 401 (never a silent local read).
 *
 * The project link is the same secret-free pointer `vibeflow login` writes
 * (`.vibeflow/settings.json` → `workspace: { apiUrl, id }`); the secret lives in
 * a temp HOME's `credentials.json`, exactly as the CLI stores it. Nothing here
 * touches the developer's real `~/.vibeflow`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { spawn } from "node:child_process";
import { isolatedCliEnv } from "./spawn-isolated.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const CLI_ENTRY = fileURLToPath(new URL("../../dist/cli/index.js", import.meta.url));

interface Captured {
  path: string;
  authorization: string | undefined;
  scope: string | undefined;
}

let server: Server;
let baseUrl: string;
let captured: Captured[];
let respond: (res: import("node:http").ServerResponse) => void;

let home: string;
let projectDir: string;

/** One envelope, deliberately non-empty so the parse is proven, not assumed. */
const ENVELOPE = {
  notifications: [
    {
      id: "evt_wire000000000000000000",
      ts: "2026-11-22T16:58:45.140Z",
      type: "task.create",
      taskId: "aaa11111",
      actor: "agent",
      to: { status: "todo" },
    },
  ],
  nextTs: "2026-11-22T16:58:45.140Z",
  earliestTs: "2026-11-22T16:58:45.140Z",
  gap: false,
  truncated: false,
  count: 1,
};

beforeEach(async () => {
  captured = [];
  respond = (res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(ENVELOPE));
  };
  server = createServer((req, res) => {
    captured.push({
      path: req.url ?? "",
      authorization: req.headers.authorization,
      scope: req.headers["x-vibeflow-scope"] as string | undefined,
    });
    respond(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;

  home = mkdtempSync(join(tmpdir(), "vf-online-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "vf-online-proj-"));
  mkdirSync(join(home, ".vibeflow"), { recursive: true });
  mkdirSync(join(projectDir, ".vibeflow"), { recursive: true });

  // The user-scoped secret: keyed by the NORMALIZED api url.
  const credentialsPath = join(home, ".vibeflow", "credentials.json");
  writeFileSync(
    credentialsPath,
    JSON.stringify({
      [baseUrl]: {
        token: "vbf_pat_deadbeef_testonly",
        workspaceId: "board-xyz",
        account: "e2e@vibeflow.tools",
        updatedAt: "2026-11-22T00:00:00.000Z",
      },
    }),
  );
  chmodSync(credentialsPath, 0o600);

  // The project link: committable, secret-free.
  writeFileSync(
    join(projectDir, ".vibeflow", "settings.json"),
    JSON.stringify({ workspace: { apiUrl: baseUrl, id: "board-xyz" } }),
  );
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(home, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function runCli(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  // ASYNC spawn on purpose: the HTTP double lives in THIS process, and a
  // synchronous spawn would block the event loop that has to answer the
  // request (the CLI would sit on its own 30 s timeout).
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
      cwd: projectDir,
      // Sanctioned isolation (tests/e2e/spawn-isolated.ts): a raw
      // `...process.env` spread would re-inherit HOME, GIT_* and the redirect
      // vars — `cli-spawn-guard` fails the suite for exactly that.
      env: isolatedCliEnv({
        home,
        cwd: projectDir,
        env: {
          VIBEFLOW_API_URL: baseUrl,
          // The suite's setup pins this off; the CLI under test is not the suite.
          VIBEFLOW_EVENTS: "1",
          VIBEFLOW_HOOKS: "0",
        },
      }),
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    const timer = setTimeout(() => child.kill(), 60_000);
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

describe("vibeflow notifications --online (e2e, local HTTP double)", () => {
  it("sends the bearer + board scope and prints the envelope", async () => {
    const run = await runCli(["notifications", "--online", "--json", "--limit", "5"]);
    expect(run.stderr).not.toContain("legacy global token");
    expect(run.status, run.stderr).toBe(0);

    const body = JSON.parse(run.stdout) as {
      ok: boolean;
      target: string;
      count: number;
      nextTs: string;
      notifications: Array<{ taskId: string; type: string }>;
    };
    expect(body.target).toBe("online");
    expect(body.count).toBe(1);
    expect(body.nextTs).toBe(ENVELOPE.nextTs);
    expect(body.notifications[0]?.type).toBe("task.create");

    // The wire: the feed call hits the documented path with the credential
    // from the temp HOME and the board scope from the project pointer. The CLI
    // also resolves `/api/v0/settings` first (plan/feature preflight) — that is
    // not this contract, so only the feed call is pinned here.
    const feedCalls = captured.filter((call) =>
      call.path.startsWith("/api/v0/notifications"),
    );
    expect(feedCalls).toHaveLength(1);
    expect(feedCalls[0]?.path).toBe("/api/v0/notifications?limit=5");
    expect(feedCalls[0]?.authorization).toBe("Bearer vbf_pat_deadbeef_testonly");
    expect(feedCalls[0]?.scope).toBe("board-xyz");
  });

  it("passes `since` through untouched when it is a valid timestamp", async () => {
    const run = await runCli([
      "notifications",
      "--online",
      "--json",
      "--since",
      "2026-11-22T16:58:45.140Z",
    ]);
    expect(run.status, run.stderr).toBe(0);
    const feedCalls = captured.filter((call) =>
      call.path.startsWith("/api/v0/notifications"),
    );
    expect(feedCalls[0]?.path).toContain("since=2026-11-22T16%3A58%3A45.140Z");
  });

  it("refuses a bad `since` locally instead of sending it", async () => {
    const run = await runCli(["notifications", "--online", "--json", "--since", "nonsense"]);
    expect(run.status).not.toBe(0);
    // Refused before the wire: no feed call at all (the settings preflight is
    // a different endpoint and is allowed).
    expect(
      captured.filter((call) => call.path.startsWith("/api/v0/notifications")),
    ).toHaveLength(0);
    expect(run.stdout + run.stderr).toContain("INVALID_SINCE");
  });

  it("fails loudly on a 401 — never falls back to the local feed", async () => {
    respond = (res) => {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized", code: "UNAUTHORIZED" }));
    };
    const run = await runCli(["notifications", "--online", "--json"]);
    expect(run.status).not.toBe(0);
    const text = run.stdout + run.stderr;
    expect(text).toContain("NOTIFICATIONS_FETCH_FAILED");
    // A refusal must not masquerade as an empty online page.
    expect(text).not.toContain('"target": "online"');
  });
});
