import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Retired machine-global token (ADR-0005): `~/.vibeflow/token` is NO
 * LONGER READ — mode resolves per project from the repo pointer plus the
 * user-scoped credential store. This suite pins the retirement:
 * - the legacy path helper keeps its shape (the resolver still notices
 *   a leftover file to print the one-line "ignored" notice);
 * - `legacyTokenPresent` reports presence without ever treating the file
 *   as a credential;
 * - a global token is NOT used: a project with no pointer resolves
 *   local even when the legacy file exists (red proof lives in
 *   project-auth.test.ts; this is the token-side pin).
 */
import {
  getLegacyTokenPath,
  legacyTokenPresent,
} from "../../../src/auth/token.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("getLegacyTokenPath", () => {
  it("returns a path ending in .vibeflow/token", () => {
    expect(getLegacyTokenPath()).toMatch(/\.vibeflow[\/\\]token$/);
  });

  it("follows the active home directory", () => {
    vi.spyOn(os, "homedir").mockReturnValue("/fake-home");
    expect(getLegacyTokenPath()).toBe(
      path.join("/fake-home", ".vibeflow", "token"),
    );
  });
});

describe("legacyTokenPresent", () => {
  it("returns false when no legacy file exists", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vibeflow-legacy-"));
    try {
      vi.spyOn(os, "homedir").mockReturnValue(home);
      expect(await legacyTokenPresent()).toBe(false);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });

  it("returns true when a leftover global token file exists", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vibeflow-legacy-"));
    try {
      await fs.mkdir(path.join(home, ".vibeflow"), { recursive: true });
      await fs.writeFile(path.join(home, ".vibeflow", "token"), "tok", {
        mode: 0o600,
      });
      vi.spyOn(os, "homedir").mockReturnValue(home);
      expect(await legacyTokenPresent()).toBe(true);
    } finally {
      await fs.rm(home, { recursive: true, force: true });
    }
  });
});

describe("a global token is not used", () => {
  it("project with no pointer resolves local despite a legacy global token", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "vibeflow-legacy-"));
    const projectDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "vibeflow-legacy-proj-"),
    );
    try {
      await fs.mkdir(path.join(home, ".vibeflow"), { recursive: true });
      await fs.writeFile(
        path.join(home, ".vibeflow", "token"),
        "global-token",
        { mode: 0o600 },
      );
      vi.spyOn(os, "homedir").mockReturnValue(home);
      vi.spyOn(console, "log").mockImplementation(() => {});
      const { resolveProjectAuth } = await import(
        "../../../src/auth/project-auth.js"
      );
      const auth = await resolveProjectAuth(projectDir);
      expect(auth.mode).toBe("local");
      expect(auth.token).toBeNull();
    } finally {
      await fs.rm(home, { recursive: true, force: true });
      await fs.rm(projectDir, { recursive: true, force: true });
    }
  });
});
