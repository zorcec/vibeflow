import { describe, expect, it, vi, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendFlakeLog,
  createFlakyReporter,
  isFlakySpec,
  summarizeGate,
} from "../helpers/flaky-bucket.js";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.FLAKE_LOG;
});

const WORKERS = 4;

// Flaky tests: report, quarantine, fix in the same session (child f3b5058e).
// A @flaky spec still RUNS — its failure lands in a separate bucket that does
// not fail the gate, while a genuine red in the same run still does.
describe("flaky bucket", () => {
  it("detects the @flaky marker in spec source", () => {
    expect(isFlakySpec("// @flaky: port race on CI\nit('binds', () => {})")).toBe(
      true,
    );
    expect(isFlakySpec("it('binds', () => {})")).toBe(false);
  });

  it("a failing @flaky spec lands in the flaky bucket and does NOT fail the gate", () => {
    const result = summarizeGate(
      [
        { file: "tests/e2e/bind.test.ts", name: "binds a port", failed: true, flaky: true },
      ],
      WORKERS,
    );
    expect(result.flaky).toHaveLength(1);
    expect(result.failed).toHaveLength(0);
    expect(result.pass).toBe(true);
  });

  it("a non-flaky failure in the same run STILL fails the gate", () => {
    const result = summarizeGate(
      [
        { file: "tests/e2e/bind.test.ts", name: "binds a port", failed: true, flaky: true },
        { file: "tests/e2e/auth.test.ts", name: "rejects bad token", failed: true, flaky: false },
      ],
      WORKERS,
    );
    expect(result.flaky).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.pass).toBe(false);
  });

  it("the reporter prints FLAKY and appends the log for a failing @flaky spec", () => {
    const dir = mkdtempSync(join(tmpdir(), "flakes-"));
    try {
      process.env.FLAKE_LOG = join(dir, "flakes.log");
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const reporter = createFlakyReporter(() => "// @flaky: port race\nit('binds', () => {})");
      reporter.onFinished([
        {
          filepath: "tests/e2e/bind.test.ts",
          tasks: [{ name: "binds", result: { state: "fail" } }],
        },
      ]);
      const lines = log.mock.calls.map((c) => String(c[0]));
      expect(lines.some((l) => l.startsWith("FLAKY (not failing the gate):"))).toBe(true);
      const logged = readFileSync(process.env.FLAKE_LOG, "utf8").trim().split("\n");
      expect(logged).toHaveLength(1);
      expect((JSON.parse(logged[0]) as { path: string }).path).toBe("tests/e2e/bind.test.ts");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("appends a machine-readable flake line (path + spec + workers + timestamp)", () => {
    const lines: string[] = [];
    appendFlakeLog(
      { file: "tests/e2e/bind.test.ts", name: "binds a port" },
      WORKERS,
      (line) => lines.push(line),
    );
    expect(lines).toHaveLength(1);
    const entry = JSON.parse(lines[0]) as Record<string, unknown>;
    expect(entry.path).toBe("tests/e2e/bind.test.ts");
    expect(entry.spec).toBe("binds a port");
    expect(entry.workers).toBe(WORKERS);
    expect(typeof entry.timestamp).toBe("string");
  });
});
