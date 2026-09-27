/**
 * W4 stdio e2e — real JSON-RPC frames over the spawned
 * `vibeflow mcp --project <dir>` process.
 *
 * Deliberately raw (no SDK client): the assertions that matter are about the
 * bytes the process writes. Every non-empty stdout line must parse as a
 * JSON-RPC frame — no banner, no announcement, no update notice may leak
 * into the protocol channel — and the process must terminate when the client
 * closes stdin (the helper kills it on deadline and flags `timedOut`).
 *
 * HOME is isolated and the spawn cwd is a directory that is never the
 * `--project` target, so a passing run also proves cwd was ignored.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const CLI = join(process.cwd(), "dist", "index.js");
/** Deadline per spawn — hitting it means "did not exit on EOF" (killed). */
const DEADLINE_MS = 15_000;

let home: string; // isolated HOME — a client spawn never trusts cwd
let projectDir: string; // the --project target (a .vibeflow store)
let scratch: string; // cwd for the refusal test — never a project

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "mcp-stdio-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "mcp-stdio-proj-"));
  mkdirSync(join(projectDir, ".vibeflow"));
  scratch = mkdtempSync(join(tmpdir(), "mcp-stdio-scratch-"));
});

afterAll(() => {
  for (const dir of [home, projectDir, scratch]) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Exchange {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  /** true when the deadline fired and the process had to be killed. */
  timedOut: boolean;
}

/**
 * Spawns `node <CLI> mcp ...`, writes one JSON line per input entry, closes
 * stdin (EOF — the case where the spawned server MUST exit) and resolves on
 * process exit. Never leaves the child behind: deadline → SIGKILL.
 */
function runMcp(
  args: string[],
  input: object[],
  opts: { cwd: string },
): Promise<Exchange> {
  return new Promise((resolvePromise) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      HOME: home,
      VIBEFLOW_TELEMETRY: "0",
    };
    // A leaked introspection guard would make the spawn a silent no-op.
    delete env.VIBEFLOW_CLI_SKIP_PARSE;
    delete env.VIBEFLOW_CLI_SKIP_REFRESH;

    const child = spawn("node", [CLI, ...args], {
      cwd: opts.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (stdout += d));
    child.stderr.on("data", (d: string) => (stderr += d));
    child.stdin.on("error", () => {
      /* EPIPE if the server refuses/exits before we finish writing */
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, DEADLINE_MS);

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ stdout, stderr, code, signal, timedOut });
    });

    for (const msg of input) {
      child.stdin.write(`${JSON.stringify(msg)}\n`);
    }
    child.stdin.end(); // EOF
  });
}

/** Every non-empty stdout line must be a JSON-RPC frame; throws otherwise. */
function parseFrames(stdout: string): Record<string, any>[] {
  const lines = stdout.split("\n").filter((l) => l.trim() !== "");
  return lines.map((l, i) => {
    let frame: any;
    try {
      frame = JSON.parse(l);
    } catch (err) {
      throw new Error(
        `stdout line ${i + 1} is not valid JSON (protocol corruption): ${JSON.stringify(l)} — ${String(err)}`,
      );
    }
    expect(frame.jsonrpc, `stdout line ${i + 1} lacks jsonrpc field`).toBe("2.0");
    return frame;
  });
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "stdio-e2e", version: "0" },
  },
};
const READY = { jsonrpc: "2.0", method: "notifications/initialized" };
const LIST = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
const GET_PROJECT = {
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "get_project", arguments: {} },
};

/** One standard session (initialize → list → call), shared by 4 tests. */
let standard: Promise<Exchange> | null = null;
function standardSession(): Promise<Exchange> {
  standard ??= runMcp(["mcp", "--project", projectDir], [INIT, READY, LIST, GET_PROJECT], {
    cwd: home, // spawn cwd is HOME — never the target
  });
  return standard;
}

describe("stdio transport (W4)", () => {
  it("stdio: stdout carries nothing but valid JSON-RPC frames", async () => {
    const run = await standardSession();
    expect(run.timedOut, "server did not exit on stdin EOF").toBe(false);
    // The hard assertion: no banner, no announcement, no notice on stdout.
    expect(run.stdout).not.toBe("");
    const frames = parseFrames(run.stdout);
    expect(frames.length).toBe(3); // initialize + tools/list + get_project responses
    // The human-facing startup line belongs on stderr, not stdout.
    expect(run.stderr).toContain("Project root:");
    expect(run.stderr).toContain(projectDir);
  });

  it("stdio: initialize reports the project root", async () => {
    const run = await standardSession();
    const init = parseFrames(run.stdout).find((f) => f.id === 1);
    expect(init, "no initialize response").toBeTruthy();
    expect(init!.result.instructions).toContain(`Project root: ${projectDir}`);
    expect(init!.result.serverInfo.name).toBe("vibeflow");
  });

  it("stdio: tools/list returns 11 tools", async () => {
    const run = await standardSession();
    const list = parseFrames(run.stdout).find((f) => f.id === 2);
    expect(list, "no tools/list response").toBeTruthy();
    const names = list!.result.tools.map((t: { name: string }) => t.name);
    expect(names.length).toBe(11);
    expect(names).toContain("get_project");
  });

  it("stdio: tools/call get_project returns the --project root", async () => {
    const run = await standardSession();
    const call = parseFrames(run.stdout).find((f) => f.id === 3);
    expect(call, "no tools/call response").toBeTruthy();
    const text = call!.result.content[0].text;
    expect(typeof text).toBe("string");
    const project = JSON.parse(text as string);
    expect(project.root).toBe(resolve(projectDir));
    expect(project.root).not.toBe(home);
  });

  it("stdio: process exits when the client closes stdin (EOF)", async () => {
    // Only initialize, then EOF. runMcp resolves on exit; on a hang it
    // SIGKILLs at the deadline and timedOut flips this assertion.
    const run = await runMcp(["mcp", "--project", projectDir], [INIT], {
      cwd: scratch,
    });
    expect(run.timedOut, "spawned server hung after stdin EOF").toBe(false);
    expect(run.code).toBe(0);
    parseFrames(run.stdout); // still protocol-only
  });

  it("stdio: cwd is ignored (spawn from scratch, target is --project)", async () => {
    const run = await runMcp(["mcp", "--project", projectDir], [INIT], {
      cwd: scratch,
    });
    expect(run.code).toBe(0);
    const init = parseFrames(run.stdout).find((f) => f.id === 1);
    expect(init!.result.instructions).toContain(`Project root: ${projectDir}`);
    expect(init!.result.instructions).not.toContain(`Project root: ${scratch}`);
    // Nothing may be created in the untrusted cwd.
    expect(existsSync(join(scratch, ".vibeflow"))).toBe(false);
  });

  it("stdio: bare `mcp` (no --project) refuses, names --project, writes no stdout", async () => {
    const run = await runMcp(["mcp"], [], { cwd: scratch });
    expect(run.timedOut).toBe(false);
    expect(run.code).toBe(2); // ExitCode.USAGE
    expect(run.stdout).toBe(""); // the refusal must not touch the channel
    expect(run.stderr).toContain("--project");
    expect(run.stderr).toContain("--project <dir> is required");
    expect(existsSync(join(scratch, ".vibeflow"))).toBe(false);
  });
});
