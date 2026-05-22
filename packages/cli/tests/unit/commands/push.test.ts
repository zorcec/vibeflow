import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── Mock all I/O dependencies before importing push ────────────────────────
vi.mock("../../../src/auth/token.js", () => ({
  readToken: vi.fn(),
  writeToken: vi.fn(),
}));
vi.mock("../../../src/auth/workspace.js", () => ({
  readWorkspace: vi.fn(),
  writeWorkspace: vi.fn(),
}));
vi.mock("../../../src/auth/login.js", () => ({
  login: vi.fn(),
  maybeRefreshSettings: vi.fn(),
}));
vi.mock("../../../src/core/files.js", () => ({
  listFiles: vi.fn(),
  getFilesDir: vi.fn(),
}));

import * as tokenModule from "../../../src/auth/token.js";
import * as workspaceModule from "../../../src/auth/workspace.js";
import * as loginModule from "../../../src/auth/login.js";
import * as filesModule from "../../../src/core/files.js";
import { push, formatBytes, renderProgressBar } from "../../../src/commands/push.js";

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

function mockFetchSuccess(result: Record<string, unknown>) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(result),
    }),
  );
}

function mockFetchFailure(status = 500, body: Record<string, unknown> = {}) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      statusText: "Internal Server Error",
      json: () => Promise.resolve(body),
    }),
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

    expect(process.exitCode).toBe(1);
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

    mockFetchSuccess({ imported: 1, skipped: 0, ids: ["task-abc"], workspaceId: "ws-1", boardId: "board-1", idMap: {} });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, { keepLocalFiles: true });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Pushed 1 task"),
    );
    consoleSpy.mockRestore();
  });

  it("sets workspaceId from --workspace option override", async () => {
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
      json: () => Promise.resolve({ imported: 1, skipped: 0, ids: ["task-xyz"], workspaceId: "explicit-ws", boardId: "b-1", idMap: {} }),
    });
    vi.stubGlobal("fetch", fetchMock);

    vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, { workspace: "explicit-ws", keepLocalFiles: true });

    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.workspaceId).toBe("explicit-ws");
  });

  it("reports failure and sets process.exitCode on API error", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, {
      id: "task-fail",
      title: "Fail me",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });

    mockFetchFailure(422, { error: "Board not found" });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const originalExitCode = process.exitCode;

    await push(projectDir, {});

    expect(process.exitCode).toBe(1);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Import failed"));

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

    mockFetchSuccess({ imported: 0, skipped: 1, ids: [], workspaceId: "ws-1", boardId: "b-1", idMap: {} });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, { keepLocalFiles: true });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Skipped 1 already-imported"),
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
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, { keepLocalFiles: true });

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("uses default API URL when VIBEFLOW_API_URL is not set", async () => {
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
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, { keepLocalFiles: true });

    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain("https://app.vibeflow.tools");

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

    mockFetchSuccess({ imported: 1, skipped: 0, ids: ["task-del"], workspaceId: "ws-1", boardId: "b-1", idMap: { "task-del": "remote-1" } });

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

    mockFetchSuccess({ imported: 1, skipped: 0, ids: ["task-keep"], workspaceId: "ws-1", boardId: "b-1", idMap: { "task-keep": "remote-1" } });

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

    mockFetchSuccess({ imported: 1, skipped: 0, ids: [], workspaceId: "ws-1", boardId: "b-1", idMap: {} });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, { keepLocalFiles: true });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Board:"),
    );
    consoleSpy.mockRestore();
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
    const taskPath = createTaskFile(projectDir, {
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
        json: () => Promise.resolve({
          imported: 1,
          skipped: 0,
          ids: ["task-files"],
          workspaceId: "ws-1",
          boardId: "b-1",
          idMap: { "task-files": "remote-1" },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({}),
      });
    vi.stubGlobal("fetch", fetchMock);

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await push(projectDir, { keepLocalFiles: true });

    // Second fetch call should be the file upload
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const uploadCall = fetchMock.mock.calls[1];
    expect(uploadCall[0]).toContain("/api/tasks/remote-1/files");
    expect(uploadCall[1].method).toBe("POST");
    expect(uploadCall[1].headers["x-filename"]).toBe("screenshot.png");
  });

  it("skips file upload when idMap is empty (no task mappings)", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, {
      id: "task-nomap",
      title: "No mapping",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });

    // Return empty idMap — no files to upload
    mockFetchSuccess({ imported: 1, skipped: 0, ids: [], workspaceId: "ws-1", boardId: "b-1", idMap: {} });

    const fetchSpy = vi.spyOn(global, "fetch");
    vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, { keepLocalFiles: true });

    // Only one fetch call (import API), no file upload
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/cli/import"),
      expect.any(Object),
    );
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
        json: () => Promise.resolve({
          imported: 1,
          skipped: 0,
          ids: ["task-fail-upload"],
          workspaceId: "ws-1",
          boardId: "b-1",
          idMap: { "task-fail-upload": "remote-2" },
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 413,
        json: () => Promise.resolve({}),
      });
    vi.stubGlobal("fetch", fetchMock);

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

    mockFetchSuccess({
      imported: 1,
      skipped: 0,
      ids: ["task-readerr"],
      workspaceId: "ws-1",
      boardId: "b-1",
      idMap: { "task-readerr": "remote-3" },
    });

    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    // Should not throw — file doesn't exist so it won't be added to allJobs
    await push(projectDir, { keepLocalFiles: true });
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

    mockFetchSuccess({ imported: 1, skipped: 0, ids: [], workspaceId: "ws-from-server", boardId: "b-1", idMap: {} });

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await push(projectDir, { keepLocalFiles: true });

    // Board label should fall back to workspaceId from server
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Board:"),
    );
    consoleSpy.mockRestore();
  });

  it("handles API error response without error field", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, {
      id: "task-noerrfield",
      title: "No error field",
      status: "todo",
      selector: "/",
      created: "2025-01-01T00:00:00.000Z",
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: () => Promise.resolve({}), // no error field
    }));

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const originalExitCode = process.exitCode;

    await push(projectDir, {});

    expect(process.exitCode).toBe(1);
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Import failed"));

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

    mockFetchSuccess({
      imported: 1,
      skipped: 0,
      ids: ["task-keep2"],
      workspaceId: "ws-1",
      boardId: "b-1",
      idMap: { "task-keep2": "remote-4" },
    });

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
