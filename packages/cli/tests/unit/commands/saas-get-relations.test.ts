/**
 * Online `--get` relations display (ticket 086b40aa).
 *
 * The online detail response carries parentId + children, so the CLI renders
 * relations from that ONE response — never a board listing. These are
 * pure-function tests on the formatting layer that drives that display:
 * hasSaasDetailRelations (contract detection) + formatSaasDetailRelations.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Command } from "commander";
import {
  hasSaasDetailRelations,
  formatSaasDetailRelations,
} from "../../../src/core/task-links.js";

/**
 * Force online mode (ADR-0005): each command-level run links its store
 * for real — the board pointer in the store dir, the credential in the
 * temp HOME — so `resolveProjectAuth` answers saas with no mocks. The
 * pure formatter tests above need no auth at all.
 */
import { writeProjectPointer } from "../../../src/auth/project-pointer.js";
import { writeCredential } from "../../../src/auth/credentials.js";
import { getApiUrl } from "../../../src/core/api-url.js";

let createProgram: () => Command;
const cleanups: Array<() => void> = [];

beforeAll(async () => {
  process.env.VIBEFLOW_TELEMETRY = "0";
  // Entry guards in src/index.ts: import for the commander tree without
  // running a command or touching the network. Removed right after import.
  process.env.VIBEFLOW_CLI_SKIP_PARSE = "1";
  process.env.VIBEFLOW_CLI_SKIP_REFRESH = "1";
  try {
    ({ createProgram } = await import("../../../src/index.js"));
  } finally {
    delete process.env.VIBEFLOW_CLI_SKIP_PARSE;
    delete process.env.VIBEFLOW_CLI_SKIP_REFRESH;
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const fn of cleanups.splice(0)) fn();
});

type Captured = {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
  logged: string[];
};

/** Waits for the fire-and-forget `tasks` action to start, then to go quiet. */
async function settle(size: () => number): Promise<void> {
  for (let tick = 0; tick < 50; tick++) {
    await new Promise((r) => setTimeout(r, 10));
    if (size() > 0) break;
  }
  let last = -1;
  let quiet = 0;
  for (let tick = 0; tick < 250; tick++) {
    await new Promise((r) => setTimeout(r, 10));
    const now = size();
    quiet = now === last ? quiet + 1 : 0;
    last = now;
    if (quiet >= 3) return;
  }
}

/**
 * Runs one `tasks --get` invocation in-process, capturing both channels.
 * Human prose goes through `console.log` (captured as `logged`); the
 * `--json` envelope goes through `process.stdout.write` (captured as
 * `stdout`). `outputEnvelope` writes the success envelope to stdout.
 */
async function runGet(
  args: string[],
  home: string,
): Promise<Captured> {
  const previous = {
    stdout: process.stdout.write.bind(process.stdout),
    stderr: process.stderr.write.bind(process.stderr),
    exitCode: process.exitCode,
    home: process.env.HOME,
  };
  const logged: string[] = [];
  let stdout = "";
  let stderr = "";
  (process.stdout.write as unknown) = (chunk: string) => {
    stdout += chunk;
    return true;
  };
  (process.stderr.write as unknown) = (chunk: string) => {
    stderr += chunk;
    return true;
  };
  const logSpy = vi
    .spyOn(console, "log")
    .mockImplementation((...parts: unknown[]) => {
      logged.push(parts.map(String).join(" "));
    });
  process.exitCode = undefined;
  process.env.HOME = home;
  // Link the store project for real under the temp HOME (ADR-0005).
  // args[0] is the store dir for every command-level run below.
  writeProjectPointer(args[0], { apiUrl: getApiUrl(), id: "board-1" });
  await writeCredential(getApiUrl(), {
    token: "test-token",
    workspaceId: "board-1",
  });
  try {
    const program = createProgram();
    await program.parseAsync(["tasks", ...args], { from: "user" });
    await settle(() => stdout.length + stderr.length + logged.length);
    return { stdout, stderr, exitCode: process.exitCode, logged };
  } finally {
    logSpy.mockRestore();
    (process.stdout.write as unknown) = previous.stdout;
    (process.stderr.write as unknown) = previous.stderr;
    process.exitCode = previous.exitCode;
    if (previous.home === undefined) delete process.env.HOME;
    else process.env.HOME = previous.home;
  }
}

