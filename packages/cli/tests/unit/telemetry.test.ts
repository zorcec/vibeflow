import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We test the pure config-level helpers by overriding the config path via mocking the os module.
// The telemetry module uses os.homedir() to resolve ~/.vibeflow/config.json.

describe("telemetry module", () => {
  let tempDir: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "vf-telemetry-"));
    // Override HOME so telemetry reads/writes to a temp directory instead of ~/.vibeflow
    originalHome = process.env.HOME;
    process.env.HOME = tempDir;
    // Reset module cache so the re-imported module picks up the new HOME
    vi.resetModules();
    // Clear any env override from previous tests
    delete process.env.VIBEFLOW_TELEMETRY;
    // These tests model the production default-on config semantics.
    // isTelemetryEnabled() now refuses to enable under a test environment
    // (VITEST set / NODE_ENV=test) so no test file can leak to PostHog by
    // omission — so opt into the documented escape hatch for this file.
    // The guard itself is asserted by the regression test at the bottom.
    process.env.VIBEFLOW_TELEMETRY_ALLOW_IN_TESTS = "1";
  });

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
    delete process.env.VIBEFLOW_TELEMETRY;
    delete process.env.VIBEFLOW_TELEMETRY_ALLOW_IN_TESTS;
    rmSync(tempDir, { recursive: true, force: true });
    vi.resetModules();
  });

  it("is enabled by default (no config file, no env override)", async () => {
    const { isTelemetryEnabled } = await import("../../src/telemetry.js");
    expect(isTelemetryEnabled()).toBe(true);
  });

  it("is disabled when VIBEFLOW_TELEMETRY=0 env var is set", async () => {
    process.env.VIBEFLOW_TELEMETRY = "0";
    const { isTelemetryEnabled } = await import("../../src/telemetry.js");
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("can be disabled via setTelemetryEnabled(false)", async () => {
    const { isTelemetryEnabled, setTelemetryEnabled } = await import("../../src/telemetry.js");
    expect(isTelemetryEnabled()).toBe(true);
    setTelemetryEnabled(false);
    expect(isTelemetryEnabled()).toBe(false);
  });

  it("can be re-enabled after being disabled", async () => {
    const { isTelemetryEnabled, setTelemetryEnabled } = await import("../../src/telemetry.js");
    setTelemetryEnabled(false);
    expect(isTelemetryEnabled()).toBe(false);
    setTelemetryEnabled(true);
    expect(isTelemetryEnabled()).toBe(true);
  });

  it("getTelemetryStatus returns enabled status and anonymousId", async () => {
    const { getTelemetryStatus } = await import("../../src/telemetry.js");
    const status = getTelemetryStatus();
    expect(status.enabled).toBe(true);
    // No anonymousId yet (capture hasn't been called)
    expect(status.anonymousId).toBeNull();
  });

  it("getTelemetryStatus shows disabled when env var is set", async () => {
    process.env.VIBEFLOW_TELEMETRY = "0";
    const { getTelemetryStatus } = await import("../../src/telemetry.js");
    const status = getTelemetryStatus();
    expect(status.enabled).toBe(false);
  });

  it("VIBEFLOW_TELEMETRY=0 takes precedence over saved enabled config", async () => {
    const { setTelemetryEnabled } = await import("../../src/telemetry.js");
    setTelemetryEnabled(true);
    vi.resetModules();
    process.env.VIBEFLOW_TELEMETRY = "0";
    const { isTelemetryEnabled } = await import("../../src/telemetry.js");
    expect(isTelemetryEnabled()).toBe(false);
  });

  // Regression: the test suite leaked telemetry to the production PostHog
  // project — temp-HOME tests minted a fresh randomUUID() anonymous id per
  // run, fabricating hundreds of fake "users" (444 of 454 production users
  // came from one OS username fingerprint). The suite opts out via the
  // shared setup file AND this guard, so a test file that forgets the opt-out
  // still cannot emit.
  it("test-environment guard: telemetry cannot emit under vitest, even with no opt-out env", async () => {
    // Remove the escape hatch this file normally runs with — the guard must
    // fire on VITEST / NODE_ENV=test alone.
    delete process.env.VIBEFLOW_TELEMETRY_ALLOW_IN_TESTS;
    delete process.env.VIBEFLOW_TELEMETRY;
    // Premise check: this process really is a test process.
    expect(
      process.env.VITEST !== undefined || process.env.NODE_ENV === "test",
    ).toBe(true);

    const { isTelemetryEnabled, capture, flushTelemetry, getTelemetryStatus } =
      await import("../../src/telemetry.js");
    expect(isTelemetryEnabled()).toBe(false);

    capture("unit-test-must-not-emit");
    await flushTelemetry();

    const status = getTelemetryStatus();
    expect(status.enabled).toBe(false);
    expect(status.anonymousId).toBeNull();
    // No ~/.vibeflow/config.json written => no randomUUID() anonymous id was
    // minted => no new PostHog person could have been created.
    expect(existsSync(join(tempDir, ".vibeflow", "config.json"))).toBe(false);
  });
});
