import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { brotliDecompressSync } from "node:zlib";

// ── Mock all I/O dependencies before importing push ────────────────────────
vi.mock("../../../src/auth/token.js", () => ({
  readToken: vi.fn(),
  writeToken: vi.fn(),
}));
vi.mock("../../../src/auth/workspace.js", () => ({
  readWorkspace: vi.fn(),
  writeWorkspace: vi.fn(),
}));
// Keep the real createTasksOneByOne() (the v0 import loop under test rides
// through push); only the interactive login flow is stubbed out.
vi.mock("../../../src/auth/login.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/auth/login.js")>();
  return {
    ...actual,
    login: vi.fn(),
    maybeRefreshSettings: vi.fn(),
  };
});
vi.mock("../../../src/core/files.js", () => ({
  listFiles: vi.fn(),
  getFilesDir: vi.fn(),
}));

import * as tokenModule from "../../../src/auth/token.js";
import * as workspaceModule from "../../../src/auth/workspace.js";
import * as loginModule from "../../../src/auth/login.js";
import * as filesModule from "../../../src/core/files.js";
import { push, formatBytes, renderProgressBar, uploadPushedFiles } from "../../../src/commands/push.js";
import { withOldServerProbe } from "../helpers/old-server-probe.js";

// ── helpers ────────────────────────────────────────────────────────────────

function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "push-test-"));
  return dir;
}

function createTaskFile(projectDir: string, task: Record<string, unknown>): string {
  const protoDir = join(projectDir, ".vibeflow", "tasks", "2025-01-01");
  mkdirSync(protoDir, { recursive: true });
  const filePath = join(protoDir, `${task.id}.json`);
  writeFileSync(filePath, JSON.stringify(task));
  return filePath;
}

// Deliberate update (ticket 8d3b2b81): push() now probes GET
// /api/v0/tasks/batch before creating anything. The tests in this file pin
// the LEGACY one-by-one loop, so every stubbed fetch below answers the
// probe with 404 (old server) via the shared withOldServerProbe router —
// assertions on the inner mock (counts, bodies, order) stay EXACTLY as
// they were, proving the fallback path is byte-identical. Batch-path
// behavior is pinned in tests/unit/saas/batch-push-8d3b2b81.test.ts plus
// the "push — batch path" block at the end of this file.

function mockFetchSuccess(result: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    withOldServerProbe(
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(result),
      }),
    ),
  );
}

function mockFetchFailure(status = 500, body: Record<string, unknown> = {}) {
  vi.stubGlobal(
    "fetch",
    withOldServerProbe(
      vi.fn().mockResolvedValue({
        ok: false,
        status,
        statusText: "Internal Server Error",
        json: () => Promise.resolve(body),
      }),
    ),
  );
}

// ── tests ──────────────────────────────────────────────────────────────────

describe("push — no local tasks", () => {
  beforeEach(() => {
    vi.mocked(tokenModule.readToken).mockResolvedValue("test-token");
    vi.mocked(workspaceModule.readWorkspace).mockResolvedValue(null);
    vi.mocked(filesModule.listFiles).mockReturnValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("exits early when there are no local tasks", async () => {
    const projectDir = makeTempProject();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, {});

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("No local tasks found"),
    );
    consoleSpy.mockRestore();
  });
});

describe("push — authentication flow", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("triggers login flow when no token is stored", async () => {
    vi.mocked(tokenModule.readToken)
      .mockResolvedValueOnce(null) // initial check → no token
      .mockResolvedValueOnce(null); // after login → still no token (login failed)
    vi.mocked(loginModule.login).mockResolvedValue(undefined);

    const projectDir = makeTempProject();
    createTaskFile(projectDir, {
      id: "task-1",
      title: "Test",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await push(projectDir, {});

    expect(loginModule.login).toHaveBeenCalledOnce();
    consoleSpy.mockRestore();
  });

  it("sets process.exitCode when login succeeds but token is still missing", async () => {
    vi.mocked(tokenModule.readToken)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null); // still no token after login
    vi.mocked(loginModule.login).mockResolvedValue(undefined);

    const projectDir = makeTempProject();
    createTaskFile(projectDir, {
      id: "task-1",
      title: "Test",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });

    vi.spyOn(console, "error").mockImplementation(() => {});
    const originalExitCode = process.exitCode;

    await push(projectDir, {});

    expect(process.exitCode).toBe(4);
    process.exitCode = originalExitCode;
  });
});

