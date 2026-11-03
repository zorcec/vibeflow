/**
 * `vibeflow tasks --get-file` / `get_file` — download-path coverage.
 *
 * - Local round-trip: attach bytes (through the shared `attachStandalone`
 *   write path) then `getFile` reads the same bytes back with the
 *   filename, size and content type attached (base64 on the wire).
 * - Missing file refuses with FILE_NOT_FOUND (never an empty payload);
 *   missing selector refuses with E_USAGE; traversal and executable names
 *   refuse through the SAME guards the attach path enforces.
 * - Remote mode reuses the SaaS credential and fetches the bytes from the
 *   board (`GET /api/v0/tasks/:id/files` + `/:fileId`, fake fetch) — the
 *   stripped FileInfo rows the remote adapter returns never block a read.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../src/auth/project-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/auth/project-auth.js")>();
  return { ...actual, resolveProjectAuth: vi.fn() };
});

import { resolveProjectAuth } from "../../src/auth/project-auth.js";
import { saasAuth, TEST_API_URL } from "./helpers/mock-project-auth.js";
import { attachStandalone } from "../../src/core/operations/files.js";
import { getFile } from "../../src/core/operations/files.js";
import { saveFile } from "../../src/core/files.js";
import type { Task } from "../../src/core/types.js";

const mockedReadToken = vi.mocked(resolveProjectAuth);

process.env.VIBEFLOW_API_URL = TEST_API_URL;

let testDir: string;

function createTestTask(overrides: Partial<Task> = {}): Task {
  const task: Task = {
    id: "task-1",
    title: "Get-file task",
    description: "download coverage",
    status: "todo",
    selector: "/",
    created: new Date().toISOString(),
    comments: [],
    files: [],
    ...overrides,
  };
  const dateDir = join(testDir, ".vibeflow", "tasks", task.created.slice(0, 10));
  mkdirSync(dateDir, { recursive: true });
  writeFileSync(
    join(dateDir, `${task.id}.json`),
    JSON.stringify(task, null, 2),
  );
  return task;
}

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), "get-file-"));
  mockedReadToken.mockResolvedValue(saasAuth());
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(testDir, { recursive: true, force: true });
});

// ── Local round-trip ─────────────────────────────────────────────────────────

describe("getFile (local)", () => {
  it("round-trips attached bytes with filename, size and content type", async () => {
    const task = createTestTask();
    const body = Buffer.from("# notes\nround-trip body");
    const attached = await attachStandalone(
      { projectDir: testDir, mode: "local" },
      {
        id: task.id,
        source: { kind: "bytes", filename: "notes.md", content: body },
        onExisting: "replace",
      },
    );
    expect(attached.ok).toBe(true);

    const result = await getFile(
      { projectDir: testDir, mode: "local" },
      { id: task.id, filename: "notes.md" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.filename).toBe("notes.md");
    expect(result.data.size).toBe(body.length);
    expect(result.data.mimeType).toBe("text/markdown");
    expect(Buffer.from(result.data.contentB64, "base64").toString("utf-8")).toBe(
      "# notes\nround-trip body",
    );
  });

  it("falls back to application/octet-stream for an unknown extension", async () => {
    const task = createTestTask();
    saveFile(testDir, task.id, "blob.dat", Buffer.from("0123456789"));
    const result = await getFile(
      { projectDir: testDir, mode: "local" },
      { id: task.id, filename: "blob.dat" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.mimeType).toBe("application/octet-stream");
    expect(result.data.size).toBe(10);
  });

  it("refuses a file that is not attached with FILE_NOT_FOUND", async () => {
    const task = createTestTask();
    const result = await getFile(
      { projectDir: testDir, mode: "local" },
      { id: task.id, filename: "ghost.md" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("FILE_NOT_FOUND");
    expect(result.error.message).toContain("ghost.md");
    expect(result.error.suggestion).toMatch(/file list/i);
  });

  it("refuses a missing task with TASK_NOT_FOUND", async () => {
    createTestTask();
    const result = await getFile(
      { projectDir: testDir, mode: "local" },
      { id: "nope", filename: "notes.md" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("TASK_NOT_FOUND");
  });

  it("refuses a call with neither filename nor fileId with E_USAGE", async () => {
    const task = createTestTask();
    const result = await getFile(
      { projectDir: testDir, mode: "local" },
      { id: task.id },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("E_USAGE");
  });

  it("refuses a traversal name through the shared attach guard", async () => {
    const task = createTestTask();
    const result = await getFile(
      { projectDir: testDir, mode: "local" },
      { id: task.id, filename: "../escape.md" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("INVALID_FILENAME");
  });

  it("refuses an executable attachment through the shared attach guard", async () => {
    const task = createTestTask();
    saveFile(testDir, task.id, "tool.exe", Buffer.from("MZ"));
    const result = await getFile(
      { projectDir: testDir, mode: "local" },
      { id: task.id, filename: "tool.exe" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("UNSUPPORTED_FILE_TYPE");
  });
});

// ── Remote download (fake fetch) ───────────────────────────────────────────

describe("getFile (remote)", () => {
  const DETAIL_TASK = {
    id: "task-1",
    title: "Get-file task",
    description: "download coverage",
    status: "todo",
    priority: null,
    type: null,
    boardId: "board-1",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    links: [],
    commentCount: 0,
    fileCount: 1,
  };
  const REMOTE_BYTES = new TextEncoder().encode("remote bytes here");

  function mockRemote(listFiles: unknown[]) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url.endsWith("/api/v0/tasks/task-1")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(DETAIL_TASK),
          });
        }
        if (url.endsWith("/api/v0/tasks/task-1/files")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ files: listFiles }),
          });
        }
        if (url.endsWith("/api/v0/tasks/task-1/files/f-1")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers({ "content-type": "text/markdown" }),
            arrayBuffer: () =>
              Promise.resolve(
                REMOTE_BYTES.buffer.slice(
                  REMOTE_BYTES.byteOffset,
                  REMOTE_BYTES.byteOffset + REMOTE_BYTES.byteLength,
                ) as ArrayBuffer,
              ),
          });
        }
        return Promise.resolve({
          ok: false,
          status: 404,
          headers: new Headers(),
          json: () => Promise.resolve({ error: "not found" }),
        });
      }),
    );
  }

  it("resolves a bare filename to its file id and returns the bytes", async () => {
    mockRemote([{ id: "f-1", name: "notes.md", mimeType: "text/markdown" }]);
    const result = await getFile(
      { projectDir: testDir, mode: "saas" },
      { id: "task-1", filename: "notes.md" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.filename).toBe("notes.md");
    expect(result.data.mimeType).toBe("text/markdown");
    expect(result.data.size).toBe(REMOTE_BYTES.length);
    expect(Buffer.from(result.data.contentB64, "base64").toString("utf-8")).toBe(
      "remote bytes here",
    );
  });

  it("accepts a fileId directly", async () => {
    mockRemote([{ id: "f-1", name: "notes.md", mimeType: "text/markdown" }]);
    const result = await getFile(
      { projectDir: testDir, mode: "saas" },
      { id: "task-1", fileId: "f-1" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.filename).toBe("notes.md");
  });

  it("refuses a name the board does not list with FILE_NOT_FOUND", async () => {
    mockRemote([{ id: "f-1", name: "notes.md", mimeType: "text/markdown" }]);
    const result = await getFile(
      { projectDir: testDir, mode: "saas" },
      { id: "task-1", filename: "ghost.md" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("FILE_NOT_FOUND");
    expect(result.error.message).toContain("ghost.md");
  });
});
