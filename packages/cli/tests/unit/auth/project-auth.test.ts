import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveProjectAuth } from "../../../src/auth/project-auth.js";
import { writeCredential } from "../../../src/auth/credentials.js";
import { writeProjectPointer } from "../../../src/auth/project-pointer.js";
import { getApiUrl } from "../../../src/core/api-url.js";

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

/**
 * Multi-board topology: the project pointer picks the board; the stored
 * credential only proves account identity (ADR-0005).
 *
 * The credential store is keyed by apiUrl (ONE entry per host), so two
 * linked projects on two boards of one account share a single credential
 * whose `workspaceId` can name only one of the boards. A `workspaceId`
 * that differs from a project's pointer must NOT unlink that project:
 * the token is account-scoped and valid for both boards.
 */
describe("pointer governs the board; credential proves identity", () => {
  const BOARD_A = "o9qu6m9yr2e6ubpriyhxbfak";
  const BOARD_B = "cj1gtxfec8chwwno2zilj45n";
  const TOKEN = "vbf_pat_multiboard_test_token_abc123";

  let home: string;
  let projectA: string;
  let projectB: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "vibeflow-multi-home-"));
    projectA = await fs.mkdtemp(path.join(os.tmpdir(), "vibeflow-multi-a-"));
    projectB = await fs.mkdtemp(path.join(os.tmpdir(), "vibeflow-multi-b-"));
    vi.spyOn(os, "homedir").mockReturnValue(home);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(projectA, { recursive: true, force: true });
    await fs.rm(projectB, { recursive: true, force: true });
  });

  /** One credential (naming BOARD_B) + two pointers on two boards. */
  async function seedTwoProjects(): Promise<string> {
    const apiUrl = getApiUrl();
    await writeCredential(apiUrl, {
      token: TOKEN,
      workspaceId: BOARD_B,
      account: "owner@example.com",
    });
    writeProjectPointer(projectA, { apiUrl, id: BOARD_A });
    writeProjectPointer(projectB, { apiUrl, id: BOARD_B });
    return apiUrl;
  }

  it("a credential naming another board still resolves saas on the pointer's board", async () => {
    await seedTwoProjects();
    const auth = await resolveProjectAuth(projectA);
    expect(auth.mode).toBe("saas");
    expect(auth.unlinked).toBe(false);
    expect(auth.token).toBe(TOKEN);
    expect(auth.workspaceId).toBe(BOARD_A);
    expect(auth.notice).toBeNull();
  });

  it("two projects sharing one credential store each resolve saas on their own board", async () => {
    await seedTwoProjects();
    const [a, b] = await Promise.all([
      resolveProjectAuth(projectA),
      resolveProjectAuth(projectB),
    ]);
    expect(a.mode).toBe("saas");
    expect(a.unlinked).toBe(false);
    expect(a.token).toBe(TOKEN);
    expect(a.workspaceId).toBe(BOARD_A);
    expect(b.mode).toBe("saas");
    expect(b.unlinked).toBe(false);
    expect(b.token).toBe(TOKEN);
    expect(b.workspaceId).toBe(BOARD_B);
  });

  it("a credential with no stored board still resolves saas on the pointer's board", async () => {
    const apiUrl = getApiUrl();
    await writeCredential(apiUrl, { token: TOKEN });
    writeProjectPointer(projectA, { apiUrl, id: BOARD_A });
    const auth = await resolveProjectAuth(projectA);
    expect(auth.mode).toBe("saas");
    expect(auth.unlinked).toBe(false);
    expect(auth.token).toBe(TOKEN);
    expect(auth.workspaceId).toBe(BOARD_A);
    expect(auth.notice).toBeNull();
  });
});