describe("push — import API interaction", () => {
  beforeEach(() => {
    vi.mocked(tokenModule.readToken).mockResolvedValue("test-token");
    vi.mocked(workspaceModule.readWorkspace).mockResolvedValue({
      id: "ws-1",
      name: "My Board",
      url: "http://localhost:3000",
      icon: null,
      email: null,
    });
    vi.mocked(filesModule.listFiles).mockReturnValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("sends tasks to import API and reports success", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, {
      id: "task-abc",
      title: "Push me",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });

    mockFetchSuccess({ id: "remote-1", externalId: "task-abc" });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, { keepLocalFiles: true });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Pushed 1 task"),
    );
    consoleSpy.mockRestore();
  });

  it("sets boardId from --workspace option override on every create", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, {
      id: "task-xyz",
      title: "Override workspace",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "remote-1", externalId: "task-xyz" }),
    });
    vi.stubGlobal("fetch", withOldServerProbe(fetchMock));

    vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, { workspace: "explicit-ws", keepLocalFiles: true });

    // One POST per task to the v0 create op — no batch import call.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/v0/tasks");
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.boardId).toBe("explicit-ws");
    expect(
      fetchMock.mock.calls.some((c) => String(c[0]).includes("/api/cli/import")),
    ).toBe(false);
  });

  // Round-trip input: the push payload is the ONLY route a local verdict takes
  // to the server, so it must carry the tri-state verbatim and omit the key when
  // the task was never assessed (absent must not become false server-side).
  it("carries verified into the pushed JSON; an unassessed task omits the key", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, {
      id: "task-attested",
      title: "Attested",
      status: "review",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
      verified: true,
    });
    createTaskFile(projectDir, {
      id: "task-unassessed",
      title: "Unassessed",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: "remote-1" }),
    });
    vi.stubGlobal("fetch", withOldServerProbe(fetchMock));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, { keepLocalFiles: true });

    // One create per task; each body is the task itself.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map(
      (c) => JSON.parse(c[1]?.body as string) as Record<string, unknown>,
    );
    const byId = Object.fromEntries(
      bodies.map((t) => [t.id as string, t]),
    ) as Record<string, Record<string, unknown>>;
    expect(byId["task-attested"].verified).toBe(true);
    expect("verified" in byId["task-unassessed"]).toBe(false);
  });

  it("counts per-task API errors as skipped without failing the push", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, {
      id: "task-fail",
      title: "Fail me",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });

    // No batch import exists in v0: a non-ok create counts as skipped
    // (same shape as the login-flow import loop).
    mockFetchFailure(422, { error: "Board not found" });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;

    await push(projectDir, { keepLocalFiles: true });

    expect(process.exitCode).toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("0 created, 1 refused: 422 Board not found ×1"),
    );

    consoleSpy.mockRestore();
    process.exitCode = originalExitCode;
  });

  it("reports network error and sets process.exitCode on fetch throw", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, {
      id: "task-net",
      title: "Network fail",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const originalExitCode = process.exitCode;

    await push(projectDir, {});

    expect(process.exitCode).toBe(1);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Network error"));

    consoleSpy.mockRestore();
    process.exitCode = originalExitCode;
  });

  it("shows skipped count when some tasks were skipped", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, {
      id: "task-s1",
      title: "Skipped",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });

    // A non-ok create counts as refused with its TRUE status + server code
    // (ticket dec52322) — the v0 create op has no duplicate detection, so
    // "already imported" must never appear in the summary.
    mockFetchFailure(409, { error: "Already imported" });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, { keepLocalFiles: true });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("0 created, 1 refused: 409 Already imported \u00d71"),
    );
    consoleSpy.mockRestore();
  });

  it("sends Authorization header with Bearer token to import API", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, {
      id: "task-auth",
      title: "Auth check",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ imported: 1, skipped: 0, ids: [], workspaceId: "ws-1", boardId: "b-1", idMap: {} }),
    });
    vi.stubGlobal("fetch", withOldServerProbe(fetchMock));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, { keepLocalFiles: true });

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("posts creates to the v0 path on the default API URL when VIBEFLOW_API_URL is not set", async () => {
    const originalEnv = process.env.VIBEFLOW_API_URL;
    delete process.env.VIBEFLOW_API_URL;

    const projectDir = makeTempProject();
    createTaskFile(projectDir, {
      id: "task-url",
      title: "URL check",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });

    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ imported: 1, skipped: 0, ids: [], workspaceId: "ws-1", boardId: "b-1", idMap: {} }),
    });
    vi.stubGlobal("fetch", withOldServerProbe(fetchMock));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, { keepLocalFiles: true });

    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain("https://app.vibeflow.tools");
    expect(url).toContain("/api/v0/tasks");

    process.env.VIBEFLOW_API_URL = originalEnv;
  });

  it("deletes local task files when keepLocalFiles is false", async () => {
    const projectDir = makeTempProject();
    const filePath = createTaskFile(projectDir, {
      id: "task-del",
      title: "Delete me",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });

    mockFetchSuccess({ id: "remote-1", externalId: "task-del" });

    vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, { keepLocalFiles: false });

    // File should be deleted
    const { existsSync } = await import("node:fs");
    expect(existsSync(filePath)).toBe(false);
  });

  it("keeps local task files when keepLocalFiles is true", async () => {
    const projectDir = makeTempProject();
    const filePath = createTaskFile(projectDir, {
      id: "task-keep",
      title: "Keep me",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });

    mockFetchSuccess({ id: "remote-1", externalId: "task-keep" });

    vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, { keepLocalFiles: true });

    // File should be kept
    const { existsSync } = await import("node:fs");
    expect(existsSync(filePath)).toBe(true);
  });

  it("shows board name when workspace is available", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, {
      id: "task-board",
      title: "Board check",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });

    mockFetchSuccess({ id: "remote-1" });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, { keepLocalFiles: true });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Board:"),
    );
    consoleSpy.mockRestore();
  });
});

