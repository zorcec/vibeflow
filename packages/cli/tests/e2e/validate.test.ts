import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runCliIsolatedSync } from "./spawn-isolated.js";

// Isolated HOME (ticket 8ac96ef9): every CLI spawn runs with a temp HOME so
// the child can never read or write the operator's real ~/.vibeflow.
let cliHome!: string;

const run = (args: string) => {
  try {
    return {
      stdout: runCliIsolatedSync(args.split(" "), {
        cwd: process.cwd(),
        home: cliHome,
      }),
      exitCode: 0,
    };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: `${e.stdout ?? ""}${e.stderr ?? ""}`,
      exitCode: e.status ?? 1,
    };
  }
};

describe("removed validate command (e2e)", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "proto-e2e-validate-"));
    cliHome = mkdtempSync(join(tmpdir(), "proto-e2e-validate-home-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
    rmSync(cliHome, { recursive: true, force: true });
  });

  it("returns unknown command for validate", () => {
    const { stdout, exitCode } = run("validate .");
    expect(stdout.toLowerCase()).toContain("unknown command");
    expect(exitCode).toBe(1);
  });
});
