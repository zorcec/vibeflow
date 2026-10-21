/**
 * `vibeflow pull` command surface (commands/pull.ts).
 *
 * Pins the contract the task states: the write target (`--out` vs the
 * positional dir), `--dry-run` writing nothing, the refusal mapping
 * (403 EXPORT_NOT_ALLOWED → plan message, exit non-zero, exactly one
 * attempt), and the honest summary shape.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { writeTar } from "@vibeflow-tools/shared/tar";
import {
  hashTaskRecord,
  sha256Hex,
} from "@vibeflow-tools/shared/delta-hash";

vi.mock("../../../src/auth/token.js", () => ({
  readToken: vi.fn(),
  writeToken: vi.fn(),
}));
vi.mock("../../../src/auth/workspace.js", () => ({
  readWorkspace: vi.fn(),
  writeWorkspace: vi.fn(),
}));
// Keep the real pull flow; only the interactive login is stubbed out.
vi.mock("../../../src/auth/login.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/auth/login.js")>();
  return { ...actual, login: vi.fn(), maybeRefreshSettings: vi.fn() };
});

import * as tokenModule from "../../../src/auth/token.js";
import * as workspaceModule from "../../../src/auth/workspace.js";
import * as loginModule from "../../../src/auth/login.js";
import {
  pull,
  resolvePullTarget,
  formatPullSummary,
  type PullResult,
} from "../../../src/commands/pull.js";

const BOARD = { id: "b_1", name: "My Board", url: "http://x", icon: null, email: null };

function taskRecord(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `Task ${id}`,
    description: "desc",
    status: "todo",
    selector: "/",
    created: "2026-01-01T00:00:00.000Z",
    comments: [],
    files: [],
    ...extra,
  };
}

/** Minimal valid export archive for one task (+ optional file). */
function makeArchive(
  tasks: Array<{ clientId: string; record: Record<string, unknown> }>,
  files: Array<{ clientId: string; name: string; data: Buffer }> = [],
): Buffer {
  return gzipSync(
    writeTar([
      {
        path: "manifest.json",
        data: Buffer.from(
          JSON.stringify({
            version: 1,
            taskCount: tasks.length,
            fileCount: files.length,
            totalFileBytes: files.reduce((s, f) => s + f.data.length, 0),
            tasks: tasks.map((t) => ({ cliId: t.clientId, hash: hashTaskRecord(t.record) })),
            files: files.map((f) => ({
              cliId: f.clientId,
              name: f.name,
              size: f.data.length,
              sha256: sha256Hex(f.data),
            })),
          }),
        ),
      },
      ...tasks.map((t) => ({
        path: `tasks/${t.clientId}.json`,
        data: Buffer.from(JSON.stringify({ clientId: t.clientId, record: t.record })),
      })),
      ...files.map((f) => ({ path: `files/${f.clientId}/${f.name}`, data: f.data })),
    ]),
  );
}

function stubArchiveFetch(bytes: Buffer) {
  return vi.fn(async () =>
    new Response(bytes as unknown as BodyInit, {
      status: 200,
      headers: { "content-type": "application/gzip" },
    }),
  );
}

function stubRefusal(status: number, code: string) {
  return vi.fn(async () => new Response(JSON.stringify({ error: "refused", code }), { status }));
}

function silence() {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
}

beforeEach(() => {
  vi.mocked(tokenModule.readToken).mockResolvedValue("test-token");
  vi.mocked(workspaceModule.readWorkspace).mockResolvedValue(BOARD);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  process.exitCode = undefined;
});

describe("resolvePullTarget", () => {
  it("defaults to the positional dir", () => {
    expect(resolvePullTarget(".")).toBe(resolve("."));
    expect(resolvePullTarget("some/dir")).toBe(resolve("some/dir"));
  });

  it("--out wins over the positional dir", () => {
    expect(resolvePullTarget("some/dir", "other/place")).toBe(resolve("other/place"));
  });

  it("a blank --out falls back to the positional dir", () => {
    expect(resolvePullTarget("some/dir", "   ")).toBe(resolve("some/dir"));
  });
});

describe("formatPullSummary", () => {
  it("names every tally in one line", () => {
    expect(
      formatPullSummary({
        added: 2,
        merged: 1,
        unchanged: 5,
        conflicts: 1,
        filesWritten: 3,
        filesIdentical: 4,
        filesKept: 1,
        filesSkipped: 2,
        missingBytes: 2,
      }),
    ).toBe(
      "2 added, 1 merged, 5 unchanged, 1 conflict(s) kept local; files: 3 file(s) written, 4 identical, 1 kept, 2 skipped, 2 linked (no bytes)",
    );
  });
});

