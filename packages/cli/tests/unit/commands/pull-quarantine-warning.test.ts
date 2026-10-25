/**
 * Quarantine warnings for `vibeflow pull` (ticket 74d9c46f).
 *
 * A quarantined local record is skipped by the merge (its slot keeps its
 * bytes) — that skip warns exactly ONCE per run, on stderr in every mode
 * and in the `--json` envelope plus result notices. Exit code unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { writeTar } from "@vibeflow-tools/shared/tar";
import {
  hashTaskRecord,
  sha256Hex,
} from "@vibeflow-tools/shared/delta-hash";

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
  return { ...actual, login: vi.fn(), maybeRefreshSettings: vi.fn() };
});

import { resolveProjectAuth } from "../../../src/auth/project-auth.js";
import { readProjectPointer } from "../../../src/auth/project-pointer.js";
import { saasAuth, TEST_API_URL } from "../helpers/mock-project-auth.js";
import { pull, type PullResult } from "../../../src/commands/pull.js";

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

function makeArchive(tasks: Array<{ clientId: string; record: Record<string, unknown> }>): Buffer {
  return gzipSync(
    writeTar([
      {
        path: "manifest.json",
        data: Buffer.from(
          JSON.stringify({
            version: 1,
            taskCount: tasks.length,
            fileCount: 0,
            totalFileBytes: 0,
            tasks: tasks.map((t) => ({ cliId: t.clientId, hash: hashTaskRecord(t.record) })),
            files: [],
          }),
        ),
      },
      ...tasks.map((t) => ({
        path: `tasks/${t.clientId}.json`,
        data: Buffer.from(JSON.stringify({ clientId: t.clientId, record: t.record })),
      })),
    ]),
  );
}

/** Store with one clean task and one quarantined task (unknown key). */
function fixture(): { projectDir: string; badId: string; badPath: string; badBefore: string } {
  const projectDir = mkdtempSync(join(tmpdir(), "pull-qwarn-"));
  const dir = join(projectDir, ".vibeflow", "tasks", "2026-01-01");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "cleantask.json"), JSON.stringify(taskRecord("cleantask")), "utf-8");
  const badId = "badtask";
  const badPath = join(dir, `${badId}.json`);
  const badText = JSON.stringify({ ...taskRecord(badId), unknownData: "deliberate" });
  writeFileSync(badPath, badText, "utf-8");
  return { projectDir, badId, badPath, badBefore: badText };
}

beforeEach(() => {
  // Explicit --board wins, so the pointer is irrelevant here — but the
  // credential must resolve or pull refuses as offline (ADR-0005).
  vi.mocked(resolveProjectAuth).mockResolvedValue(saasAuth());
  vi.mocked(readProjectPointer).mockReturnValue({
    apiUrl: TEST_API_URL,
    id: "b_1",
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  process.exitCode = undefined;
});

describe("pull warns once about quarantined records", () => {
  it("human mode: one stderr warning, notices carry it, exit 0, bytes preserved", async () => {
    const { projectDir, badId, badPath, badBefore } = fixture();
    const bytes = makeArchive([{ clientId: "t1", record: taskRecord("t1") }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(bytes as unknown as BodyInit, { status: 200 })),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = (await pull(projectDir, { board: "b_1" })) as PullResult;

    expect(result.added).toBe(1);
    expect(process.exitCode).toBeUndefined();
    const quarantine = result.notices.filter((n) => n.code === "TASK_RECORD_QUARANTINED");
    expect(quarantine).toHaveLength(1);
    expect(quarantine[0]?.message).toContain("1 task record(s) quarantined");
    expect(quarantine[0]?.message).toContain(badId);
    expect(quarantine[0]?.message).toContain("unknownData");
    const warnings = errSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((line) => line.includes("task record(s) quarantined"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(badId);
    // The quarantined slot is never rewritten by the merge.
    expect(readFileSync(badPath, "utf-8")).toBe(badBefore);
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("--json: the envelope carries the warning and stderr does too", async () => {
    const { projectDir, badId } = fixture();
    const bytes = makeArchive([{ clientId: "t1", record: taskRecord("t1") }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(bytes as unknown as BodyInit, { status: 200 })),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logged: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      logged.push(parts.map(String).join(" "));
    });

    const result = (await pull(projectDir, { board: "b_1", json: true })) as PullResult;

    expect(process.exitCode).toBeUndefined();
    expect(result.notices.some((n) => n.code === "TASK_RECORD_QUARANTINED")).toBe(true);
    const envelope = JSON.parse(logged.find((line) => line.startsWith("{")) ?? "{}") as {
      notices?: Array<{ code: string; message: string }>;
    };
    expect(envelope.notices).toHaveLength(1);
    expect(envelope.notices?.[0]?.code).toBe("TASK_RECORD_QUARANTINED");
    expect(envelope.notices?.[0]?.message).toContain(badId);
    expect(
      errSpy.mock.calls.map((c) => String(c[0])).filter((line) => line.includes("task record(s) quarantined")),
    ).toHaveLength(1);
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("a clean store stays silent: no warning, no notices key in --json", async () => {
    const projectDir = mkdtempSync(join(tmpdir(), "pull-qwarn-clean-"));
    const bytes = makeArchive([{ clientId: "t1", record: taskRecord("t1") }]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(bytes as unknown as BodyInit, { status: 200 })),
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logged: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...parts: unknown[]) => {
      logged.push(parts.map(String).join(" "));
    });

    const result = (await pull(projectDir, { board: "b_1", json: true })) as PullResult;

    expect(result.notices).toEqual([{ code: "PULL_COMPLETED", message: "Pull completed" }]);
    expect(errSpy).not.toHaveBeenCalled();
    const envelope = JSON.parse(logged.find((line) => line.startsWith("{")) ?? "{}") as {
      notices?: unknown;
    };
    expect("notices" in envelope).toBe(false);
    errSpy.mockRestore();
    logSpy.mockRestore();
  });
});
