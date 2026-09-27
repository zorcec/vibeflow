/**
 * W1 — project root resolution and validation (model1-mcp plan §W1).
 *
 * Two boundaries under test:
 *  1. `resolveProjectRoot` — the full rule (existing dir, not `/`, not `$HOME`,
 *     git repo or `.vibeflow/` store), run at the CLI boundary.
 *  2. The server-layer backstop — `serve()` itself must refuse `/` and `$HOME`
 *     even when called directly, bypassing the CLI. That is the case the
 *     boundary split could otherwise hide, so it is asserted here explicitly.
 *
 * No fixture is seeded to make a *programmatic* `serve()` call pass anything:
 * the full rule deliberately does not run in the server layer.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import {
  resolveProjectRoot,
  assertSafeProjectDir,
} from "../../src/core/project-root.js";
import { serve } from "../../src/server/server.js";

// The unit suite runs in worker threads: `process.chdir()` is unsupported
// there and `os.homedir()` does not observe `process.env.HOME` redirects
// (native getenv stays process-global). So both cwd and the home directory
// are injected through seams the worker CAN control: a spy on `process.cwd`
// and a module mock of `node:os` that honours a hoisted ref.
const homeRef = vi.hoisted(() => ({ value: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => homeRef.value || actual.homedir() };
});

const created: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** A directory that passes the full rule: a vibeflow store. */
function storeDir(prefix: string): string {
  const dir = tempDir(prefix);
  mkdirSync(join(dir, ".vibeflow"), { recursive: true });
  return dir;
}

afterEach(() => {
  homeRef.value = "";
  vi.restoreAllMocks();
  while (created.length) rmSync(created.pop()!, { recursive: true, force: true });
});

/** Asserts a refusal: right code, and every refusal names `--project`. */
function expectRefusal(
  result: ReturnType<typeof resolveProjectRoot>,
  code: string,
): void {
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.code).toBe(code);
    expect(`${result.message}\n${result.suggestion}`).toContain("--project");
  }
}

describe("resolveProjectRoot (CLI boundary, full rule)", () => {
  it("http mode defaults to absolute cwd", () => {
    // Seed the cwd: a bare default would (correctly) be refused, so an ok
    // result also proves the rule ran against the mocked cwd.
    const dir = storeDir("vf-root-cwd-");
    const spy = vi.spyOn(process, "cwd").mockReturnValue(dir);
    try {
      const result = resolveProjectRoot(undefined, { mode: "http" });
      expect(result.ok).toBe(true);
      if (result.ok) {
        // Absolute, never cwd-relative — a relative root leaking into the MCP
        // ctx is the regression this guards.
        expect(result.projectDir).toBe(resolve(dir));
        expect(isAbsolute(result.projectDir)).toBe(true);
        expect(result.projectDir).not.toBe(".");
      }
    } finally {
      spy.mockRestore();
    }
  });

  it("stdio mode with no --project refuses, naming the flag", () => {
    const result = resolveProjectRoot(undefined, { mode: "stdio" });
    expectRefusal(result, "PROJECT_ROOT_REQUIRED");
    if (!result.ok) {
      expect(result.suggestion).toContain(".mcp.json");
      expect(result.suggestion).toContain("--project");
    }
  });

  it("refuses the filesystem root", () => {
    expectRefusal(
      resolveProjectRoot("/", { mode: "http" }),
      "PROJECT_ROOT_IS_FILESYSTEM_ROOT",
    );
  });

  it("refuses the user's home directory", () => {
    // homeRef makes "home" a directory this test controls — hermetic, no
    // dependence on whatever the real $HOME is on the machine running it.
    const home = tempDir("vf-root-is-home-");
    homeRef.value = home;
    expectRefusal(
      resolveProjectRoot(home, { mode: "http" }),
      "PROJECT_ROOT_IS_HOME",
    );
  });

  it("refuses a dir that is neither a git repo nor a .vibeflow store", () => {
    expectRefusal(
      resolveProjectRoot(tempDir("vf-root-bare-"), { mode: "http" }),
      "PROJECT_ROOT_NOT_A_PROJECT",
    );
  });

  it("accepts a .vibeflow store", () => {
    const dir = storeDir("vf-root-store-");
    const result = resolveProjectRoot(dir, { mode: "http" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.projectDir).toBe(resolve(dir));
      expect(result.name).toBe(basename(dir));
    }
  });

  it("accepts a git repo", () => {
    const dir = tempDir("vf-root-git-");
    mkdirSync(join(dir, ".git"));
    const result = resolveProjectRoot(dir, { mode: "http" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.projectDir).toBe(resolve(dir));
  });

  it("resolves a relative --project against cwd", () => {
    const dir = storeDir("vf-root-rel-");
    const raw = relative(process.cwd(), dir);
    expect(isAbsolute(raw)).toBe(false); // genuinely relative input
    const result = resolveProjectRoot(raw, { mode: "http" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.projectDir).toBe(resolve(dir));
  });
});

describe("server-layer backstop — serve() called directly, bypassing the CLI", () => {
  it("refuses the filesystem root before creating anything", async () => {
    const existedBefore = existsSync("/.vibeflow");
    await expect(
      serve(undefined, { port: 3997, open: false, projectDir: "/" }),
    ).rejects.toThrow(/filesystem root/);
    // ensureTaskDirs would have created this — it must not exist newly.
    expect(existsSync("/.vibeflow")).toBe(existedBefore);
  });

  it("refuses the user's home directory before creating anything", async () => {
    // homeRef redirects "home" to a directory this test fully controls, so
    // "creates nothing" is asserted without touching the real $HOME.
    const fakeHome = tempDir("vf-root-home-");
    homeRef.value = fakeHome;
    await expect(
      serve(undefined, { port: 3998, open: false, projectDir: fakeHome }),
    ).rejects.toThrow(/home directory/);
    expect(existsSync(join(fakeHome, ".vibeflow"))).toBe(false);
    expect(readdirSync(fakeHome)).toEqual([]);
  });

  it("allows a bare temp dir — the full rule lives at the CLI boundary", () => {
    expect(() => assertSafeProjectDir(tempDir("vf-root-ok-"))).not.toThrow();
  });
});