/** An isolated HOME plus an (online-irrelevant) store dir. */
function fixture(prefix: string): { store: string; home: string } {
  const base = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(base, { recursive: true, force: true }));
  const store = join(base, "store");
  const home = join(base, "home");
  mkdirSync(store, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { store, home };
}

/**
 * Stubs the fetch layer with one canned DETAIL response (the raw v0 task).
 * `comments: []` + `files: []` ride inline so hydration needs no further
 * request — the whole run must cost exactly ONE fetch call, proving the
 * relations block adds no request of its own.
 */
function stubDetail(detail: Record<string, unknown>) {
  const fetchMock = vi.fn(async (_url: unknown) => ({
    ok: true,
    json: async () => detail,
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function baseDetail(id: string): Record<string, unknown> {
  return {
    id,
    title: `Task ${id}`,
    description: "",
    status: "todo",
    boardId: "board-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    links: [],
    comments: [],
    files: [],
  };
}

const stripAnsi = (s: string): string =>
  s.replace(/\u001b\[[0-9;]*m/g, "");

describe("online --get relations — detail response with children", () => {
  it("prints the parent line and one line per child", () => {
    const detail = {
      parentId: "parent-1234567890abcdef",
      children: [
        { id: "child-aaaa1111", title: "First child", status: "todo" },
        { id: "child-bbbb2222", title: "Second child", status: "done" },
      ],
    };
    expect(hasSaasDetailRelations(detail)).toBe(true);
    const lines = formatSaasDetailRelations(detail);

    expect(lines[0]).toBe("parent:   parent-1234567890abcdef");
    expect(lines[1]).toBe("children (2):");
    expect(lines[2]).toBe("  - child-aaaa1111 First child (todo)");
    expect(lines[3]).toBe("  - child-bbbb2222 Second child (done)");
    expect(lines).toHaveLength(4);
  });
});

describe("online --get relations — task with none", () => {
  it("prints 'children: none' and no parent line", () => {
    const detail = { parentId: null, children: [] as never[] };
    expect(hasSaasDetailRelations(detail)).toBe(true);
    const lines = formatSaasDetailRelations(detail);

    expect(lines).toEqual(["children: none"]);
  });
});

describe("online --get relations — older server predating the contract", () => {
  it("detects the missing contract so the caller prints the single unavailable line", () => {
    expect(hasSaasDetailRelations({})).toBe(false);
  });

  it("does not throw on a response with neither field", () => {
    expect(() => formatSaasDetailRelations({})).not.toThrow();
  });
});

/**
 * COMMAND-LEVEL coverage (ticket 086b40aa review): the pure tests above
 * pin the formatter, but deleting the whole rendering block in src/index.ts
 * would still leave them green. These tests drive the REAL `tasks --get`
 * command in-process (same harness shape as cli-json-notices.test.ts),
 * with the fetch layer stubbed at exactly ONE canned detail response — so
 * every assertion below proves the full path: fetch → render → stdout.
 */
describe("online --get relations — command-level (real tasks --get)", () => {
  it("a detail response WITH children prints the parent line and every child line", async () => {
    const { store, home } = fixture("saas-get-with-children-");
    const fetchMock = stubDetail({
      ...baseDetail("task-with-kids"),
      parentId: "parent-1234567890abcdef",
      children: [
        { id: "child-aaaa1111", title: "First child", status: "todo" },
        { id: "child-bbbb2222", title: "Second child", status: "done" },
      ],
    });

    const r = await runGet([store, "--get", "task-with-kids"], home);
    const text = stripAnsi(r.logged.join("\n"));

    expect(text).toContain("parent:   parent-1234567890abcdef");
    expect(text).toContain("children (2):");
    expect(text).toContain("  - child-aaaa1111 First child (todo)");
    expect(text).toContain("  - child-bbbb2222 Second child (done)");
    expect(text).not.toContain("relations unavailable");
    // The relations block rides the ONE detail response: comments/files
    // are inlined above, so hydration fires nothing further.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a detail response with children: [] prints 'children: none'", async () => {
    const { store, home } = fixture("saas-get-no-children-");
    const fetchMock = stubDetail({
      ...baseDetail("task-childless"),
      parentId: null,
      children: [],
    });

    const r = await runGet([store, "--get", "task-childless"], home);
    const text = stripAnsi(r.logged.join("\n"));

    expect(text).toContain("children: none");
    expect(text).not.toContain("parent:");
    expect(text).not.toContain("relations unavailable");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a response WITHOUT the relation fields prints exactly one cause-neutral line and no fabricated lines", async () => {
    const { store, home } = fixture("saas-get-legacy-");
    // Legacy shape: links[] but NO parentId/children keys at all — the
    // object literal below deliberately omits them (a spread of
    // `{parentId: undefined}` would NOT reproduce this: `"k" in obj`
    // is false here, true there).
    const fetchMock = stubDetail(baseDetail("task-legacy"));
    expect("parentId" in baseDetail("task-legacy")).toBe(false);
    expect("children" in baseDetail("task-legacy")).toBe(false);

    const r = await runGet([store, "--get", "task-legacy"], home);
    const lines = stripAnsi(r.logged.join("\n")).split("\n");

    // Exactly one unavailable line — never silence, never two.
    expect(lines.filter((l) => l.includes("relations unavailable"))).toHaveLength(1);
    // Cause-neutral: the run may be a listing-row fallback on a CURRENT
    // server, so the old "server predates the detail contract" verdict
    // must be gone.
    expect(lines.join("\n")).toContain("relations unavailable in this response");
    expect(lines.join("\n")).not.toContain("predates");
    // No fabricated relations: neither a parent line nor a children line.
    expect(lines.some((l) => l.includes("parent:"))).toBe(false);
    expect(lines.some((l) => /children( \(\d+\))?:/.test(l))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("--json carries parentId/children ONLY when the response carried them", async () => {
    const { store, home } = fixture("saas-get-json-");

    // 1. Full shape: both keys travel in the envelope with their values.
    stubDetail({
      ...baseDetail("task-full"),
      parentId: "parent-1234567890abcdef",
      children: [
        { id: "child-aaaa1111", title: "First child", status: "todo" },
      ],
    });
    const full = await runGet(
      [store, "--get", "task-full", "--json"],
      home,
    );
    const fullTask = (JSON.parse(full.stdout) as { task: Record<string, unknown> }).task;
    expect(fullTask.parentId).toBe("parent-1234567890abcdef");
    expect(fullTask.children).toEqual([
      { id: "child-aaaa1111", title: "First child", status: "todo" },
    ]);

    // 2. Legacy shape: the keys are ABSENT — never synthesised to
    // null/[] for data the server did not send.
    stubDetail(baseDetail("task-legacy-json"));
    const legacy = await runGet(
      [store, "--get", "task-legacy-json", "--json"],
      home,
    );
    const legacyTask = (JSON.parse(legacy.stdout) as { task: Record<string, unknown> }).task;
    expect("parentId" in legacyTask).toBe(false);
    expect("children" in legacyTask).toBe(false);

    // 3. Partial shape: per-key gating — parentId travels, children stays
    // absent (never defaulted to []).
    stubDetail({ ...baseDetail("task-partial"), parentId: "parent-only" });
    const partial = await runGet(
      [store, "--get", "task-partial", "--json"],
      home,
    );
    const partialTask = (JSON.parse(partial.stdout) as { task: Record<string, unknown> }).task;
    expect(partialTask.parentId).toBe("parent-only");
    expect("children" in partialTask).toBe(false);
  });

  it("the relations block costs NO extra request (one fetch per run)", async () => {
    const { store, home } = fixture("saas-get-one-request-");
    // Richest shape (parent + children + comments/files inlined): if the
    // relations block fetched anything, this is the run that would show it.
    const fetchMock = stubDetail({
      ...baseDetail("task-rich"),
      parentId: "parent-1234567890abcdef",
      children: [
        { id: "child-aaaa1111", title: "First child", status: "todo" },
        { id: "child-bbbb2222", title: "Second child", status: "done" },
      ],
    });

    await runGet([store, "--get", "task-rich"], home);

    // Exactly the ONE detail request — no board listing, no second fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/v0/tasks/task-rich");
  });
});
