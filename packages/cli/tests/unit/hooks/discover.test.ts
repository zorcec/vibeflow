/**
 * Discovery tests (ADR-0006): precedence project > global > defaults,
 * override REPLACES, canonical roots, regular-file checks, the explicit
 * symlink rule, refused extensions, and unknown-event reporting.
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  hookRoots,
  refusedSibling,
  reportUnknownHookEvents,
  resolveHookFile,
} from "../../../src/core/hooks/discover.js";

let projectDir: string;
let home: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "hook-discover-proj-"));
  home = mkdtempSync(join(tmpdir(), "hook-discover-home-"));
});

function writeProjectHook(event = "task.update"): string {
  const dir = join(projectDir, ".vibeflow-hooks", "after");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `after-${event}.mjs`);
  writeFileSync(file, `// project hook\n`);
  return file;
}

function writeGlobalHook(event = "task.update"): string {
  const dir = join(home, ".vibeflow", "hooks", "after");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `after-${event}.mjs`);
  writeFileSync(file, `// global hook\n`);
  return file;
}

function writeDefaultsHook(event = "task.update"): string {
  const dir = join(home, ".vibeflow", "hooks", "defaults", "after");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `after-${event}.mjs`);
  writeFileSync(file, `// defaults hook\n`);
  return file;
}

describe("resolveHookFile", () => {
  it("returns null when nothing exists", () => {
    expect(resolveHookFile(projectDir, "after", "task.update", home)).toBeNull();
  });

  it("project beats global beats defaults (override REPLACES, never merges)", () => {
    const projectFile = writeProjectHook();
    const globalFile = writeGlobalHook();
    const defaultsFile = writeDefaultsHook();
    void globalFile;
    void defaultsFile;
    const resolved = resolveHookFile(projectDir, "after", "task.update", home);
    expect(resolved?.file).toBe(projectFile);
    expect(resolved?.root).toBe("project");

    rmSync(projectFile);
    const globalResolved = resolveHookFile(projectDir, "after", "task.update", home);
    expect(globalResolved?.file).toBe(globalFile);
    expect(globalResolved?.root).toBe("global");
  });

  it("falls back to shipped defaults", () => {
    const defaultsFile = writeDefaultsHook();
    const resolved = resolveHookFile(projectDir, "after", "task.update", home);
    expect(resolved?.file).toBe(defaultsFile);
    expect(resolved?.root).toBe("defaults");
  });

  it("ignores directories masquerading as hook files (regular-file check)", () => {
    const dir = join(projectDir, ".vibeflow-hooks", "after");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, "after-task.update.mjs"));
    expect(resolveHookFile(projectDir, "after", "task.update", home)).toBeNull();
  });

  it("marks symlink escapes (no trusted<->untrusted inheritance)", () => {
    const outside = mkdtempSync(join(tmpdir(), "hook-outside-"));
    const target = join(outside, "evil.mjs");
    writeFileSync(target, `// outside\n`);
    const dir = join(projectDir, ".vibeflow-hooks", "after");
    mkdirSync(dir, { recursive: true });
    symlinkSync(target, join(dir, "after-task.update.mjs"));
    const resolved = resolveHookFile(projectDir, "after", "task.update", home);
    expect(resolved?.root).toBe("project");
    expect(resolved?.escapedRoot).toBe(true);
    expect(resolved?.file).toBe(target);
  });

  it("in-root symlinks are not escapes", () => {
    const real = writeProjectHook();
    const link = join(projectDir, ".vibeflow-hooks", "after", "after-task.delete.mjs");
    rmSync(real);
    const dir = join(projectDir, ".vibeflow-hooks", "after");
    const target = join(dir, "real-task-delete.mjs");
    writeFileSync(target, `// real\n`);
    symlinkSync(target, link);
    const resolved = resolveHookFile(projectDir, "after", "task.delete", home);
    expect(resolved?.escapedRoot).toBe(false);
  });
});

describe("refusedSibling", () => {
  it("refuses .js/.cjs loudly (never silently ignored)", () => {
    const dir = join(projectDir, ".vibeflow-hooks", "after");
    mkdirSync(dir, { recursive: true });
    const jsFile = join(dir, "after-task.update.js");
    writeFileSync(jsFile, `// wrong extension\n`);
    expect(refusedSibling(dir, "after", "task.update")).toBe(jsFile);
    expect(resolveHookFile(projectDir, "after", "task.update", home)).toBeNull();
    rmSync(jsFile);
    const cjsFile = join(dir, "after-task.update.cjs");
    writeFileSync(cjsFile, `// wrong extension\n`);
    expect(refusedSibling(dir, "after", "task.update")).toBe(cjsFile);
  });

  it("returns null when no refused sibling exists", () => {
    const dir = join(projectDir, ".vibeflow-hooks", "after");
    mkdirSync(dir, { recursive: true });
    expect(refusedSibling(dir, "after", "task.update")).toBeNull();
  });
});

describe("hookRoots", () => {
  it("uses canonical absolute roots", () => {
    const roots = hookRoots(projectDir, home);
    expect(roots.project).toBe(join(projectDir, ".vibeflow-hooks"));
    expect(roots.global).toBe(join(home, ".vibeflow", "hooks"));
    expect(roots.defaults).toBe(join(home, ".vibeflow", "hooks", "defaults"));
    expect(existsSync(projectDir)).toBe(true);
  });
});

describe("reportUnknownHookEvents", () => {
  it("reports unknown events once on stderr, never guessing", () => {
    const dir = join(projectDir, ".vibeflow-hooks", "after");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "after-task.frobnicate.mjs"), `// unknown\n`);
    const lines: string[] = [];
    reportUnknownHookEvents(projectDir, (m) => lines.push(m));
    reportUnknownHookEvents(projectDir, (m) => lines.push(m));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("HOOK_UNKNOWN_EVENT");
    expect(lines[0]).toContain("task.frobnicate");
  });
});
