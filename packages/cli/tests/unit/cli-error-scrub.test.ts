/**
 * CLI kanban error reporting (ticket 5087f5e3): scrub rules, telemetry-flag
 * gating, dedupe + session cap, and the process-handler seams.
 *
 * The real telemetry module is mocked at the `capture()` seam (telemetry is
 * disabled under vitest anyway); the flag itself stays REAL so the
 * enabled/disabled assertions below are honest. Enabled-path tests use the
 * documented escape hatch (VIBEFLOW_TELEMETRY_ALLOW_IN_TESTS=1) with a temp
 * HOME so no real config or network is touched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import os from "node:os";

/** Spy shared with the hoisted `vi.mock` factory below. */
const captureSpy = vi.hoisted(() => vi.fn());

vi.mock("../../src/telemetry.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/telemetry.js")>();
  return {
    ...actual,
    capture: captureSpy,
  };
});

import {
  scrubErrorText,
  reportCliError,
  resetCliErrorReportState,
  handleUnhandledRejection,
  handleUncaughtException,
  CLI_ERROR_EVENT,
} from "../../src/server/cli-error-report.js";

let tempHome = "";
let originalHome: string | undefined;

beforeEach(() => {
  captureSpy.mockClear();
  resetCliErrorReportState();
  originalHome = process.env.HOME;
  tempHome = mkdtempSync(join(tmpdir(), "vf-cli-err-"));
  process.env.HOME = tempHome;
  delete process.env.VIBEFLOW_TELEMETRY;
  delete process.env.VIBEFLOW_TELEMETRY_ALLOW_IN_TESTS;
});

