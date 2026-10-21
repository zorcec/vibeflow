/**
 * Every telemetry event must say WHICH build produced it.
 *
 * Without `cli_version` the dashboard could show that events happen but not
 * that a fix shipped in 0.21.2 was reaching anyone — version adoption was
 * simply unmeasurable. `os` (platform-arch) answers "which runtime" without
 * widening the privacy surface: no hostname, path or username.
 *
 * posthog-node is mocked so this file cannot emit real events.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const captured: Array<Record<string, unknown>> = [];

vi.mock("posthog-node", () => ({
  PostHog: class {
    capture(payload: Record<string, unknown>) {
      captured.push(payload);
    }
    async shutdown() {
      return undefined;
    }
  },
}));

const { CLI_VERSION } = await import("../../src/version.js");
const { capture } = await import("../../src/telemetry.js");

describe("telemetry event properties", () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    captured.length = 0;
    tempDir = mkdtempSync(join(tmpdir(), "vf-tel-props-"));
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
    delete process.env.VIBEFLOW_TELEMETRY;
    process.env.VIBEFLOW_TELEMETRY_ALLOW_IN_TESTS = "1";
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    delete process.env.VIBEFLOW_TELEMETRY_ALLOW_IN_TESTS;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("attaches cli_version and os to command_run", () => {
    capture("command_run", { surface: "cli", command: "tasks" });

    expect(captured).toHaveLength(1);
    const props = captured[0]!.properties as Record<string, unknown>;
    expect(props.command).toBe("tasks");
    expect(props.cli_version).toBe(CLI_VERSION);
    expect(props.os).toBe(`${process.platform}-${process.arch}`);
    expect(props.node_version).toBe(process.versions.node);
  });

  it("keeps cli_version on every event, not just command_run", () => {
    capture("cli_error", { code: "X" });
    const props = captured[0]!.properties as Record<string, unknown>;
    expect(props.cli_version).toBe(CLI_VERSION);
  });

  it("never sends the raw username, only its hash", () => {
    capture("command_run", { command: "tasks" });
    const props = captured[0]!.properties as Record<string, unknown>;
    const userId = String(props.$user_id);
    expect(userId).toMatch(/^[0-9a-f]{16}$/);
    expect(JSON.stringify(props)).not.toContain(require("node:os").userInfo().username);
  });

  it("does not leak a hostname or home path through os", () => {
    capture("command_run", { command: "tasks" });
    const props = captured[0]!.properties as Record<string, unknown>;
    const osValue = String(props.os);
    expect(osValue).not.toContain("/");
    expect(osValue).not.toContain(require("node:os").hostname());
  });
});
