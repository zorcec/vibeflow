import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CLI = join(process.cwd(), "dist", "index.js");
const run = (args: string) => {
  try {
    return {
      stdout: execSync(`node ${CLI} ${args}`, { encoding: "utf-8" }),
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
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns unknown command for validate", () => {
    const { stdout, exitCode } = run("validate .");
    expect(stdout.toLowerCase()).toContain("unknown command");
    expect(exitCode).toBe(1);
  });
});