describe("push — two-phase link preservation", () => {
  beforeEach(() => {
    vi.mocked(tokenModule.readToken).mockResolvedValue("test-token");
    vi.mocked(workspaceModule.readWorkspace).mockResolvedValue({
      id: "ws-1",
      name: "My Board",
      url: "http://localhost:3000",
      icon: null,
      email: null,
    });
    vi.mocked(filesModule.listFiles).mockReturnValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function mockCreateThenLinks() {
    return vi.fn().mockImplementation((url: unknown, init?: { body?: string }) => {
      if (String(url).endsWith("/links")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
      const body = JSON.parse(init?.body as string) as { id: string };
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: `remote-${body.id}` }),
      });
    });
  }

  it("preserves a parent link with the TARGET EXTERNAL ID via the v0 links op", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, {
      id: "p1",
      title: "Parent",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });
    createTaskFile(projectDir, {
      id: "c1",
      title: "Child",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
      links: [{ taskId: "p1", type: "parent" }],
    });

    const fetchMock = mockCreateThenLinks();
    vi.stubGlobal("fetch", withOldServerProbe(fetchMock));
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, { keepLocalFiles: true });

    // Phase 1 creates carry no links (parent target unknown until created).
    const creates = fetchMock.mock.calls.filter((c) => !String(c[0]).endsWith("/links"));
    expect(creates).toHaveLength(2);
    for (const c of creates) {
      expect("links" in JSON.parse(c[1]?.body as string)).toBe(false);
    }
    // Phase 2 replays the link against the child's REMOTE id with the
    // parent's REMOTE id — never the local ids.
    const linkCalls = fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/links"));
    expect(linkCalls).toHaveLength(1);
    expect(linkCalls[0]?.[0]).toBe("https://app.vibeflow.tools/api/v0/tasks/remote-c1/links");
    expect(JSON.parse(linkCalls[0]?.[1]?.body as string)).toEqual({
      taskId: "remote-p1",
      type: "parent",
    });
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Applied 1 link"));
    consoleSpy.mockRestore();
  });

  it("skips an unknown-target link, reports it, and still completes the push", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, {
      id: "lonely",
      title: "Lonely",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
      links: [{ taskId: "ghost", type: "relates" }],
    });

    const fetchMock = mockCreateThenLinks();
    vi.stubGlobal("fetch", withOldServerProbe(fetchMock));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;

    await push(projectDir, { keepLocalFiles: true });

    // No link POST for the ghost; the push itself is not fatal.
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).endsWith("/links"))).toHaveLength(0);
    expect(process.exitCode).toBeUndefined();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Skipped 1 link (relates ×1)"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("lonely→ghost"));

    logSpy.mockRestore();
    process.exitCode = originalExitCode;
  });

  it("carries link notices on the PushResult when local files are deleted", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, {
      id: "n1",
      title: "N1",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
      links: [{ taskId: "ghost", type: "relates" }],
    });

    vi.stubGlobal("fetch", withOldServerProbe(mockCreateThenLinks()));
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = (await push(projectDir, {})) as { notices: Array<{ code: string; message: string }> };

    expect(result.notices.some((n) => n.code === "PUSH_COMPLETED")).toBe(true);
    const skipped = result.notices.find((n) => n.code === "LINKS_SKIPPED");
    expect(skipped?.message).toContain("n1→ghost");
  });

  it("sends no link POST before every create has completed (two-phase order)", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, {
      id: "child-first",
      title: "Child",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
      links: [{ taskId: "parent-second", type: "parent" }],
    });
    createTaskFile(projectDir, {
      id: "parent-second",
      title: "Parent",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });

    const order: string[] = [];
    const fetchMock = vi.fn().mockImplementation((url: unknown, init?: { body?: string }) => {
      order.push(String(url));
      if (String(url).endsWith("/links")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
      }
      const body = JSON.parse(init?.body as string) as { id: string };
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: `remote-${body.id}` }),
      });
    });
    vi.stubGlobal("fetch", withOldServerProbe(fetchMock));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, { keepLocalFiles: true });

    const firstLink = order.findIndex((u) => u.endsWith("/links"));
    expect(firstLink).toBeGreaterThan(-1);
    expect(order.slice(0, firstLink).every((u) => !u.endsWith("/links"))).toBe(true);
    expect(order.slice(0, firstLink)).toHaveLength(2);
  });
});

