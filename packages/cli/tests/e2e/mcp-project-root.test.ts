/**
 * W1 e2e — the project root at the CLI boundary (model1-mcp plan §W1).
 *
 * Spawns the BUILT CLI (`dist/index.js`) in temp dirs with an isolated HOME,
 * so a refusal must exit non-zero naming `--project` and create nothing, and
 * a valid target must be announced as an absolute path before anything is
 * written. Like every e2e harness, run `pnpm build` first — this reads dist.
 *
 * The server-layer backstop (`serve()` called directly on `/` and `$HOME`)
 * lives in `tests/unit/project-root.test.ts`, which the pre-commit hook runs.
 */
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { runCli, getFreePort } from "./mcp-helpers.js";
// Module-anchored CLI entry (ticket 8ac96ef9) — never process.cwd().
// A long-lived server cannot use spawnCliIsolated (which resolves on exit),
// so the env is built by isolatedCliEnv — the same chokepoint.
import { CLI_ENTRY as CLI, isolatedCliEnv } from "./spawn-isolated.js";

const tempDirs: string[] = [];
const children: ChildProcess[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Minimal vibeflow-store marker — NOT a seeded task store. */
function markAsStore(dir: string): void {
  mkdirSync(join(dir, ".vibeflow"), { recursive: true });
}

function spawnCli(
  args: string[],
  opts: { cwd: string; home: string },
): ChildProcess {
  const child = spawn("node", [CLI, ...args], {
    cwd: opts.cwd,
    env: isolatedCliEnv({ home: opts.home, cwd: opts.cwd }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  return child;
}

/** Resolves with stdout+stderr once `match` sees it; rejects on timeout or exit. */
function waitForOutput(
  child: ChildProcess,
  match: (out: string) => boolean,
  label: string,
  timeoutMs = 20_000,
): Promise<string> {
  return new Promise((res, rej) => {
    let out = "";
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.stderr?.off("data", onData);
      child.off("exit", onExit);
      if (err) rej(err);
      else res(out);
    };
    const onData = (chunk: Buffer) => {
      out += chunk.toString();
      if (match(out)) done();
    };
    const timer = setTimeout(
      () => done(new Error(`timed out waiting for ${label}; output:\n${out}`)),
      timeoutMs,
    );
    const onExit = (code: number | null) =>
      done(
        new Error(`CLI exited (${code}) waiting for ${label}; output:\n${out}`),
      );
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", onExit);
  });
}

afterEach(async () => {
  const pending = children.splice(0).map(
    (child) =>
      new Promise<void>((res) => {
        if (child.exitCode !== null || child.signalCode !== null) return res();
        const timer = setTimeout(res, 3_000);
        child.once("close", () => {
          clearTimeout(timer);
          res();
        });
        child.kill("SIGKILL");
      }),
  );
  await Promise.all(pending);
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("W1 — project root at the CLI boundary", () => {
  // Owner order 2026-11-21 (ticket e5176b6c) supersedes the old refusal:
  // `kanban` in a folder that is not a project yet now STARTS one and seeds the
  // example cards, because a first run that refuses or shows a blank board is
  // the activation killer the redesign research named. The guard still holds
  // for every other command and for the stdio/MCP surface — that half is pinned
  // by the sibling tests in this file and must never be relaxed with this one.
  it("kanban from a non-project cwd starts a project and seeds the demo board", async () => {
    const home = tempDir("vf-w1-home-");
    const bare = tempDir("vf-w1-bare-");
    const port = await getFreePort();

    // Long-lived server: spawn, wait for "ready", then kill (afterEach reaps).
    const child = spawnCli(
      ["kanban", "--no-open", "--no-changelog", "-p", String(port)],
      { cwd: bare, home },
    );
    const out = await waitForOutput(
      child,
      (o) => o.includes("Kanban board ready"),
      "kanban ready in a bare cwd",
    );

    expect(out).toContain("was not a Vibeflow project yet");
    expect(out).toContain("Seeded 13 example tasks");
    expect(existsSync(join(bare, ".vibeflow"))).toBe(true);
    expect(existsSync(join(bare, ".vibeflow", "demo-seed.json"))).toBe(true);
    expect(existsSync(join(bare, ".proto"))).toBe(false);
  });

  // The guard has NOT been removed — only `kanban` is allowed to start a
  // project (see the test above). `serve` is the sibling server command and
  // must still refuse a bare cwd and create nothing: that is what keeps the
  // owner order from turning into "any server command drops a store anywhere".
  it("serve in a non-project cwd still refuses and creates nothing", async () => {
    const home = tempDir("vf-w1-home3-");
    const bare = tempDir("vf-w1-bare3-");

    const res = await runCli(["serve", "--no-open", "-p", String(await getFreePort())], {
      cwd: bare,
      home,
    });

    expect(res.code).toBe(2); // ExitCode.USAGE
    expect(res.stderr).toContain("--project");
    expect(existsSync(join(bare, ".vibeflow"))).toBe(false);
    expect(existsSync(join(bare, ".proto"))).toBe(false);
  });

  it("kanban --project <valid> targets <valid> regardless of cwd and announces the absolute root", async () => {
    const home = tempDir("vf-w1-home2-");
    const bare = tempDir("vf-w1-bare2-"); // non-project cwd — would exit 2 without --project
    const proj = tempDir("vf-w1-proj-");
    markAsStore(proj);
    const port = await getFreePort();

    const child = spawnCli(
      ["kanban", "--project", proj, "--no-open", "--no-changelog", "-p", String(port)],
      { cwd: bare, home },
    );
    // Reaching "ready" at all proves the flag was honoured: the same cwd
    // without --project refuses (test above).
    const out = await waitForOutput(child, (o) => o.includes("Kanban board ready"), "kanban ready");

    expect(out).toContain(`Project root: ${resolve(proj)} (`);
    // Targeted: the server created the task store in proj, not in cwd.
    expect(existsSync(join(proj, ".vibeflow", "tasks"))).toBe(true);
    expect(existsSync(join(bare, ".vibeflow"))).toBe(false);
  });

  it("serve (API-only) from a valid project cwd proceeds and announces the absolute root", async () => {
    const home = tempDir("vf-w1-home3-");
    const proj = tempDir("vf-w1-cwd-proj-");
    markAsStore(proj);
    const port = await getFreePort();

    const child = spawnCli(["serve", "--no-open", "-p", String(port)], {
      cwd: proj,
      home,
    });
    const out = await waitForOutput(child, (o) => o.includes("Vibeflow running"), "serve ready");

    expect(out).toContain(`Project root: ${resolve(proj)} (`);
    expect(existsSync(join(proj, ".vibeflow", "tasks"))).toBe(true);
  });
});
