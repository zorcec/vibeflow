/**
 * Bulk-push progress bar + from/to counter (ticket 7db36f78).
 *
 * The login-time push (`promptPushLocalTasks`) and the standalone `push`
 * command share the `createTasksOneByOne()` loop, so one `onProgress` hook
 * covers both. These tests pin: exact counter math on a seeded push
 * (all-ok and mid-way-failure), TTY bar vs piped counter-only rendering,
 * and that progress NEVER touches stdout (stderr only, so `--json` and
 * piped output stay clean).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("../../../src/auth/token.js", () => ({
  readToken: vi.fn(),
  writeToken: vi.fn(),
}));
vi.mock("../../../src/auth/workspace.js", () => ({
  readWorkspace: vi.fn(),
  writeWorkspace: vi.fn(),
}));
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

import {
  createTasksOneByOne,
  formatTaskPushProgress,
  reportTaskPushProgress,
} from "../../../src/auth/login.js";
import * as tokenModule from "../../../src/auth/token.js";
import * as workspaceModule from "../../../src/auth/workspace.js";
import * as filesModule from "../../../src/core/files.js";
import { push } from "../../../src/commands/push.js";
// Deliberate update (ticket 8d3b2b81): push() probes GET
// /api/v0/tasks/batch first — the standalone-push tests below pin the
// legacy one-by-one RENDERING, so the probe answers 404 (old server) and
// every pinned byte below is unchanged. (Seeded-loop tests above call
// createTasksOneByOne directly and need no routing.)
import { withOldServerProbe } from "../helpers/old-server-probe.js";

const realStdoutTTY = process.stdout.isTTY;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  process.stdout.isTTY = realStdoutTTY;
});

function seedTasks(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    id: `task-${i + 1}`,
    title: `Task ${i + 1}`,
    status: "todo",
  }));
}

describe("bulk-push counter math on a seeded push", () => {
  it("reports 1/N … N/N and ends at final N/N when all tasks push", async () => {
    const seen: Array<[number, number]> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: "cloud-x" }),
      }),
    );

    const result = await createTasksOneByOne(
      "https://x.test",
      "tok",
      "b",
      seedTasks(5),
      (done, total) => seen.push([done, total]),
    );

    expect(result).toMatchObject({ imported: 5, skipped: 0 });
    // One render call per task, counting up exactly.
    expect(seen).toEqual([
      [1, 5],
      [2, 5],
      [3, 5],
      [4, 5],
      [5, 5],
    ]);
    const [done, total] = seen[seen.length - 1]!;
    expect(`Pushing ${done}/${total}`).toBe("Pushing 5/5");
  });

  it("still advances the counter past a mid-push failure and reports the failed count", async () => {
    const seen: Array<[number, number]> = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: "c1" }) })
      .mockResolvedValueOnce({ ok: false, status: 409 })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ id: "c3" }) });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createTasksOneByOne(
      "https://x.test",
      "tok",
      "b",
      seedTasks(3),
      (done, total) => seen.push([done, total]),
    );

    expect(result.imported).toBe(2);
    expect(result.skipped).toBe(1);
    // The failed task still counts as attempted: k/N keeps climbing.
    expect(seen).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
    const [done, total] = seen[seen.length - 1]!;
    expect(`Pushing ${done}/${total}`).toBe("Pushing 3/3");
  });

  it("emits no progress calls for an empty push", async () => {
    const seen: Array<[number, number]> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) }),
    );

    const result = await createTasksOneByOne("https://x.test", "tok", "b", [], (done, total) =>
      seen.push([done, total]),
    );

    expect(result).toMatchObject({ imported: 0, skipped: 0 });
    expect(seen).toEqual([]);
  });
});

describe("TTY bar vs piped counter-only", () => {
  it("renders the exact counter plus a visual bar and percent on a TTY", () => {
    process.stdout.isTTY = true;
    const line = formatTaskPushProgress(45, 1704);
    expect(line).toContain("Pushing 45/1704");
    expect(line).toContain("█");
    expect(line).toContain("%");
  });

  it("renders counter-only with no bar characters when piped", () => {
    process.stdout.isTTY = false;
    const line = formatTaskPushProgress(45, 1704);
    expect(line).toBe("Pushing 45/1704");
    expect(line).not.toContain("█");
    expect(line).not.toContain("░");
  });

  it("treats undefined isTTY (non-TTY spawn) as piped", () => {
    process.stdout.isTTY = undefined as unknown as boolean;
    expect(formatTaskPushProgress(2, 3)).toBe("Pushing 2/3");
  });
});

describe("progress goes to stderr, never stdout", () => {
  let stdoutWrite: ReturnType<typeof vi.spyOn>;
  let stderrWrite: ReturnType<typeof vi.spyOn>;
  let stderrText: string;

  beforeEach(() => {
    stderrText = "";
    stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(((chunk: unknown) => {
        stderrText += String(chunk);
        return true;
      }) as typeof process.stderr.write);
  });

  afterEach(() => {
    stdoutWrite.mockRestore();
    stderrWrite.mockRestore();
  });

  it("reportTaskPushProgress writes the counter to stderr and nothing to stdout (TTY)", () => {
    process.stdout.isTTY = true;
    reportTaskPushProgress(3, 10);
    expect(stderrText).toContain("Pushing 3/10");
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it("reportTaskPushProgress writes one counter line to stderr and nothing to stdout (piped)", () => {
    process.stdout.isTTY = false;
    reportTaskPushProgress(3, 10);
    expect(stderrText).toBe("  Pushing 3/10\n");
    expect(stdoutWrite).not.toHaveBeenCalled();
  });

  it("the standalone push command leaves stdout free of progress while stderr carries final N/N", async () => {
    process.stdout.isTTY = false;
    vi.mocked(tokenModule.readToken).mockResolvedValue("test-token");
    vi.mocked(workspaceModule.readWorkspace).mockResolvedValue({
      id: "ws-1",
      name: "My Board",
      url: "http://localhost:3000",
      icon: null,
      email: null,
    });
    vi.mocked(filesModule.listFiles).mockReturnValue([]);
    vi.stubGlobal(
      "fetch",
      withOldServerProbe(
        vi.fn().mockResolvedValue({
          ok: true,
          json: () => Promise.resolve({ id: "cloud-x" }),
        }),
      ),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const projectDir = mkdtempSync(join(tmpdir(), "push-progress-"));
    const taskDir = join(projectDir, ".vibeflow", "tasks", "2026-01-01");
    mkdirSync(taskDir, { recursive: true });
    for (let i = 1; i <= 3; i++) {
      writeFileSync(
        join(taskDir, `t${i}.json`),
        JSON.stringify({ id: `t${i}`, title: `T${i}`, status: "todo" }),
      );
    }

    await push(projectDir, { keepLocalFiles: true });
    logSpy.mockRestore();

    // Greppable exact final counter on stderr …
    expect(stderrText).toContain("Pushing 3/3");
    // … and no progress byte on stdout (the --json/piped contract:
    // stdout carries no "Pushing d/N" line ever).
    const stdoutText = stdoutWrite.mock.calls.map((c) => String(c[0])).join("");
    expect(stdoutText).not.toContain("Pushing");
  });
});
