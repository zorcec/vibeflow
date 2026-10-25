/**
 * Isolation proof (ticket 8ac96ef9): the spawned CLI never sees the
 * operator's real HOME.
 *
 * Threat model: the CLI resolves its token, workspace, machine id, and
 * global settings from `os.homedir()/.vibeflow` at load time, and
 * `getMode()` is `token present ? "saas" : "local"`. A child spawned without
 * an explicit HOME inherits the operator's real one — the same class that
 * once destroyed the operator's auth token. These tests poison the parent
 * env (fake token in a fake HOME, bogus GIT_*, junk redirects) and assert
 * the child behaves as if none of it existed.
 *
 * Non-vacuity (proven during development, fixtures reverted):
 * - Poison spawn: temporarily making `isolatedCliEnv` inherit `HOME` turns
 *   the child SaaS (it sees the fake token) and the `--json` listing goes
 *   red — connection refused / auth error instead of the local task list.
 * - Env assertions: temporarily dropping any strip from `isolatedCliEnv`
 *   turns the matching assertion red.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnCliIsolated, isolatedCliEnv } from "./spawn-isolated.js";
import { seedTask } from "./mcp-helpers.js";

const DIRS: string[] = [];
function freshDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  DIRS.push(dir);
  return dir;
}

/** Recursive file inventory, repo-root-relative style (absolute here). */
function inventory(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    try {
      const stat = readdirSync(full);
      out.push(...inventory(full).map(String));
      void stat;
    } catch {
      out.push(full);
    }
  }
  return out.sort();
}

/** Parent keys this file poisons; saved and restored around each test. */
const POISON_KEYS = [
  "HOME",
  "VIBEFLOW_API_URL",
  "VIBEFLOW_PROJECT_DIR",
  "VIBEFLOW_TELEMETRY",
  "VIBEFLOW_CLI_SKIP_PARSE",
  "VIBEFLOW_CLI_SKIP_REFRESH",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_AUTHOR_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

const savedEnv = new Map<string, string | undefined>();
function saveEnv(): void {
  savedEnv.clear();
  for (const key of POISON_KEYS) savedEnv.set(key, process.env[key]);
}
function restoreEnv(): void {
  for (const key of POISON_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  saveEnv();
});

afterEach(() => {
  restoreEnv();
  while (DIRS.length) rmSync(DIRS.pop()!, { recursive: true, force: true });
});

describe("isolatedCliEnv — the env builder", () => {
  it("replaces HOME with the caller temp dir, never inherits it", () => {
    process.env.HOME = "/poison/operator-home";
    const env = isolatedCliEnv({ home: "/tmp/clean-home", cwd: "/tmp/store" });
    expect(env.HOME).toBe("/tmp/clean-home");
  });

  it("strips every GIT_* var and pins GIT_CEILING_DIRECTORIES at the cwd", () => {
    process.env.GIT_DIR = "/poison/repo.git";
    process.env.GIT_WORK_TREE = "/poison/work";
    process.env.GIT_INDEX_FILE = "/poison/index";
    process.env.GIT_AUTHOR_NAME = "Hook Author";
    process.env.GIT_COMMITTER_EMAIL = "hook@example.com";
    const env = isolatedCliEnv({ home: "/tmp/clean-home", cwd: "/tmp/store" });
    for (const key of Object.keys(env)) {
      // The ceiling pin is the one GIT_* var the helper sets on purpose.
      if (key === "GIT_CEILING_DIRECTORIES") continue;
      expect(key.startsWith("GIT_"), `leaked ${key}`).toBe(false);
    }
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_CEILING_DIRECTORIES).toContain("/tmp/store");
  });

  it("drops redirect vars unless the caller passes them explicitly", () => {
    process.env.VIBEFLOW_API_URL = "http://127.0.0.1:9/poison";
    process.env.VIBEFLOW_PROJECT_DIR = "/poison/project";
    process.env.VIBEFLOW_CLI_SKIP_PARSE = "1";
    const dropped = isolatedCliEnv({ home: "/tmp/h", cwd: "/tmp/store" });
    expect(dropped.VIBEFLOW_API_URL).toBeUndefined();
    expect(dropped.VIBEFLOW_PROJECT_DIR).toBeUndefined();
    expect(dropped.VIBEFLOW_CLI_SKIP_PARSE).toBeUndefined();

    const kept = isolatedCliEnv({
      home: "/tmp/h",
      cwd: "/tmp/store",
      env: { VIBEFLOW_API_URL: "http://127.0.0.1:45231/stub" },
    });
    expect(kept.VIBEFLOW_API_URL).toBe("http://127.0.0.1:45231/stub");
  });

  it("forces telemetry off and never mutates process.env", () => {
    process.env.VIBEFLOW_TELEMETRY = "1";
    const beforeTelemetry = process.env.VIBEFLOW_TELEMETRY;
    const keyCountBefore = Object.keys(process.env).length;
    const env = isolatedCliEnv({ home: "/tmp/h" });
    expect(env.VIBEFLOW_TELEMETRY).toBe("0");
    expect(Object.keys(process.env).length).toBe(keyCountBefore);
    expect(process.env.VIBEFLOW_TELEMETRY).toBe(beforeTelemetry);
  });
});

