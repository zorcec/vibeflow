/**
 * Quarantine warnings for `vibeflow push` (ticket 74d9c46f).
 *
 * Push aborts on an unrepairable record before any network call (pinned by
 * push.test.ts) — that abort now ALSO emits the ONE quarantine warning
 * (count + first reason, never one line per file) before the error
 * propagates. A clean push stays silent and its --json envelope carries no
 * quarantine notice.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../../src/auth/project-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/auth/project-auth.js")>();
  return { ...actual, resolveProjectAuth: vi.fn() };
});
vi.mock("../../../src/auth/project-pointer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/auth/project-pointer.js")>();
  return { ...actual, readProjectPointer: vi.fn() };
});
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

import { resolveProjectAuth } from "../../../src/auth/project-auth.js";
import { readProjectPointer } from "../../../src/auth/project-pointer.js";
import { saasAuth, localAuth, TEST_API_URL } from "../helpers/mock-project-auth.js";
import * as filesModule from "../../../src/core/files.js";
import { push } from "../../../src/commands/push.js";
import { withOldServerProbe } from "../helpers/old-server-probe.js";

function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), "push-qwarn-"));
}

function createTaskFile(projectDir: string, task: Record<string, unknown>): string {
  const protoDir = join(projectDir, ".vibeflow", "tasks", "2025-01-01");
  mkdirSync(protoDir, { recursive: true });
  const filePath = join(protoDir, `${task.id}.json`);
  writeFileSync(filePath, JSON.stringify(task));
  return filePath;
}

const CLEAN_TASK = {
  id: "cleantask",
  title: "Clean",
  description: "desc",
  status: "todo",
  selector: "/",
  created: "2025-01-01T00:00:00.000Z",
  comments: [],
  files: [],
};

beforeEach(() => {
  vi.mocked(resolveProjectAuth).mockResolvedValue(saasAuth());
  vi.mocked(readProjectPointer).mockReturnValue({ apiUrl: TEST_API_URL, id: "ws-1" });
  vi.mocked(filesModule.listFiles).mockReturnValue([]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  process.exitCode = undefined;
});

describe("push warns once about quarantined records", () => {
  it("a quarantined record aborts with one stderr warning (count + reason) before any network call", async () => {
    const projectDir = makeTempProject();
    const path = createTaskFile(projectDir, { ...CLEAN_TASK, unknownData: "deliberate" });
    const before = readFileSync(path, "utf8");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(push(projectDir, { json: true })).rejects.toThrow(
      new RegExp(`Task ${CLEAN_TASK.id}: push preflight failed:.*unknownData`),
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(readFileSync(path, "utf8")).toBe(before);
    const warnings = errSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes("task record(s) quarantined"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("1 task record(s) quarantined");
    expect(warnings[0]).toContain(CLEAN_TASK.id);
    expect(warnings[0]).toContain("unknownData");
    errSpy.mockRestore();
  });

  it("a clean push stays silent and its --json envelope carries no quarantine notice", async () => {
    const projectDir = makeTempProject();
    createTaskFile(projectDir, { ...CLEAN_TASK });
    // Old server (probe 404 ⇒ legacy one-by-one), empty board ⇒ the task sends.
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).endsWith("/api/v0/tasks/import")) return { ok: false, status: 404 };
      if (String(url).includes("/api/v0/tasks?")) {
        return { ok: true, json: async () => ({ items: [], nextCursor: null }) };
      }
      return { ok: true, json: async () => ({ id: "remote-cleantask" }) };
    });
    vi.stubGlobal("fetch", withOldServerProbe(fetchMock));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logged: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      logged.push(parts.map(String).join(" "));
    });

    const result = (await push(projectDir, { json: true })) as {
      notices: Array<{ code: string; message: string }>;
    };

    expect(result.notices.some((n) => n.code === "TASK_RECORD_QUARANTINED")).toBe(false);
    expect(
      errSpy.mock.calls.map((c) => String(c[0])).filter((line) => line.includes("quarantined")),
    ).toHaveLength(0);
    const envelope = JSON.parse(logged.find((line) => line.startsWith("{")) ?? "{}") as {
      notices?: Array<{ code: string }>;
    };
    expect((envelope.notices ?? []).some((n) => n.code === "TASK_RECORD_QUARANTINED")).toBe(false);
    errSpy.mockRestore();
    logSpy.mockRestore();
  });
});
