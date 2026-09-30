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
 *
 * `eofDelayMs` holds stdin open that long AFTER the last frame is written.
 * Zero (the default) is the historical behaviour: write everything, EOF
 * immediately. A non-zero delay is required when a frame's RESPONSE has to be
 * produced before shutdown — `tools/call start_kanban` binds a port and builds
 * a guide, and an immediate EOF would `process.exit(0)` the child out from
 * under the in-flight call.
 */
function runMcp(
  args: string[],
  input: object[],
  opts: { cwd: string; eofDelayMs?: number },
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
    if (opts.eofDelayMs) {
      setTimeout(() => child.stdin.end(), opts.eofDelayMs);
    } else {
      child.stdin.end(); // EOF
    }
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

  it("stdio: tools/list returns 13 tools", async () => {
    const run = await standardSession();
    const list = parseFrames(run.stdout).find((f) => f.id === 2);
    expect(list, "no tools/list response").toBeTruthy();
    const names = list!.result.tools.map((t: { name: string }) => t.name);
    expect(names.length).toBe(13);
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

// ── start_kanban over the real stdio transport ──────────────────────────────
//
// The stdout-corruption regression. `serve()` used to print its whole startup
// guide (kanban URL, BOARDS & APIS, INTEGRATE INTO YOUR APP, bookmarklet) via
// console.log; under this transport stdout IS the JSON-RPC channel, so calling
// it from a tool corrupted the stream and broke the client. `ServeOptions.quiet`
// is the fix.
//
// This test MUST drive the real transport. Calling the `run:` function
// in-process would pass even with stdout polluted — the corruption only exists
// in what the SPAWNED PROCESS writes to fd 1, so only a spawn can see it.

/** A high, non-default port: 3700 is the tool's default and another test on
 * this machine may hold it. Never 3000/3001 — other projects own those. */
const KANBAN_PORT = 45731;

/**
 * Markers that appear ONLY in `serve()`'s raw console output, never in a tool
 * payload.
 *
 * "INTEGRATE INTO YOUR APP" is deliberately absent: the guide text legitimately
 * contains it, so asserting on it would be a false positive. These four are
 * printed by nothing but the banner.
 */
const BANNER_ONLY = [
  "\u2713 Vibeflow running",
  "BOARDS & APIS",
  "Press Ctrl+C to stop",
  "  Kanban board    ",
];

/** Polls `url` until it answers or the budget runs out. The spawned server
 * lives only as long as the child process, so reachability has to be probed
 * WHILE the session is in flight — not after it resolves on exit. */
async function pollUntilOk(url: string, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

function startKanbanCall(id: number, port: number) {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "start_kanban", arguments: { port } },
  };
}

/** initialize → notifications/initialized → tools/call start_kanban, holding
 * stdin open long enough for the call to be answered. */
function startKanbanSession(port: number): Promise<Exchange> {
  return runMcp(
    ["mcp", "--project", projectDir],
    [INIT, READY, startKanbanCall(2, port)],
    { cwd: home, eofDelayMs: 8000 },
  );
}

describe("start_kanban over stdio (stdout-corruption regression)", () => {
  let session: Promise<Exchange> | null = null;
  function session_(): Promise<Exchange> {
    session ??= startKanbanSession(KANBAN_PORT);
    return session;
  }

  afterAll(async () => {
    // The child binds a port and exits on EOF; runMcp's deadline kills it if
    // it somehow outlives the test, so nothing is left listening.
    await session_().catch(() => {});
  });

  it("does NOT corrupt the JSON-RPC stream when it starts the server", async () => {
    const run = await session_();
    // The hard assertion. `serve()` printing its banner here would put a
    // non-JSON line ("  ✓ Vibeflow running · http://…") on the protocol
    // channel, and parseFrames throws naming the offending line.
    const frames = parseFrames(run.stdout);
    expect(frames.length).toBe(2); // initialize + tools/call
    // Belt-and-braces: no banner-only string reached the channel either.
    for (const marker of BANNER_ONLY) {
      expect(run.stdout, `banner leaked to stdout: ${marker}`).not.toContain(
        marker,
      );
    }
  });

  it("answers start_kanban with a real kanban URL, and the board is reachable", async () => {
    // Its OWN session, not session_(): the shared one is resolved by now and
    // runMcp resolves on process EXIT, so the port it bound is already gone.
    // Reachability has to be probed while the child is alive.
    const pending = startKanbanSession(KANBAN_PORT + 1);
    const reachable = await pollUntilOk(
      `http://localhost:${KANBAN_PORT + 1}/kanban`,
      20_000,
    );
    expect(reachable, "start_kanban did not bind a reachable kanban URL").toBe(
      true,
    );

    const run = await pending;
    const call = parseFrames(run.stdout).find((f) => f.id === 2);
    expect(call, "no tools/call response for start_kanban").toBeTruthy();
    expect(call!.error, "start_kanban refused").toBeUndefined();
    const payload = JSON.parse(call!.result.content[0].text as string);
    expect(payload.started).toBe(true);
    expect(payload.kanbanUrl).toBe(`http://localhost:${KANBAN_PORT + 1}/kanban`);
    expect(payload.injectUrl).toBe(`http://localhost:${KANBAN_PORT + 1}/inject`);
    expect(payload.guide.scriptTag).toBe(
      `<script src="http://localhost:${KANBAN_PORT + 1}/vibeflow-overlay.js" data-vibeflow-overlay></script>`,
    );
    // The instruction block the CLI prints, ANSI-free.
    expect(payload.instructions).toContain(
      `Kanban board: http://localhost:${KANBAN_PORT + 1}/kanban`,
    );
    expect(payload.instructions).toContain(
      "npx @vibeflow-tools/cli tasks --next",
    );
  });

  it("both new tools are discoverable over stdio tools/list", async () => {
    const run = await runMcp(
      ["mcp", "--project", projectDir],
      [INIT, READY, LIST],
      { cwd: home, eofDelayMs: 3000 },
    );
    const list = parseFrames(run.stdout).find((f) => f.id === 2);
    const names = (list!.result.tools as { name: string }[]).map((t) => t.name);
    expect(names).toContain("start_kanban");
    expect(names).toContain("get_integration_guide");
  });
});

describe("get_integration_guide over stdio", () => {
  it("reports that the server is not running and names start_kanban", async () => {
    const call = {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "get_integration_guide", arguments: {} },
    };
    const run = await runMcp(
      ["mcp", "--project", projectDir],
      [INIT, READY, call],
      { cwd: home, eofDelayMs: 3000 },
    );
    parseFrames(run.stdout); // protocol-only, like every other tool
    const res = parseFrames(run.stdout).find((f) => f.id === 2);
    const payload = JSON.parse(res!.result.content[0].text as string);
    expect(payload.serverRunning).toBe(false);
    // Instructions against the DEFAULT port, plus the explicit signal.
    expect(payload.kanbanUrl).toBe("http://localhost:3700/kanban");
    expect(payload.instructions).toContain("NOT running");
    expect(payload.instructions).toContain("start_kanban");
  });
});
});