afterEach(() => {
  if (originalHome !== undefined) process.env.HOME = originalHome;
  else delete process.env.HOME;
  delete process.env.VIBEFLOW_TELEMETRY;
  delete process.env.VIBEFLOW_TELEMETRY_ALLOW_IN_TESTS;
  rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** Telemetry ON for this process (vitest otherwise forces it off). */
function enableTelemetry(): void {
  delete process.env.VIBEFLOW_TELEMETRY;
  process.env.VIBEFLOW_TELEMETRY_ALLOW_IN_TESTS = "1";
}

/** A realistic board error: absolute path AND a task title in one message. */
function realisticError(): Error {
  const home = os.homedir();
  return new Error(
    `ENOENT: no such file '${home}/projects/acme-corp/.vibeflow/tasks/302e9cab6422a086e1c9c338c1f889.json' while loading task "Frontend cache (online product)" for user tom@example.com`,
  );
}

describe("scrubErrorText", () => {
  it("strips the absolute path, the task title AND the task id", () => {
    const out = scrubErrorText(realisticError());
    expect(out).not.toContain(os.homedir());
    expect(out).not.toContain("/projects/acme-corp/");
    expect(out).not.toContain("Frontend cache (online product)");
    expect(out).not.toContain("302e9cab6422a086e1c9c338c1f889");
    expect(out).not.toContain("tom@example.com");
    // …while keeping the actionable signal.
    expect(out).toContain("[id].json");
    expect(out).toMatch(/ENOENT/i);
  });

  it("keeps api-route-like runs and URLs readable", () => {
    const out = scrubErrorText("GET /api/tasks failed: https://example.com/a/b");
    expect(out).toContain("/api/tasks");
    expect(out).toContain("https://example.com/a/b");
  });

  it("replaces the home dir with ~ and redacts emails", () => {
    const out = scrubErrorText(
      `failed for ${os.homedir()}/x contact jane.doe@example.org`,
    );
    expect(out).not.toContain(os.homedir());
    expect(out).toContain("~");
    expect(out).toContain("[email]");
  });

  it("reduces windows paths to basenames", () => {
    const out = scrubErrorText(
      `Cannot read C:\\Users\\tom\\projects\\board\\tasks.json`,
    );
    expect(out).not.toContain("C:\\Users\\tom");
    expect(out).toContain("tasks.json");
  });

  it("keeps short quoted tokens but redacts long quoted spans", () => {
    expect(scrubErrorText(`Invalid status: \"todo\"`)).toContain(`\"todo\"`);
    expect(
      scrubErrorText(`Duplicate task \"Write the quarterly roadmap draft\"`),
    ).not.toContain("Write the quarterly roadmap draft");
  });

  it("truncates to the documented max and never returns empty", () => {
    expect(scrubErrorText("x".repeat(9999)).length).toBeLessThanOrEqual(300);
    expect(scrubErrorText("")).toBe("Unknown error");
    expect(scrubErrorText(undefined)).toBe("Unknown error");
  });
});

describe("reportCliError flag gating (the flag test)", () => {
  it("DISABLED: an error produces ZERO transport calls", () => {
    process.env.VIBEFLOW_TELEMETRY = "0";
    const reported = reportCliError(realisticError(), { source: "server" });
    expect(reported).toBe(false);
    expect(captureSpy).toHaveBeenCalledTimes(0);
  });

  it("ENABLED: an error produces exactly ONE event tagged environment=cli with a scrubbed message", () => {
    enableTelemetry();
    const reported = reportCliError(realisticError(), {
      source: "server",
      route: "/api/tasks",
      statusCode: 500,
    });
    expect(reported).toBe(true);
    expect(captureSpy).toHaveBeenCalledTimes(1);
    const [event, props] = captureSpy.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(event).toBe(CLI_ERROR_EVENT);
    expect(props.environment).toBe("cli");
    expect(props.source).toBe("server");
    expect(props.route).toBe("/api/tasks");
    const message = String(props.error_message);
    expect(message).not.toContain("Frontend cache (online product)");
    expect(message).not.toContain("/projects/acme-corp/");
    expect(message).not.toContain("tom@example.com");
    // The one real payload the test run produced (owner-visible):
    console.log(`[cli_error payload] ${JSON.stringify({ event, props })}`);
  });
});

describe("dedupe + session cap", () => {
  it("reports a repeated identical error only once per window", () => {
    enableTelemetry();
    const err = new Error("boom");
    expect(reportCliError(err, { source: "server" })).toBe(true);
    expect(reportCliError(new Error("boom"), { source: "server" })).toBe(false);
    expect(captureSpy).toHaveBeenCalledTimes(1);
  });

  it("caps at 20 reports per window, then drops", () => {
    enableTelemetry();
    let accepted = 0;
    for (let i = 0; i < 25; i++) {
      if (reportCliError(new Error(`distinct failure ${i}`), { source: "client" })) {
        accepted++;
      }
    }
    expect(accepted).toBe(20);
    expect(captureSpy).toHaveBeenCalledTimes(20);
  });
});

describe("process handlers", () => {
  it("unhandled rejection: ZERO calls when disabled, ONE when enabled", () => {
    process.env.VIBEFLOW_TELEMETRY = "0";
    handleUnhandledRejection(new Error("stray rejection"));
    expect(captureSpy).toHaveBeenCalledTimes(0);

    enableTelemetry();
    handleUnhandledRejection(new Error("stray rejection"));
    expect(captureSpy).toHaveBeenCalledTimes(1);
    expect(
      (captureSpy.mock.calls[0] as [string, Record<string, unknown>])[1],
    ).toMatchObject({ environment: "cli", source: "process", unhandled: true });
  });

  it("uncaught exception: reports once when enabled, always exits 1", async () => {
    const exits: number[] = [];
    const exit = (code: number): void => {
      exits.push(code);
    };
    process.env.VIBEFLOW_TELEMETRY = "0";
    handleUncaughtException(new Error("fatal"), exit);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(captureSpy).toHaveBeenCalledTimes(0);
    expect(exits).toEqual([1]);

    enableTelemetry();
    handleUncaughtException(new Error("fatal"), exit);
    await new Promise((r) => setTimeout(r, 0));
    expect(captureSpy).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([1, 1]);
  });
});