describe("push — file upload (uploadTaskFiles)", () => {
  beforeEach(() => {
    vi.mocked(tokenModule.readToken).mockResolvedValue("test-token");
    vi.mocked(workspaceModule.readWorkspace).mockResolvedValue({
      id: "ws-1",
      name: "My Board",
      url: "http://localhost:3000",
      icon: null,
      email: null,
    });
    vi.mocked(filesModule.listFiles).mockReturnValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("uploads files when idMap has mappings and files exist", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, {
      id: "task-files",
      title: "With files",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });

    // Create a file in the files directory
    const filesDir = join(projectDir, ".vibeflow", "files", "task-files");
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(join(filesDir, "screenshot.png"), Buffer.from("fake-png-data"));

    vi.mocked(filesModule.listFiles).mockReturnValue([
      { name: "screenshot.png", size: 13, linkedPath: null },
    ]);
    vi.mocked(filesModule.getFilesDir).mockReturnValue(filesDir);

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: "remote-1", externalId: "task-files" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });
    vi.stubGlobal("fetch", withOldServerProbe(fetchMock));

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await push(projectDir, { keepLocalFiles: true });

    // Second fetch call should be the file upload
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const uploadCall = fetchMock.mock.calls[1];
    expect(uploadCall[0]).toContain("/api/v0/tasks/remote-1/files");
    expect(uploadCall[1].method).toBe("POST");
    expect(uploadCall[1].headers["x-filename"]).toBe("screenshot.png");
  });

  it("skips file upload when the task has no local files", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, {
      id: "task-nomap",
      title: "No mapping",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });

    // listFiles is mocked to [] in this block — nothing to upload.
    mockFetchSuccess({ id: "remote-9", externalId: "task-nomap" });

    const fetchSpy = vi.spyOn(global, "fetch");
    vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, { keepLocalFiles: true });

    // One probe (404 → old-server fallback) + one v0 create; no file upload,
    // no batch import. Deliberate count update (ticket 8d3b2b81): the spy
    // observes the outer fetch including the probe, while the inner-mock
    // assertions elsewhere are unchanged.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/v0/tasks"),
      expect.any(Object),
    );
    expect(
      fetchSpy.mock.calls.some((c) => String(c[0]).includes("/api/cli/import")),
    ).toBe(false);
  });

  it("handles file upload failures gracefully", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, {
      id: "task-fail-upload",
      title: "Upload fail",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });

    const filesDir = join(projectDir, ".vibeflow", "files", "task-fail-upload");
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(join(filesDir, "big-file.png"), Buffer.from("data"));

    vi.mocked(filesModule.listFiles).mockReturnValue([
      { name: "big-file.png", size: 4, linkedPath: null },
    ]);
    vi.mocked(filesModule.getFilesDir).mockReturnValue(filesDir);

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: "remote-2", externalId: "task-fail-upload" }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 413,
        json: () => Promise.resolve({}),
      });
    vi.stubGlobal("fetch", withOldServerProbe(fetchMock));

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn" as const).mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await push(projectDir, { keepLocalFiles: true });

    // Should not crash, file upload failure is handled
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("handles file read errors during upload", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, {
      id: "task-readerr",
      title: "Read error",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });

    // Point to a non-existent file path
    vi.mocked(filesModule.listFiles).mockReturnValue([
      { name: "missing.png", size: 100, linkedPath: "/nonexistent/path/missing.png" },
    ]);
    vi.mocked(filesModule.getFilesDir).mockReturnValue("/nonexistent");

    mockFetchSuccess({ id: "remote-3", externalId: "task-readerr" });

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    // Should not throw — file doesn't exist so it won't be added to allJobs
    await push(projectDir, { keepLocalFiles: true });
  });
});

