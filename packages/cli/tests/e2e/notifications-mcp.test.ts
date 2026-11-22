/**
 * `get_notifications` over the spawned stdio MCP server (ticket ae96cee7).
 *
 * Raw JSON-RPC (no SDK client), the same harness as `mcp-stdio.test.ts`: the
 * process is spawned per project, the event comes from a REAL `tasks --add`,
 * and the second call passes the first answer's `nextTs` back as `since` — the
 * cursor contract an agent actually uses.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CLI_ENTRY, isolatedCliEnv, spawnCliIsolated } from "./spawn-isolated.js";
import { ensureTaskDirs } from "../../src/core/tasks.js";

/** The unit setup pins `VIBEFLOW_EVENTS=0`; a spawned child opts back in. */
const EVENTS_ON = { VIBEFLOW_EVENTS: "1" };
const DEADLINE_MS = 20_000;

let home: string;
let projectDir: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "vf-notif-mcp-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "vf-notif-mcp-proj-"));
  ensureTaskDirs(projectDir);
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

interface Exchange {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}

/**
 * One MCP session: write every frame, hold stdin open briefly so the in-flight
 * `tools/call` can answer, then EOF (the server exits on client EOF).
 */
function runMcp(input: object[]): Promise<Exchange> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI_ENTRY, "mcp", "--project", projectDir], {
      cwd: home, // never the project — a passing run proves cwd is ignored
      env: isolatedCliEnv({ home, cwd: home, env: EVENTS_ON }),
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
      /* EPIPE when the server exits before every frame is written */
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, DEADLINE_MS);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
    for (const frame of input) child.stdin.write(`${JSON.stringify(frame)}\n`);
    setTimeout(() => child.stdin.end(), 2000);
  });
}

const INIT = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "notifications-e2e", version: "0" },
  },
};
const READY = { jsonrpc: "2.0", method: "notifications/initialized" };

function callFrame(id: number, args: Record<string, unknown>): object {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "get_notifications", arguments: args },
  };
}

/** Every stdout line must be a JSON-RPC frame — no banner may leak into it. */
function parseFrames(stdout: string): Array<Record<string, any>> {
  return stdout
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const frame = JSON.parse(l) as Record<string, any>;
      expect(frame.jsonrpc).toBe("2.0");
      return frame;
    });
}

/** The payload of one tools/call result (content[0].text parses as JSON). */
function toolPayload(frames: Array<Record<string, any>>, id: number): any {
  const frame = frames.find((f) => f.id === id);
  expect(frame, `no response frame for id ${id}`).toBeTruthy();
  const text = frame!.result?.content?.[0]?.text;
  expect(typeof text).toBe("string");
  return JSON.parse(text as string);
}

describe("get_notifications over stdio MCP (e2e)", () => {
  it("returns the event of a `tasks --add`, then nothing after its nextTs", async () => {
    const add = await spawnCliIsolated(
      ["tasks", "--add", "--title", "Notification via MCP"],
      { cwd: projectDir, home, env: EVENTS_ON },
    );
    expect(add.code, `stderr: ${add.stderr}`).toBe(0);

    const first = await runMcp([INIT, READY, callFrame(2, {})]);
    expect(first.timedOut, "server did not exit on stdin EOF").toBe(false);
    const feed = toolPayload(parseFrames(first.stdout), 2);
    expect(feed.target).toBe("local");
    expect(feed.notifications.map((e: { type: string }) => e.type)).toContain(
      "task.create",
    );
    expect(typeof feed.nextTs).toBe("string");

    // Second call with the cursor the first one handed out: nothing new.
    const second = await runMcp([INIT, READY, callFrame(2, { since: feed.nextTs })]);
    expect(second.timedOut, "server did not exit on stdin EOF").toBe(false);
    const empty = toolPayload(parseFrames(second.stdout), 2);
    expect(empty.notifications.filter(
      (e: { ts: string }) => e.ts > feed.nextTs,
    )).toEqual([]);
  });
});
