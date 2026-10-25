/**
 * CLI bundle bootsmoke — release-blocker regression guard.
 *
 * The built `vibeflow` CLI once shipped dead: the build
 * (`node scripts/build-atomic.mjs`) succeeded while EVERY invocation of the
 * artifact crashed at startup with
 *   `Error: Dynamic require of "crypto" is not supported`
 * because esbuild emitted a CJS-interop `__require` shim for a node builtin
 * in the ESM output. tsc and the source-importing unit suite were both green —
 * only running the built binary showed it.
 *
 * These tests spawn the BUILT output, so a green build can never again hide a
 * dead artifact. Build first:
 *   pnpm --filter @vibeflow-tools/cli run build
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CLI_ENTRY, isolatedCliEnv } from "./spawn-isolated.js";

// Isolated HOME (ticket 8ac96ef9): even `--version` merges the
// owner-global ~/.vibeflow/settings.json, so the child gets a temp HOME.
let home!: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "cli-bundle-boots-home-"));
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

function runCli(args: string[]): { stdout: string; stderr: string } {
  let stdout = "";
  let stderr = "";
  try {
    stdout = execFileSync(process.execPath, [CLI_ENTRY, ...args], {
      encoding: "utf-8",
      timeout: 60_000,
      cwd: tmpdir(),
      env: isolatedCliEnv({ home, cwd: tmpdir() }),
    });
  } catch (err) {
    const e = err as {
      stdout?: string;
      stderr?: string;
      message?: string;
      status?: number;
    };
    throw new Error(
      `built CLI failed for args [${args.join(" ")}] (status ${e.status}):\n` +
        `--- stdout ---\n${e.stdout ?? ""}\n--- stderr ---\n${e.stderr ?? ""}\n--- error ---\n${e.message ?? String(err)}`,
    );
  }
  return { stdout, stderr };
}

describe("CLI bundle boots (dist)", () => {
  it("the built entry exists (build the CLI first)", () => {
    expect(
      existsSync(CLI_ENTRY),
      `missing ${CLI_ENTRY} — run: pnpm --filter @vibeflow-tools/cli run build`,
    ).toBe(true);
  });

  it("--version exits 0 and prints a version (no Dynamic-require throw)", () => {
    const { stdout, stderr } = runCli(["--version"]);
    expect(stderr).not.toContain("Dynamic require of");
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("pull --help exits 0 and shows the pull flags", () => {
    const { stdout, stderr } = runCli(["pull", "--help"]);
    expect(stderr).not.toContain("Dynamic require of");
    expect(stdout).toContain("--board");
    expect(stdout).toContain("--dry-run");
  });

  it("push --help exits 0 and shows the push flags", () => {
    const { stdout, stderr } = runCli(["push", "--help"]);
    expect(stderr).not.toContain("Dynamic require of");
    expect(stdout).toContain("--board");
    expect(stdout).toContain("--dry-run");
  });
});