describe("push — upload compression (single-encode wire format)", () => {
  beforeEach(() => {
    vi.mocked(tokenModule.readToken).mockResolvedValue("test-token");
    vi.mocked(workspaceModule.readWorkspace).mockResolvedValue({
      id: "ws-1",
      name: "My Board",
      url: "http://localhost:3000",
      icon: null,
      email: null,
    });
    vi.mocked(filesModule.listFiles).mockReturnValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function pushOneFile(
    projectDir: string,
    taskId: string,
    filename: string,
    content: Buffer,
  ) {
    createTaskFile(projectDir, {
      id: taskId,
      title: "With file",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });
    const filesDir = join(projectDir, ".vibeflow", "files", taskId);
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(join(filesDir, filename), content);
    vi.mocked(filesModule.listFiles).mockReturnValue([
      { name: filename, size: content.length, linkedPath: null },
    ]);
    vi.mocked(filesModule.getFilesDir).mockReturnValue(filesDir);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: "remote-1", externalId: taskId }),
      })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({}) });
    vi.stubGlobal("fetch", withOldServerProbe(fetchMock));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await push(projectDir, { keepLocalFiles: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    return fetchMock.mock.calls[1]![1] as {
      headers: Record<string, string>;
      body: Uint8Array;
    };
  }

  it("sends eligible text brotli-compressed with x-content-encoding: br", async () => {
    const original = Buffer.from(
      `# Notes\n\n${"Lorem ipsum dolor sit amet. ".repeat(200)}`,
      "utf8",
    );
    const upload = await pushOneFile(
      makeTempProject(),
      "task-md",
      "notes.md",
      original,
    );
    expect(upload.headers["x-content-encoding"]).toBe("br");
    expect(upload.headers["x-filename"]).toBe("notes.md");
    // Wire bytes are NOT plain: single brotli decode recovers the original.
    const wire = Buffer.from(upload.body);
    expect(wire.length).toBeLessThan(original.length);
    expect(brotliDecompressSync(wire).equals(original)).toBe(true);
  });

  it("sends images raw with no content-encoding header", async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01,
    ]);
    const upload = await pushOneFile(
      makeTempProject(),
      "task-png",
      "photo.png",
      png,
    );
    expect(upload.headers["x-content-encoding"]).toBeUndefined();
    expect(Buffer.from(upload.body).equals(png)).toBe(true);
  });

  it("sends baseline-*.json brotli-compressed like any eligible json (server parity, ticket 7a2df818)", async () => {
    const original = Buffer.from(
      `# Notes\n\n${"Lorem ipsum dolor sit amet. ".repeat(200)}`,
      "utf8",
    );
    const upload = await pushOneFile(
      makeTempProject(),
      "task-base",
      "baseline-abc.json",
      original,
    );
    expect(upload.headers["x-content-encoding"]).toBe("br");
    const wire = Buffer.from(upload.body);
    expect(wire.length).toBeLessThan(original.length);
    expect(brotliDecompressSync(wire).equals(original)).toBe(true);
  });
});

