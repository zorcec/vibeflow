/**
 * Defaults tests (ADR-0006): unconditional-text-only extraction,
 * byte-identical acceptance against renderAgentInstructions, wholesale
 * .version-gated regeneration, and the documented no-ops.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  DEFAULT_HOOK_LINES,
  DEFAULT_HOOK_SOURCES,
  DEFAULT_HOOKS_VERSION,
} from "../../../src/core/hooks/defaults.generated.js";
import {
  bundledDefaultSource,
  ensureShippedDefaults,
  getDefaultHookSource,
  shippedDefaultsVersion,
} from "../../../src/core/hooks/defaults.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TASKS_TS = join(HERE, "..", "..", "..", "src", "core", "tasks.ts");

const EXPECTED_EVENTS = [
  "task.create",
  "task.update",
  "task.claim",
  "task.delete",
  "task.comment",
  "push",
  "pull",
  "verify",
];

describe("shipped defaults", () => {
  it("covers exactly the 8 events", () => {
    expect(Object.keys(DEFAULT_HOOK_SOURCES).sort()).toEqual(
      [...EXPECTED_EVENTS].sort(),
    );
    expect(Object.keys(DEFAULT_HOOK_LINES).sort()).toEqual(
      [...EXPECTED_EVENTS].sort(),
    );
  });

  it("extracted lines are byte-identical to renderAgentInstructions source sections", () => {
    const tasksSource = readFileSync(TASKS_TS, "utf8");
    const missing: string[] = [];
    for (const [event, lines] of Object.entries(DEFAULT_HOOK_LINES)) {
      for (const line of lines as string[]) {
        // Verbatim: same characters, same indentation — the acceptance
        // applies to the extracted sections only.
        if (!tasksSource.includes(line)) missing.push(`${event}: ${line}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("no settings-dependent or type-dependent text leaked into defaults", () => {
    const all = Object.values(DEFAULT_HOOK_LINES).flat().join("\n");
    expect(all).not.toContain("[setting]");
    expect(all).not.toContain("Auto-commit");
    expect(all).not.toContain("Auto-push");
    expect(all).not.toContain("Auto-comment");
    expect(all).not.toContain("Create branch");
    expect(all).not.toContain("Verify gate");
    expect(all).not.toContain("Research tasks");
    expect(all).not.toContain("Bug tasks");
  });

  it("create/delete/push/pull ship as documented no-ops", () => {
    for (const event of ["task.create", "task.delete", "push", "pull"]) {
      expect(DEFAULT_HOOK_LINES[event]).toEqual([]);
      expect(DEFAULT_HOOK_SOURCES[event]).toContain("documented no-op");
      expect(DEFAULT_HOOK_SOURCES[event]).toContain("JSON.stringify({})");
    }
  });

  it("text defaults emit their lines as instructions when executed", async () => {
    const { execFile } = await import("node:child_process");
    const { writeFileSync: writeTmp, mkdtempSync: mkTmp } = await import("node:fs");
    const tmp = mkTmp(join(tmpdir(), "hook-default-exec-"));
    for (const event of ["task.claim", "task.update", "task.comment", "verify"]) {
      const file = join(tmp, `${event}.mjs`);
      writeTmp(file, DEFAULT_HOOK_SOURCES[event] as string);
      const stdout: string = await new Promise((resolvePromise, reject) => {
        const child = execFile(
          process.execPath,
          [file],
          { timeout: 10000 },
          (err, stdout) => (err ? reject(err) : resolvePromise(stdout)),
        );
        child.stdin?.write(JSON.stringify({ event }) + "\n");
        child.stdin?.end();
      });
      const parsed = JSON.parse(stdout.trim()) as { instructions?: string };
      expect(typeof parsed.instructions, event).toBe("string");
      expect(parsed.instructions?.split("\n")).toEqual(
        DEFAULT_HOOK_LINES[event] as string[],
      );
    }
  });
});

describe("ensureShippedDefaults", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "hook-defaults-home-"));
  });

  it("materialises all 8 defaults plus the version marker", () => {
    ensureShippedDefaults(home);
    expect(shippedDefaultsVersion(home)).toBe(DEFAULT_HOOKS_VERSION);
    for (const event of EXPECTED_EVENTS) {
      const file = join(home, ".vibeflow", "hooks", "defaults", "after", `after-${event}.mjs`);
      expect(existsSync(file), event).toBe(true);
      expect(readFileSync(file, "utf8")).toBe(
        DEFAULT_HOOK_SOURCES[event] as string,
      );
    }
  });

  it("is idempotent: a matching marker performs no rewrite", () => {
    ensureShippedDefaults(home);
    const marker = join(home, ".vibeflow", "hooks", "defaults", ".version");
    const before = readFileSync(marker, "utf8");
    ensureShippedDefaults(home);
    expect(readFileSync(marker, "utf8")).toBe(before);
  });

  it("a version mismatch regenerates wholesale", () => {
    ensureShippedDefaults(home);
    const dir = join(home, ".vibeflow", "hooks", "defaults");
    // Corrupt one file and roll the marker back: the next run rewrites all.
    writeFileSync(join(dir, "after", "after-verify.mjs"), "// stale\n");
    writeFileSync(join(dir, ".version"), "0\n");
    expect(shippedDefaultsVersion(home)).toBe("0");
    ensureShippedDefaults(home);
    expect(shippedDefaultsVersion(home)).toBe(DEFAULT_HOOKS_VERSION);
    expect(readFileSync(join(dir, "after", "after-verify.mjs"), "utf8")).toBe(
      DEFAULT_HOOK_SOURCES["verify"] as string,
    );
  });

  it("getDefaultHookSource resolves the materialised file", () => {
    expect(getDefaultHookSource("verify", home)).toBeNull();
    ensureShippedDefaults(home);
    const resolved = getDefaultHookSource("verify", home);
    expect(resolved?.file).toBe(
      join(home, ".vibeflow", "hooks", "defaults", "after", "after-verify.mjs"),
    );
  });

  it("bundledDefaultSource exposes the generated source", () => {
    for (const event of EXPECTED_EVENTS) {
      expect(bundledDefaultSource(event as "verify")).toBe(
        DEFAULT_HOOK_SOURCES[event] as string,
      );
    }
  });
});
