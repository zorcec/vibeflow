/**
 * Minimal push output with ETA (ticket e4049164).
 *
 * Owner verdict on 7db36f78/dec52322: too chatty — piped mode emitted one
 * line PER TASK (1704 lines for the owner's push) and the summary block ran
 * long. This file pins the tightening:
 * - TTY: ONE `\r`-rewritten line — counter + bar + pct + ETA (ETA from
 *   start-time × completed-rate, `--:--` until measurable, never NaN).
 * - Piped: SPARSE lines only (one per 10% bucket, or one per 10s on slow
 *   pushes, plus ALWAYS the final N/N) — never per-task lines.
 * - Final summary keeps every TRUE dec52322 number, tighter (merged lines).
 * - --verbose/--json detail paths are byte-identical (pinned elsewhere).
 *
 * Non-vacuity reds (each fails on the pre-e4049164 rendering):
 * - red-1: a 100-task piped push emits ~11 lines, not 100 (old code wrote
 *   one line per task via reportTaskPushProgress).
 * - red-2: the TTY line carries an ETA suffix (old TTY line had none).
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
  createTaskPushProgressReporter,
  formatPushEta,
  formatTaskPushProgress,
} from "../../../src/auth/login.js";
import * as tokenModule from "../../../src/auth/token.js";
import * as workspaceModule from "../../../src/auth/workspace.js";
import * as filesModule from "../../../src/core/files.js";
import { push } from "../../../src/commands/push.js";
// Deliberate update (ticket 8d3b2b81): push() probes GET
// /api/v0/tasks/batch first — this 402-refusal rendering test pins the
// legacy one-by-one summary, so the probe answers 404 (old server) and
// every pinned byte below is unchanged.
import { withOldServerProbe } from "../helpers/old-server-probe.js";

const realStdoutTTY = process.stdout.isTTY;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  process.stdout.isTTY = realStdoutTTY;
});

describe("formatPushEta is arithmetic-only and never garbage", () => {
  it("reads --:-- until measurable: zero elapsed, nothing done, or no total", () => {
    expect(formatPushEta(1000, 5, 100, 1000)).toBe("--:--");
    expect(formatPushEta(1000, 0, 100, 5000)).toBe("--:--");
    expect(formatPushEta(1000, 0, 0, 5000)).toBe("--:--");
    expect(formatPushEta(2000, 5, 100, 1000)).toBe("--:--");
  });

  it("estimates remaining/rate: 50 done in 1s of 100 → ~1s left", () => {
    expect(formatPushEta(0, 50, 100, 1000)).toBe("1s");
  });

  it("renders minutes for long pushes and 0s at completion, never NaN", () => {
    // 1 done in 1s of 126 → 125s left → 2m05s.
    expect(formatPushEta(0, 1, 126, 1000)).toBe("2m05s");
    expect(formatPushEta(0, 100, 100, 5000)).toBe("0s");
    for (const eta of [
      formatPushEta(0, 1, 2, 0),
      formatPushEta(0, 0, 0, 0),
      formatPushEta(Number.NaN, 1, 2, 3),
    ]) {
      expect(eta).not.toContain("NaN");
    }
  });
});

describe("TTY line carries counter + bar + pct + ETA on ONE line", () => {
  it("appends the ETA suffix (red-2: old TTY line had counter+bar+pct only)", () => {
    process.stdout.isTTY = true;
    const line = formatTaskPushProgress(50, 100, 0, 1000);
    expect(line).toContain("Pushing 50/100");
    expect(line).toContain("50%");
    expect(line).toContain("ETA 1s");
    expect(line).not.toContain("\n");
  });

  it("reads ETA --:-- when no start timestamp travels (zero elapsed)", () => {
    process.stdout.isTTY = true;
    expect(formatTaskPushProgress(45, 1704)).toContain("ETA --:--");
  });

  it("rewrites ONE \\r line per update and terminates it at N/N", () => {
    process.stdout.isTTY = true;
    const writes: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);
    const report = createTaskPushProgressReporter(3, { startMs: 0, now: () => 1000 });
    report(1, 3);
    report(2, 3);
    report(3, 3);
    // Every update rewrites the same single line; only the final one ends it.
    expect(writes.filter((w) => w.startsWith("\r"))).toHaveLength(3);
    expect(writes[writes.length - 1]).toBe("\n");
    expect(writes.join("")).toContain("Pushing 3/3");
    expect(writes.join("")).toContain("ETA");
  });
});

describe("piped output is sparse, never per-task", () => {
  let stderrText: string;

  beforeEach(() => {
    process.stdout.isTTY = false;
    stderrText = "";
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderrText += String(chunk);
      return true;
    }) as typeof process.stderr.write);
  });

  it("emits ~11 lines for a 100-task push, ending at exact N/N (red-1)", () => {
    let at = 0;
    const report = createTaskPushProgressReporter(100, {
      startMs: 0,
      now: () => at,
    });
    for (let done = 1; done <= 100; done++) {
      at += 10; // 10ms/task: well under the 10s slow-push interval.
      report(done, 100);
    }
    const lines = stderrText.trim().split("\n");
    // Old rendering wrote exactly 100 lines; sparse rule caps at ~11.
    expect(lines.length).toBeLessThan(20);
    expect(lines.length).toBeLessThan(100);
    expect(lines[lines.length - 1]).toContain("Pushing 100/100");
  });

  it("always emits the final line even inside one bucket", () => {
    let at = 0;
    const report = createTaskPushProgressReporter(100, {
      startMs: 0,
      now: () => at,
    });
    report(50, 100);
    const afterFirst = stderrText;
    expect(afterFirst).toContain("Pushing 50/100");
    report(51, 100); // Same 10% bucket, no 10s elapsed → suppressed.
    expect(stderrText).toBe(afterFirst);
    report(100, 100); // Final always emits.
    expect(stderrText).toContain("Pushing 100/100");
  });

  it("emits on the slow-push interval even without a bucket advance", () => {
    let at = 0;
    const report = createTaskPushProgressReporter(100, {
      startMs: 0,
      now: () => at,
    });
    report(50, 100);
    const afterFirst = stderrText;
    at += 10_001; // Slow push: 10s pass with no progress.
    report(50, 100);
    expect(stderrText.length).toBeGreaterThan(afterFirst.length);
  });

  it("piped lines stay counter-only on stderr, stdout untouched", () => {
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const report = createTaskPushProgressReporter(100, { startMs: 0, now: () => 0 });
    report(10, 100);
    expect(stderrText).toContain("Pushing 10/100");
    expect(stdoutWrite).not.toHaveBeenCalled();
    stdoutWrite.mockRestore();
  });
});

describe("condensed final summary keeps every TRUE number", () => {
  it("merges the refusal groups into the pushed line and the stop into one red line", async () => {
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
          ok: false,
          status: 402,
          json: () => Promise.resolve({ code: "TASK_LIMIT" }),
        }),
      ),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const projectDir = mkdtempSync(join(tmpdir(), "push-minimal-"));
    const taskDir = join(projectDir, ".vibeflow", "tasks", "2026-01-01");
    mkdirSync(taskDir, { recursive: true });
    for (const n of [1, 2]) {
      writeFileSync(
        join(taskDir, `t${n}.json`),
        JSON.stringify({ id: `t${n}`, title: `T${n}`, status: "todo" }),
      );
    }

    await push(projectDir, { keepLocalFiles: true });

    const lines = logSpy.mock.calls.map((c) => String(c[0]));
    // The pushed line carries the TRUE refusal groups on the SAME line …
    const pushed = lines.filter((l) => l.includes("Pushed 0 task(s) online"));
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toContain("0 created, 1 refused: 402 TASK_LIMIT ×1");
    // … and the stop line shares ONE red line with the not-attempted count.
    const stop = lines.filter((l) => l.includes("402") && l.includes("not attempted"));
    expect(stop).toHaveLength(1);
    expect(stop[0]).toContain("1 task(s) not attempted");
    logSpy.mockRestore();
  });
});