describe("push — edge cases", () => {
  beforeEach(() => {
    vi.mocked(tokenModule.readToken).mockResolvedValue("test-token");
    vi.mocked(workspaceModule.readWorkspace).mockResolvedValue(null);
    vi.mocked(filesModule.listFiles).mockReturnValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("uses workspaceId fallback when no saved workspace", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, {
      id: "task-nows",
      title: "No workspace",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });

    mockFetchSuccess({ id: "remote-1" });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, { keepLocalFiles: true });

    // Board label should fall back to workspaceId from server
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Board:"),
    );
    consoleSpy.mockRestore();
  });

  it("counts a bare 500 create response as skipped without failing", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, {
      id: "task-noerrfield",
      title: "No error field",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });

    vi.stubGlobal("fetch", withOldServerProbe(vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: () => Promise.resolve({}), // no error field
    })));

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;

    await push(projectDir, { keepLocalFiles: true });

    expect(process.exitCode).toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("0 created, 1 refused: 500 HTTP 500 ×1"),
    );

    consoleSpy.mockRestore();
    process.exitCode = originalExitCode;
  });

  it("does not delete files when keepLocalFiles is true even with idMap", async () => {
    const projectDir = makeTempProject();
    const filePath = createTaskFile(projectDir, {
      id: "task-keep2",
      title: "Keep with mapping",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });

    mockFetchSuccess({ id: "remote-4", externalId: "task-keep2" });

    vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, { keepLocalFiles: true });

    expect(existsSync(filePath)).toBe(true);
  });
});

describe("formatBytes", () => {
  it("formats bytes under 1024 as B", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(500)).toBe("500 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("formats bytes under 1MB as KB", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024 - 1)).toBe("1024.0 KB");
  });

  it("formats bytes over 1MB as MB", () => {
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MB");
    expect(formatBytes(10 * 1024 * 1024)).toBe("10.0 MB");
  });
});

describe("renderProgressBar", () => {
  it("renders empty bar when done is 0", () => {
    const bar = renderProgressBar(0, 10);
    expect(bar).toMatch(/^\[░+]/);
    expect(bar).not.toContain("█");
  });

  it("renders full bar when done equals total", () => {
    const bar = renderProgressBar(10, 10);
    expect(bar).toMatch(/^\[█+]/);
    expect(bar).not.toContain("░");
  });

  it("renders half-filled bar at 50%", () => {
    const bar = renderProgressBar(5, 10);
    expect(bar).toContain("█");
    expect(bar).toContain("░");
  });

  it("respects custom width", () => {
    const bar = renderProgressBar(5, 10, 10);
    expect(bar.length).toBe(12); // [ + 10 chars + ]
  });

  it("renders progress at 25%", () => {
    const bar = renderProgressBar(1, 4);
    expect(bar).toContain("█");
    expect(bar).toContain("░");
  });
});

describe("push — system-file flag round-trip", () => {
  beforeEach(() => {
    vi.mocked(tokenModule.readToken).mockResolvedValue("test-token");
    vi.mocked(workspaceModule.readWorkspace).mockResolvedValue({
      id: "ws-1",
      name: "My Board",
      url: "http://localhost:3000",
      icon: null,
      email: null,
    });
    vi.mocked(filesModule.listFiles).mockReturnValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("import payload carries files[] refs with the system flag", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, {
      id: "task-flagged",
      title: "Flagged",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
      files: [
        { name: "verify-after.json", addedAt: "2025-01-01T00:00:00.000Z", system: true },
        { name: "notes.md", addedAt: "2025-01-01T00:00:00.000Z" },
      ],
    });
    mockFetchSuccess({ id: "remote-1", externalId: "task-flagged" });

    const fetchSpy = vi.spyOn(global, "fetch");
    vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, { keepLocalFiles: true });

    // The v0 create body is the task itself — file refs ride along verbatim.
    // Deliberate filter update (ticket 8d3b2b81): the probe GET shares the
    // /api/v0/tasks prefix, so match the POST create, not the first hit.
    const createCall = fetchSpy.mock.calls.find((c) =>
      String(c[0]).includes("/api/v0/tasks") &&
      (c[1] as { method?: string } | undefined)?.method === "POST",
    );
    expect(createCall).toBeDefined();
    const body = JSON.parse(createCall![1].body) as {
      files?: Array<{ name: string; system?: boolean }>;
    };
    const files = body.files!;
    expect(files.find((f) => f.name === "verify-after.json")!.system).toBe(true);
    expect("system" in files.find((f) => f.name === "notes.md")!).toBe(false);
  });

  it("byte upload sends x-file-system only for flagged files", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, {
      id: "task-files",
      title: "With files",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });

    const filesDir = join(projectDir, ".vibeflow", "files", "task-files");
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(join(filesDir, "verify-after.json"), Buffer.from("{}"));
    writeFileSync(join(filesDir, "notes.md"), Buffer.from("hi"));

    vi.mocked(filesModule.listFiles).mockReturnValue([
      { name: "verify-after.json", size: 2, system: true },
      { name: "notes.md", size: 2 },
    ]);
    vi.mocked(filesModule.getFilesDir).mockReturnValue(filesDir);

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ id: "remote-1", externalId: "task-files" }),
      })
      .mockResolvedValue({ ok: true, json: () => Promise.resolve({}) });
    vi.stubGlobal("fetch", withOldServerProbe(fetchMock));

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await push(projectDir, { keepLocalFiles: true });

    const uploads = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("/api/v0/tasks/remote-1/files"),
    );
    expect(uploads).toHaveLength(2);
    const sys = uploads.find(
      (c) => c[1].headers["x-filename"] === "verify-after.json",
    )!;
    const user = uploads.find(
      (c) => c[1].headers["x-filename"] === "notes.md",
    )!;
    expect(sys[1].headers["x-file-system"]).toBe("1");
    expect("x-file-system" in user[1].headers).toBe(false);
  });
});

