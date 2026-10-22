/**
 * `vibeflow tasks --attach` — unit coverage for the attach contract.
 *
 * - Argument resolution: unique-prefix resolution, ambiguous-prefix
 *   refusal, and missing-task refusal all go through the ONE online
 *   resolver (`resolveSaasTaskId`) — no second id rule.
 * - Source validation (`resolveAttachSource`): missing path, directory,
 *   empty file, oversize (with the printed limit), bad names.
 * - Source validation (`resolveAttachSource`): missing path, directory,
 *   empty file, oversize (with the printed limit), bad names.
 * - Duplicate rule (`attachDuplicateRefusal`): the same (task, name)
 *   pair is refused in both modes, so the store never holds it twice.
 * - Online request shape (`uploadSaasFile`, fake fetch): multipart POST
 *   to the task-files collection with the bearer token, and the file
 *   id + name mapping of every response shape.
 * - Local mode: the file lands where the local store expects
 *   (`getFilesDir`) with one ref per name, so `push` plans it exactly
 *   once — never a duplicate.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
  existsSync,
  openSync,
  closeSync,
  ftruncateSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../src/auth/token.js", () => ({
  readToken: vi.fn(),
}));

import * as tokenModule from "../../src/auth/token.js";
import {
  resolveAttachSource,
  attachDuplicateRefusal,
} from "../../src/core/attach.js";
import {
  MAX_FILE_SIZE,
  getFilesDir,
} from "../../src/core/files.js";
import {
  resolveSaasTaskId,
  uploadSaasFile,
} from "../../src/saas/client.js";
import { createTask, readTaskFile, findTaskFilePath } from "../../src/core/tasks.js";
import { listFiles } from "../../src/core/files.js";
import { buildDeltaPlan } from "../../src/saas/delta-archive.js";

const mockedReadToken = vi.mocked(tokenModule.readToken);

beforeEach(() => {
  mockedReadToken.mockResolvedValue("test-token");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete process.env.VIBEFLOW_API_URL;
});

// ── resolveSaasTaskId — the attach path's one id rule ────────────────────────

describe("attach task resolution (resolveSaasTaskId)", () => {
  const board = [
    { id: "2e97853ea69e83aafefbfd3b0ebb63", title: "Plan task" },
    { id: "2e97853e000000000000000000000001", title: "Sibling" },
    { id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", title: "Other" },
  ];

  it("resolves a unique prefix to the full id", () => {
    expect(resolveSaasTaskId(board, "2e97853e00")).toEqual({
      ok: true,
      id: "2e97853e000000000000000000000001",
    });
  });

  it("resolves a full id as-is", () => {
    expect(
      resolveSaasTaskId(board, "2e97853ea69e83aafefbfd3b0ebb63"),
    ).toEqual({ ok: true, id: "2e97853ea69e83aafefbfd3b0ebb63" });
  });

  it("refuses an ambiguous prefix, naming every candidate", () => {
    const resolved = resolveSaasTaskId(board, "2e97853e");
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.code).toBe("E_AMBIGUOUS");
      expect(resolved.message).toContain("2e97853ea69e83aafefbfd3b0ebb63");
      expect(resolved.message).toContain("2e97853e000000000000000000000001");
    }
  });

  it("refuses a missing task with TASK_NOT_FOUND", () => {
    expect(resolveSaasTaskId(board, "ghost")).toEqual({
      ok: false,
      code: "TASK_NOT_FOUND",
      message: "Task not found: ghost",
    });
  });
});

// ── attachDuplicateRefusal — the no-second-upload rule ─────────────────────

describe("attachDuplicateRefusal", () => {
  it("refuses the same (task, name) pair in both modes", () => {
    const refusal = attachDuplicateRefusal("task-1", "plan.md");
    expect(refusal.code).toBe("E_FILE_EXISTS");
    expect(refusal.message).toContain("plan.md");
    expect(refusal.message).toContain("task-1");
    expect(refusal.suggestion).toMatch(/different name/i);
  });
});

// ── resolveAttachSource — source-file validation ────────────────────────────

describe("resolveAttachSource", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "attach-src-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a missing path with E_NOT_FOUND", () => {
    const result = resolveAttachSource(dir, "nope.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_NOT_FOUND");
  });

  it("refuses a directory with E_USAGE", () => {
    mkdirSync(join(dir, "subdir"));
    const result = resolveAttachSource(dir, "subdir");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_USAGE");
      expect(result.error.message).toMatch(/directory/i);
    }
  });

  it("refuses an empty file", () => {
    writeFileSync(join(dir, "empty.md"), "");
    const result = resolveAttachSource(dir, "empty.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("E_USAGE");
  });

  it("refuses an oversize file and prints the limit", () => {
    const big = join(dir, "big.bin");
    const fd = openSync(big, "w");
    try {
      ftruncateSync(fd, MAX_FILE_SIZE + 1);
    } finally {
      closeSync(fd);
    }
    const result = resolveAttachSource(dir, "big.bin");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("E_FILE_TOO_LARGE");
      expect(result.error.message).toContain(String(MAX_FILE_SIZE));
    }
  });

  it("refuses a hidden dotfile name", () => {
    writeFileSync(join(dir, ".hidden.md"), "x");
    const result = resolveAttachSource(dir, ".hidden.md");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INVALID_FILENAME");
  });

  it("refuses an executable type", () => {
    writeFileSync(join(dir, "tool.exe"), "x");
    const result = resolveAttachSource(dir, "tool.exe");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNSUPPORTED_FILE_TYPE");
  });

  it("resolves a real file to its bare name, size, and bytes", () => {
    writeFileSync(join(dir, "plan.md"), "# plan");
    const nested = join(dir, "docs");
    mkdirSync(nested);
    writeFileSync(join(nested, "notes.md"), "notes body");
    const result = resolveAttachSource(dir, "docs/notes.md");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source.name).toBe("notes.md");
    expect(result.source.size).toBe(Buffer.byteLength("notes body"));
    expect(result.source.bytes.toString("utf-8")).toBe("notes body");
  });
});

// ── uploadSaasFile — online request shape (fake fetch) ───────────────────────

describe("uploadSaasFile", () => {
  function mockFetch(
    impl: (url: string, init: Record<string, unknown>) => unknown,
  ) {
    const seen: Array<{ url: string; init: Record<string, unknown> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init: Record<string, unknown>) => {
        seen.push({ url, init });
        return Promise.resolve(impl(url, init));
      }),
    );
    return seen;
  }

  const okJson = (body: unknown) => ({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });

  it("POSTs a multipart file field to the v0 task-files collection with the bearer token", async () => {
    const seen = mockFetch(() =>
      okJson({ success: true, file: { name: "plan.md", size: 4 } }),
    );
    const result = await uploadSaasFile(
      "task-1",
      "plan.md",
      Buffer.from("body"),
    );
    expect(result.ok).toBe(true);
    expect(seen).toHaveLength(1);
    const [{ url, init }] = seen;
    // Collection route — the filename rides the multipart field, not the path.
    expect(url).toContain("/api/v0/tasks/task-1/files");
    expect(url).not.toContain("plan.md");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    const form = init.body as FormData;
    expect(form).toBeInstanceOf(FormData);
    const field = form.get("file");
    expect(field).toBeInstanceOf(Blob);
    if (field instanceof Blob) {
      expect(await field.text()).toBe("body");
    }
    expect((field as File).name).toBe("plan.md");
  });

  it("maps the local { success, file } shape (id falls back to name)", async () => {
    mockFetch(() =>
      okJson({ success: true, file: { name: "plan.md", size: 4 } }),
    );
    const result = await uploadSaasFile("t", "plan.md", Buffer.from("body"));
    expect(result).toEqual({
      ok: true,
      data: { id: "plan.md", name: "plan.md", size: 4 },
    });
  });

  it("maps the cloud { success, file } shape (id + sizeBytes + url)", async () => {
    mockFetch(() =>
      okJson({
        success: true,
        file: {
          id: "file-9",
          name: "plan.md",
          sizeBytes: 4,
          url: "/api/v0/tasks/t/files/file-9",
        },
      }),
    );
    const result = await uploadSaasFile("t", "plan.md", Buffer.from("body"));
    expect(result).toEqual({
      ok: true,
      data: {
        id: "file-9",
        name: "plan.md",
        size: 4,
        url: "/api/v0/tasks/t/files/file-9",
      },
    });
  });

  it("answers TASK_NOT_FOUND on a 404", async () => {
    mockFetch(() => ({ ok: false, status: 404, json: () => Promise.resolve({}) }));
    const result = await uploadSaasFile("ghost", "plan.md", Buffer.from("x"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("TASK_NOT_FOUND");
  });

  it("carries the transport message on a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("boom")),
    );
    const result = await uploadSaasFile("t", "plan.md", Buffer.from("x"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("NETWORK_ERROR");
      expect(result.error.message).toBe("boom");
    }
  });

  it("refuses without a token", async () => {
    mockedReadToken.mockResolvedValue(null);
    const result = await uploadSaasFile("t", "plan.md", Buffer.from("x"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_AUTHENTICATED");
  });
});

// ── Local mode: store location + no-duplicate rule ───────────────────────────

describe("local attach (saveFile dedupe + push plan)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "attach-local-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lands the file where the local store expects it, with one ref", async () => {
    const { saveFile } = await import("../../src/core/files.js");
    const task = createTask(dir, { title: "Attach target", description: "" });
    const info = saveFile(dir, task.id, "plan.md", Buffer.from("v1"));
    expect(info.name).toBe("plan.md");
    expect(existsSync(join(getFilesDir(dir, task.id), "plan.md"))).toBe(true);
    expect(readFileSync(join(getFilesDir(dir, task.id), "plan.md"), "utf-8")).toBe("v1");
    const stored = readTaskFile(findTaskFilePath(dir, task.id)!);
    expect(stored?.files?.filter((f) => f.name === "plan.md")).toHaveLength(1);
    expect(listFiles(dir, task.id)).toHaveLength(1);
  });

  // Store-level dedupe (the rule the CLI's E_FILE_EXISTS refusal protects):
  // even a direct double-write keeps one ref and one file, so pull/push
  // converge instead of duplicating.
  it("the store keeps one ref per name even across a direct double-write", async () => {
    const { saveFile } = await import("../../src/core/files.js");
    const task = createTask(dir, { title: "Dedupe target", description: "" });
    saveFile(dir, task.id, "plan.md", Buffer.from("v1"));
    saveFile(dir, task.id, "plan.md", Buffer.from("v2-longer"));
    expect(listFiles(dir, task.id)).toHaveLength(1);
    expect(readFileSync(join(getFilesDir(dir, task.id), "plan.md"), "utf-8")).toBe(
      "v2-longer",
    );
    const stored = readTaskFile(findTaskFilePath(dir, task.id)!);
    expect(stored?.files?.filter((f) => f.name === "plan.md")).toHaveLength(1);
  });

  it("push plans the attached file exactly once", () => {
    const data = new TextEncoder().encode("v2-longer");
    const plan = buildDeltaPlan(
      [
        {
          id: "t1",
          raw: { title: "x" },
          files: [{ name: "plan.md", size: data.length, data }],
        },
      ],
      { tasks: [], files: [] },
    );
    const fileEntries = plan.tasks.flatMap((t) => t.files);
    expect(fileEntries.filter((f) => f.name === "plan.md")).toHaveLength(1);
  });
});
