/**
 * Defaults tests (ADR-0007): unconditional-text-only extraction,
 * byte-identical acceptance against renderAgentInstructions, the
 * 9-file in-package layout, and the documented no-ops.
 *
 * What changed from v1: defaults are READ IN PLACE from the installed
 * package (`src/core/hooks/defaults/` in the tree,
 * `<pkg>/dist/hooks/defaults/` installed) — nothing is materialised into
 * `$HOME`, so there is no `.version` marker, no idempotence test, and no
 * regeneration test. The drift test reads the committed sources directly.
 */
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  SHIPPED_DEFAULT_TEXTS,
  SHIPPED_DEFAULTS_VERSION,
} from "../../../src/core/hooks/defaults.generated.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC_HOOKS = join(HERE, "..", "..", "..", "src", "core", "hooks");
const DEFAULTS_DIR = join(SRC_HOOKS, "defaults");
const TASKS_TS = join(HERE, "..", "..", "..", "src", "core", "tasks.ts");

const EXPECTED_FILES = [
  "tasks.after.mjs",
  "update_task.after.mjs",
  "claim_next_task.after.mjs",
  "add_comment.after.mjs",
  "verify.after.mjs",
  "verify_task.after.mjs",
  "push.after.mjs",
  "pull.after.mjs",
  "create_task.after.mjs",
];

describe("shipped defaults (in-package layout)", () => {
  it("VERSION is 3", () => {
    expect(SHIPPED_DEFAULTS_VERSION).toBe("3");
    expect(readFileSync(join(DEFAULTS_DIR, "VERSION"), "utf8").trim()).toBe("3");
  });

  it(" ships exactly the 9 activity-bearing after files (no .before defaults)", () => {
    expect(readdirSync(DEFAULTS_DIR).filter((f) => f !== "VERSION").sort()).toEqual([...EXPECTED_FILES].sort());
  });

  it("SHIPPED_DEFAULT_TEXTS covers exactly the 9 tools with their activities", () => {
    expect(Object.keys(SHIPPED_DEFAULT_TEXTS).sort()).toEqual(
      ["add_comment", "claim_next_task", "create_task", "pull", "push", "tasks", "update_task", "verify", "verify_task"].sort(),
    );
    expect(SHIPPED_DEFAULT_TEXTS["tasks"]).toEqual({
      "task.create": [],
      "task.update": expect.any(Array),
      "task.claim": expect.any(Array),
      "task.delete": [],
      "task.comment": expect.any(Array),
    });
  });

  it("extracted lines are byte-identical to renderAgentInstructions source sections", () => {
    const tasksSource = readFileSync(TASKS_TS, "utf8");
    const missing: string[] = [];
    for (const [tool, byActivity] of Object.entries(SHIPPED_DEFAULT_TEXTS)) {
      for (const [activity, lines] of Object.entries(byActivity)) {
        for (const line of lines) {
          // Verbatim: same characters, same indentation — the acceptance
          // applies to the extracted sections only.
          if (!tasksSource.includes(line)) missing.push(`${tool}/${activity}: ${line}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("no settings-dependent or type-dependent text leaked into defaults", () => {
    const all = Object.values(SHIPPED_DEFAULT_TEXTS)
      .flatMap((byActivity) => Object.values(byActivity).flat())
      .join("\n");
    expect(all).not.toContain("[setting]");
    expect(all).not.toContain("Auto-commit");
    expect(all).not.toContain("Auto-push");
    expect(all).not.toContain("Auto-comment");
    expect(all).not.toContain("Create branch");
    expect(all).not.toContain("Verify gate");
    expect(all).not.toContain("Research tasks");
    expect(all).not.toContain("Bug tasks");
  });

  it("empty-activity tools ship as documented no-ops", () => {
    for (const file of ["push.after.mjs", "pull.after.mjs", "create_task.after.mjs"]) {
      const source = readFileSync(join(DEFAULTS_DIR, file), "utf8");
      expect(source).toContain("documented no-op");
      expect(source).toContain("JSON.stringify({})");
    }
    expect(SHIPPED_DEFAULT_TEXTS["push"]).toEqual({ push: [] });
    expect(SHIPPED_DEFAULT_TEXTS["pull"]).toEqual({ pull: [] });
    expect(SHIPPED_DEFAULT_TEXTS["create_task"]).toEqual({ "task.create": [] });
  });

  it("tasks.after.mjs switches on envelope activity (claim/update/comment text, create/delete no-op)", async () => {
    const file = join(DEFAULTS_DIR, "tasks.after.mjs");
    const run = (activity: string): Promise<{ instructions?: string }> =>
      new Promise((resolvePromise, reject) => {
        const child = execFile(
          process.execPath,
          [file],
          { timeout: 10000 },
          (err, stdout) => (err ? reject(err) : resolvePromise(JSON.parse(stdout.trim()))),
        );
        child.stdin?.write(JSON.stringify({ activity }) + "\n");
        child.stdin?.end();
      });
    expect((await run("task.claim")).instructions?.split("\n")).toEqual(
      SHIPPED_DEFAULT_TEXTS["tasks"]["task.claim"],
    );
    expect((await run("task.update")).instructions?.split("\n")).toEqual(
      SHIPPED_DEFAULT_TEXTS["tasks"]["task.update"],
    );
    expect((await run("task.comment")).instructions?.split("\n")).toEqual(
      SHIPPED_DEFAULT_TEXTS["tasks"]["task.comment"],
    );
    // create/delete carry no unconditional text: the documented {} shape.
    expect(await run("task.create")).toEqual({});
    expect(await run("task.delete")).toEqual({});
  });

  it("single-text MCP defaults emit their lines as instructions when executed", async () => {
    const cases: Array<[string, string, string[]]> = [
      ["update_task.after.mjs", "task.update", SHIPPED_DEFAULT_TEXTS["update_task"]["task.update"]],
      ["claim_next_task.after.mjs", "task.claim", SHIPPED_DEFAULT_TEXTS["claim_next_task"]["task.claim"]],
      ["add_comment.after.mjs", "task.comment", SHIPPED_DEFAULT_TEXTS["add_comment"]["task.comment"]],
      ["verify.after.mjs", "verify", SHIPPED_DEFAULT_TEXTS["verify"]["verify"]],
      ["verify_task.after.mjs", "verify", SHIPPED_DEFAULT_TEXTS["verify_task"]["verify"]],
    ];
    for (const [file, activity, lines] of cases) {
      const stdout: string = await new Promise((resolvePromise, reject) => {
        const child = execFile(
          process.execPath,
          [join(DEFAULTS_DIR, file)],
          { timeout: 10000 },
          (err, stdout) => (err ? reject(err) : resolvePromise(stdout)),
        );
        child.stdin?.write(JSON.stringify({ activity }) + "\n");
        child.stdin?.end();
      });
      const parsed = JSON.parse(stdout.trim()) as { instructions?: string };
      expect(typeof parsed.instructions, file).toBe("string");
      expect(parsed.instructions?.split("\n")).toEqual(lines);
    }
  });

  it("malformed envelope input falls back to {} (fail-open shape)", async () => {
    const stdout: string = await new Promise((resolvePromise, reject) => {
      const child = execFile(
        process.execPath,
        [join(DEFAULTS_DIR, "tasks.after.mjs")],
        { timeout: 10000 },
        (err, stdout) => (err ? reject(err) : resolvePromise(stdout)),
      );
      child.stdin?.write("not json\n");
      child.stdin?.end();
    });
    expect(JSON.parse(stdout.trim())).toEqual({});
  });
});
