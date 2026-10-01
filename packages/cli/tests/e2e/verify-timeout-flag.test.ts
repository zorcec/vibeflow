/**
 * `vibeflow verify --timeout <ms>` — validation path.
 *
 * `--timeout` was added to close the last MCP-only field (`verify_task.timeoutMs`)
 * and the CLI deliberately mirrors the MCP field's rule rather than inventing a
 * second one: same unit (milliseconds), same range (1000–300000), same default
 * (60000). These tests pin that contract on the CLI side.
 *
 * The important property is ORDER: a bad value is refused before the task id is
 * resolved and before any Playwright work begins. That is why this file can
 * assert the refusal with a non-existent task id and no browser — if the guard
 * ever moved after resolution, these tests would start failing slowly instead
 * of passing fast, which is the signal you want.
 *
 * `parseVerifyTimeout` is module-private in src/index.ts, so this drives the real
 * CLI the way the other refusal tests do (see tasks-json-refusals.test.ts).
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnCli } from "./mcp-helpers.js";

const cleanups: Array<() => void> = [];

function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * A refusal under `--json`: non-zero exit, EMPTY stdout, and one JSON envelope
 * on stderr carrying the assigned code. Mirrors expectRefusal in
 * tasks-json-refusals.test.ts — same contract, kept local so this file does not
 * depend on that suite's internal helpers.
 */
function expectRefusal(
  r: { stdout: string; stderr: string; code: number | null },
  code: string,
): {
  ok: boolean;
  error: { code: string; message: string; suggestion?: string };
} {
  expect(r.code).not.toBe(0);
  expect(r.stdout.trim()).toBe("");
  const envelope = JSON.parse(r.stderr) as {
    ok: boolean;
    error: { code: string; message: string; suggestion?: string };
  };
  expect(envelope.ok).toBe(false);
  expect(envelope.error.code).toBe(code);
  return envelope;
}

/** Run `verify <bogus-id> --timeout <value> --json` and return the refusal. */
async function verifyWithTimeout(value: string) {
  const cwd = freshDir("verify-timeout-store-");
  const home = freshDir("verify-timeout-home-");
  return spawnCli(["verify", "00000000", "--timeout", value, "--json"], {
    cwd,
    home,
  });
}

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
});

describe("verify --timeout mirrors the MCP timeoutMs contract", () => {
  it("refuses a non-numeric value with E_USAGE", async () => {
    const envelope = expectRefusal(await verifyWithTimeout("abc"), "E_USAGE");
    expect(envelope.error.message).toContain("--timeout");
  });

  it("refuses a fractional value — milliseconds must be whole", async () => {
    const envelope = expectRefusal(
      await verifyWithTimeout("300000.5"),
      "E_USAGE",
    );
    expect(envelope.error.message).toContain("300000.5");
  });

  it("refuses a value below the MCP minimum (1000)", async () => {
    const envelope = expectRefusal(await verifyWithTimeout("500"), "E_USAGE");
    expect(envelope.error.message).toContain("500");
    // The suggestion must state the range, so a caller can fix it without
    // reading the source.
    expect(envelope.error.suggestion).toContain("1000");
    expect(envelope.error.suggestion).toContain("300000");
  });

  it("refuses a value above the MCP maximum (300000)", async () => {
    const envelope = expectRefusal(
      await verifyWithTimeout("600000"),
      "E_USAGE",
    );
    expect(envelope.error.suggestion).toContain("300000");
  });

  it("refuses a negative value", async () => {
    expectRefusal(await verifyWithTimeout("-1"), "E_USAGE");
  });

  it("refuses an empty value", async () => {
    expectRefusal(await verifyWithTimeout(""), "E_USAGE");
  });

  it("accepts both boundaries, then fails on the TASK, not the flag", async () => {
    // 1000 and 300000 are the inclusive ends of the MCP range. They must NOT
    // be refused as bad flags — the CLI must accept exactly what MCP accepts.
    // They still fail here, because the task id is a placeholder, so this
    // asserts the refusal code is about the TASK and never E_USAGE. That is the
    // precise claim: the flag passed validation.
    for (const boundary of ["1000", "300000"]) {
      const cwd = freshDir("verify-timeout-ok-");
      const home = freshDir("verify-timeout-ok-home-");
      const r = await spawnCli(
        ["verify", "00000000", "--timeout", boundary, "--json"],
        { cwd, home },
      );
      expect(
        r.code,
        `--timeout ${boundary} must pass flag validation`,
      ).not.toBe(0);
      const text = `${r.stderr}${r.stdout}`;
      expect(
        text,
        `--timeout ${boundary} must not be refused as an invalid flag`,
      ).not.toContain('"code":"E_USAGE"');
    }
  });

  it("a bad flag is refused before the task id is resolved", async () => {
    // Ordering guarantee: a nonsense task id AND a bad timeout together must
    // produce the FLAG refusal. If resolution ever ran first, this would report
    // the task error instead and the guard would be useless for real callers.
    const cwd = freshDir("verify-timeout-order-");
    const home = freshDir("verify-timeout-order-home-");
    const r = await spawnCli(
      ["verify", "00000000", "--timeout", "5", "--json"],
      { cwd, home },
    );
    const envelope = expectRefusal(r, "E_USAGE");
    expect(envelope.error.message).toContain("--timeout");
    expect(envelope.error.message).not.toContain("00000000");
  });
});