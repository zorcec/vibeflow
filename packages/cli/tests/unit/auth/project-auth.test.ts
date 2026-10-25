import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * RED PROOF (ticket a93bfdc8): a machine-global credential must never flip
 * a project that declares nothing into online mode.
 *
 * Setup: temp HOME holding a legacy global `~/.vibeflow/token`, plus a
 * temp project dir with NO `.vibeflow/settings.json` pointer. Expected:
 * `getMode(projectDir)` is `"local"`. Today's `getMode()` takes no project
 * and reads only the global token, so this FAILS (returns "saas") until
 * the project-scoped resolution lands.
 */
describe("red proof: global credential must not hijack a pointer-less project", () => {
  let home: string;
  let projectDir: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "vibeflow-red-home-"));
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "vibeflow-red-proj-"));
    vi.spyOn(os, "homedir").mockReturnValue(home);
    vi.resetModules();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  it("project with no pointer reads local despite a global credential", async () => {
    await fs.mkdir(path.join(home, ".vibeflow"), { recursive: true });
    await fs.writeFile(path.join(home, ".vibeflow", "token"), "global-token", {
      mode: 0o600,
    });
    const { getMode } = await import("../../../src/auth/mode.js");
    expect(await getMode(projectDir)).toBe("local");
  });
});
