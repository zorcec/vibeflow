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

const CLI = join(process.cwd(), "dist", "index.js");

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
    env: { ...process.env, HOME: opts.home, VIBEFLOW_TELEMETRY: "0" },
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
  it("kanban from a non-project cwd exits non-zero, names --project, creates nothing", async () => {
    const home = tempDir("vf-w1-home-");
    const bare = tempDir("vf-w1-bare-");

    const res = await runCli(["kanban", "--no-open", "--no-changelog"], {
      cwd: bare,
      home,
    });

    expect(res.code).toBe(2); // ExitCode.USAGE
    expect(res.stderr).toContain("--project");
    // ensureTaskDirs would have created both — neither may appear.
    expect(existsSync(join(bare, ".vibeflow"))).toBe(false);
    expect(existsSync(join(bare, ".proto"))).toBe(false);
    expect(existsSync(join(home, ".vibeflow", "tasks"))).toBe(false);
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