describe("push — batch path (8d3b2b81)", () => {
  beforeEach(() => {
    vi.mocked(tokenModule.readToken).mockResolvedValue("test-token");
    vi.mocked(workspaceModule.readWorkspace).mockResolvedValue({
      id: "ws-1",
      name: "My Board",
      url: "http://localhost:3000",
      icon: null,
      email: null,
    });
    vi.mocked(filesModule.listFiles).mockReturnValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function stubBatchServer(opts: {
    openRemaining?: number;
    totalRemaining?: number;
  } = {}) {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fetchMock = vi.fn(
      (url: unknown, init?: { method?: string; body?: string }) => {
        const method = init?.method ?? "GET";
        calls.push({ url: String(url), method, body: init?.body });
        if (String(url).endsWith("/api/v0/tasks/batch")) {
          if (method === "GET") {
            return Promise.resolve({
              ok: true,
              status: 200,
              json: () =>
                Promise.resolve({
                  maxItems: 100,
                  plan: "free",
                  openLimit: 500,
                  openUsed: 0,
                  openRemaining: opts.openRemaining ?? 500,
                  totalLimit: 2000,
                  totalUsed: 0,
                  totalRemaining: opts.totalRemaining ?? 2000,
                }),
            });
          }
          const payload = JSON.parse(init?.body as string) as {
            items: Array<{ id: string }>;
          };
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                created: payload.items.length,
                failed: 0,
                results: payload.items.map((t) => ({
                  id: `remote-${t.id}`,
                })),
              }),
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      },
    );
    vi.stubGlobal("fetch", fetchMock);
    return calls;
  }

  it("takes the batch path on probe 200: one chunk POST, same summary line", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, {
      id: "task-b1",
      title: "Batch one",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });
    createTaskFile(projectDir, {
      id: "task-b2",
      title: "Batch two",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });

    const calls = stubBatchServer();
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, { keepLocalFiles: true });

    // Probe first, then exactly ONE chunk POST for both tasks.
    expect(calls[0]?.url).toContain("/api/v0/tasks/batch");
    expect(calls[0]?.method).toBe("GET");
    const chunks = calls.filter((c) => c.method === "POST");
    expect(chunks).toHaveLength(1);
    const chunkBody = JSON.parse(chunks[0]?.body as string) as {
      items: Array<Record<string, unknown>>;
      boardId: string;
    };
    expect(chunkBody.items).toHaveLength(2);
    expect(chunkBody.boardId).toBe("ws-1");
    for (const item of chunkBody.items) {
      expect(item).not.toHaveProperty("links");
    }
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Pushed 2 task"),
    );
    // Checkpoint cleared on success — no residue in the project.
    expect(
      existsSync(join(projectDir, ".vibeflow", "push-batch.checkpoint.json")),
    ).toBe(false);
    consoleSpy.mockRestore();
  });

  it("falls back to one-by-one on probe 404: probe first, then per-task creates", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, {
      id: "task-f1",
      title: "Fallback",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });

    const urls: string[] = [];
    const inner = vi.fn((url: unknown, init?: { body?: string }) => {
      urls.push(String(url));
      const payload = JSON.parse(init?.body as string) as { id: string };
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ id: `remote-${payload.id}` }),
      });
    });
    vi.stubGlobal("fetch", withOldServerProbe(inner));
    // The order proof observes the OUTER fetch (probe included); `urls`
    // only sees the inner one-by-one creates.
    const outerSpy = vi.spyOn(global, "fetch");
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, { keepLocalFiles: true });

    const outerUrls = outerSpy.mock.calls.map((c) => String(c[0]));
    const outerMethods = outerSpy.mock.calls.map(
      (c) => (c[1] as { method?: string } | undefined)?.method ?? "GET",
    );
    expect(outerUrls[0]).toContain("/api/v0/tasks/batch");
    expect(outerMethods[0]).toBe("GET");
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("/api/v0/tasks");
    expect(urls.slice(1).every((u) => u.endsWith("/api/v0/tasks"))).toBe(true);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Pushed 1 task"),
    );
    consoleSpy.mockRestore();
  });

  it("preflight refusal aborts before chunk one with exact numbers", async () => {
    const projectDir = makeTempProject();
    const fileA = createTaskFile(projectDir, {
      id: "task-q1",
      title: "Quota one",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });
    createTaskFile(projectDir, {
      id: "task-q2",
      title: "Quota two",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });

    const calls = stubBatchServer({ openRemaining: 0 });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const originalExitCode = process.exitCode;
    process.exitCode = undefined;

    await push(projectDir, { keepLocalFiles: true });

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Preflight refusal"),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("2"));
    // Only the probe ran — no chunk POST, no creates, locals untouched.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(existsSync(fileA)).toBe(true);

    errorSpy.mockRestore();
    process.exitCode = originalExitCode;
  });
});