describe("pull — dry run", () => {
  it("fetches and verifies but writes nothing", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "pull-cmd-"));
    const bytes = makeArchive([{ clientId: "t1", record: taskRecord("t1") }]);
    vi.stubGlobal("fetch", stubArchiveFetch(bytes));
    silence();

    const result = (await pull(projectDir, {
      board: "b_1",
      dryRun: true,
    })) as PullResult;

    expect(result.dryRun).toBe(true);
    expect(result.added).toBe(1);
    expect(existsSync(join(projectDir, ".vibeflow", "tasks"))).toBe(false);
    expect(process.exitCode).toBeUndefined();
  });

  it("--out redirects the write target", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "pull-cmd-"));
    const outDir = mkdtempSync(join(tmpdir(), "pull-out-"));
    const bytes = makeArchive([{ clientId: "t1", record: taskRecord("t1") }]);
    vi.stubGlobal("fetch", stubArchiveFetch(bytes));
    silence();

    const result = (await pull(projectDir, { board: "b_1", out: outDir })) as PullResult;

    expect(result.added).toBe(1);
    expect(existsSync(join(projectDir, ".vibeflow", "tasks"))).toBe(false);
    expect(existsSync(join(outDir, ".vibeflow", "tasks"))).toBe(true);
  });
});

describe("pull — live merge", () => {
  it("writes tasks and files, and reports them honestly", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "pull-cmd-"));
    const bytes = makeArchive(
      [{ clientId: "t1", record: taskRecord("t1", { sortKey: "0002" }) }],
      [{ clientId: "t1", name: "note.txt", data: Buffer.from("hello") }],
    );
    vi.stubGlobal("fetch", stubArchiveFetch(bytes));
    silence();

    const result = (await pull(projectDir, { board: "b_1" })) as PullResult;

    expect(result.dryRun).toBe(false);
    expect(result.added).toBe(1);
    expect(result.filesWritten).toBe(1);
    expect(result.board).toBe("My Board");
    expect(result.notices).toEqual([{ code: "PULL_COMPLETED", message: "Pull completed" }]);
    const stored = JSON.parse(
      readFileSync(
        join(projectDir, ".vibeflow", "tasks", "2026-01-01", "t1.json"),
        "utf-8",
      ),
    ) as { title: string };
    expect(stored.title).toBe("Task t1");
    expect(
      readFileSync(join(projectDir, ".vibeflow", "tasks", "files", "t1", "note.txt"), "utf-8"),
    ).toBe("hello");
  });

  it("an existing task with extra local data merges additively and is reported", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "pull-cmd-"));
    const taskDir = join(projectDir, ".vibeflow", "tasks", "2026-01-01");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(
      join(taskDir, "t1.json"),
      JSON.stringify(taskRecord("t1", { localOnly: "keep me" })),
    );
    const bytes = makeArchive([
      { clientId: "t1", record: taskRecord("t1", { remoteOnly: true }) },
    ]);
    vi.stubGlobal("fetch", stubArchiveFetch(bytes));
    silence();

    const result = (await pull(projectDir, { board: "b_1" })) as PullResult;

    expect(result.merged).toBe(1);
    expect(result.added).toBe(0);
    const stored = JSON.parse(readFileSync(join(taskDir, "t1.json"), "utf-8")) as Record<
      string,
      unknown
    >;
    expect(stored.localOnly).toBe("keep me");
    expect(stored.remoteOnly).toBe(true);
  });
});

describe("pull — refusals", () => {
  it("403 EXPORT_NOT_ALLOWED prints the plan message, exits non-zero, and never retries", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "pull-cmd-"));
    const fetchMock = stubRefusal(403, "EXPORT_NOT_ALLOWED");
    vi.stubGlobal("fetch", fetchMock);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = (await pull(projectDir, { board: "b_1" })) as PullResult;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    expect(result.notices[0]?.code).toBe("E_PLAN_REQUIRED");
    expect(errSpy.mock.calls.flat().join("\n")).toContain("Pro plan");
  });

  it("413 EXPORT_TOO_LARGE is non-retryable", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "pull-cmd-"));
    const fetchMock = stubRefusal(413, "EXPORT_TOO_LARGE");
    vi.stubGlobal("fetch", fetchMock);
    silence();

    const result = (await pull(projectDir, { board: "b_1" })) as PullResult;

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBe(1);
    expect(result.notices[0]?.code).toBe("E_EXPORT_TOO_LARGE");
  });

  it("a corrupt archive writes nothing and exits non-zero", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "pull-cmd-"));
    vi.stubGlobal("fetch", stubArchiveFetch(Buffer.from("not-gzip")));
    silence();

    const result = (await pull(projectDir, { board: "b_1" })) as PullResult;

    expect(process.exitCode).toBe(1);
    expect(result.notices[0]?.code).toBe("PULL_VERIFY_FAILED");
    expect(existsSync(join(projectDir, ".vibeflow", "tasks"))).toBe(false);
  });
});

describe("pull — auth", () => {
  it("starts the login flow when no token is stored, and refuses when it still fails", async () => {
    vi.mocked(tokenModule.readToken).mockResolvedValue(null);
    const projectDir = mkdtempSync(join(tmpdir(), "pull-cmd-"));
    silence();
    const originalExitCode = process.exitCode;

    await pull(projectDir, { board: "b_1" });

    expect(loginModule.login).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(4);
    process.exitCode = originalExitCode;
  });

  it("a 401 maps to the auth exit code", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "pull-cmd-"));
    vi.stubGlobal("fetch", stubRefusal(401, "UNAUTHORIZED"));
    silence();

    await pull(projectDir, { board: "b_1" });

    expect(process.exitCode).toBe(4);
  });
});