describe("spawnCliIsolated — poisoned-parent spawn", () => {
  it("never sees a poisoned HOME: stays local even with a fake token next door", async () => {
    // Poison the parent the way a logged-in operator's box looks: a HOME
    // carrying a token (which flips getMode() to saas) plus junk redirects.
    const poisonHome = freshDir("poison-home-");
    mkdirSync(join(poisonHome, ".vibeflow"), { recursive: true });
    writeFileSync(join(poisonHome, ".vibeflow", "token"), "fake-operator-token");
    writeFileSync(join(poisonHome, "sentinel.txt"), "operator data");
    process.env.HOME = poisonHome;
    process.env.VIBEFLOW_API_URL = "http://127.0.0.1:9/poison-api";

    const store = freshDir("iso-store-");
    seedTask(store, { id: "local-1", title: "Local seed", status: "todo" });
    const cleanHome = freshDir("iso-home-");

    const before = inventory(poisonHome);
    const res = await spawnCliIsolated(["tasks", store, "--json"], {
      cwd: store,
      home: cleanHome,
    });

    // Local, offline, successful: the child never saw the fake token (saas
    // mode would have aimed at the junk API and failed) nor the junk URL.
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.stdout) as { ok: boolean; tasks: unknown[] };
    expect(parsed.ok).toBe(true);
    expect(JSON.stringify(parsed.tasks)).toContain("Local seed");

    // And it wrote nothing next to the operator's data.
    expect(inventory(poisonHome)).toEqual(before);
    expect(existsSync(join(cleanHome, ".vibeflow"))).toBe(false);
  });

  it("survives hook-context GIT_* poisoning (smoke: bogus repo location)", async () => {
    // Under a git hook the parent carries GIT_DIR/GIT_WORK_TREE aimed at the
    // OUTER repo. The child must resolve its repo from its own cwd instead.
    // (The CLI also sanitizes its own git env internally; this proves the
    // spawn boundary holds even where the child does not.)
    process.env.GIT_DIR = join(tmpdir(), "not-a-repo.git");
    process.env.GIT_WORK_TREE = freshDir("poison-worktree-");

    const store = freshDir("iso-git-store-");
    seedTask(store, { id: "g1", title: "Git smoke", status: "todo" });
    const home = freshDir("iso-git-home-");

    const res = await spawnCliIsolated(["tasks", store, "--json"], {
      cwd: store,
      home,
    });
    expect(res.code).toBe(0);
    expect(JSON.parse(res.stdout).ok).toBe(true);
  });
});