describe("push — shared phase-3 uploader (ticket 0aac5938)", () => {
  beforeEach(() => {
    vi.mocked(filesModule.listFiles).mockReturnValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  function filesFetchMock() {
    return vi.fn((url: unknown, init?: { method?: string; body?: string }) => {
      const u = String(url);
      if ((init?.method ?? "GET") === "GET") {
        // Presence probe: nothing on the server yet.
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ files: [] }),
        });
      }
      expect(u).toContain("/api/v0/tasks/");
      expect(u).toContain("/files");
      return Promise.resolve({ ok: true, status: 200 });
    });
  }

  function seedLocalFile(projectDir: string, localId: string, name: string) {
    const filesDir = join(projectDir, ".vibeflow", "tasks", "files", localId);
    mkdirSync(filesDir, { recursive: true });
    writeFileSync(join(filesDir, name), "stage-smoke-content");
    vi.mocked(filesModule.listFiles).mockReturnValue([
      { name, size: 19, linkedPath: null },
    ]);
    vi.mocked(filesModule.getFilesDir).mockReturnValue(filesDir);
  }

  it("batch path uploads the jobs and reports counts (login-time parity)", async () => {
    const projectDir = makeTempProject();
    seedLocalFile(projectDir, "t1", "notes.md");
    const fetchMock = filesFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const out = await uploadPushedFiles(
      "https://x.test",
      "tok",
      projectDir,
      [{ localId: "t1", remoteId: "remote-1" }],
      true,
    );
    expect(out.uploaded).toBe(1);
    expect(out.failed).toBe(0);
    expect(out.skippedPresent).toBe(0);
    // Presence probe + one file POST.
    const posts = fetchMock.mock.calls.filter((c) => c[1]?.method === "POST");
    expect(posts).toHaveLength(1);
    // Break: re-inline the uploader in login.ts instead of calling this
    // helper — the two paths drift and login-time pushes drop files again.
  });

  it("sequential path uploads without a presence probe (old-server parity)", async () => {
    const projectDir = makeTempProject();
    seedLocalFile(projectDir, "t1", "notes.md");
    const fetchMock = filesFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    const out = await uploadPushedFiles(
      "https://x.test",
      "tok",
      projectDir,
      [{ localId: "t1", remoteId: "remote-1" }],
      false,
    );
    expect(out.uploaded).toBe(1);
    expect(out.failed).toBe(0);
    // Sequential uploader POSTs directly — no presence GET.
    const gets = fetchMock.mock.calls.filter((c) => (c[1]?.method ?? "GET") === "GET");
    expect(gets).toHaveLength(0);
  });

  it("empty mappings upload nothing and never touch the network", async () => {
    const fetchMock = filesFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    const out = await uploadPushedFiles("https://x.test", "tok", makeTempProject(), [], true);
    expect(out).toEqual({ uploaded: 0, failed: 0, failedFiles: [], skippedPresent: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
