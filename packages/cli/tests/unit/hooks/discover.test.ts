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
  isHookConflict,
  refusedSibling,
  reportUnknownHookEvents,
  resolveHookFile,
  type HookResolution,
  type ResolvedHook,
} from "../../../src/core/hooks/discover.js";

/** Old-behavior resolutions are never conflicts — narrow for assertions. */
function expectResolved(res: HookResolution): ResolvedHook {
  expect(isHookConflict(res)).toBe(false);
  expect(res).not.toBeNull();
  return res as ResolvedHook;
}

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
    const resolved = expectResolved(resolveHookFile(projectDir, "after", "task.update", home));
    expect(resolved.file).toBe(projectFile);
    expect(resolved.root).toBe("project");
    expect(resolved.mode).toBe("stdio");

    rmSync(projectFile);
    const globalResolved = expectResolved(resolveHookFile(projectDir, "after", "task.update", home));
    expect(globalResolved.file).toBe(globalFile);
    expect(globalResolved.root).toBe("global");
  });

  it("falls back to shipped defaults", () => {
    const defaultsFile = writeDefaultsHook();
    const resolved = expectResolved(resolveHookFile(projectDir, "after", "task.update", home));
    expect(resolved.file).toBe(defaultsFile);
    expect(resolved.root).toBe("defaults");
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
    const resolved = expectResolved(resolveHookFile(projectDir, "after", "task.update", home));
    expect(resolved.root).toBe("project");
    expect(resolved.escapedRoot).toBe(true);
    expect(resolved.file).toBe(target);
  });

  it("in-root symlinks are not escapes", () => {
    const real = writeProjectHook();
    const link = join(projectDir, ".vibeflow-hooks", "after", "after-task.delete.mjs");
    rmSync(real);
    const dir = join(projectDir, ".vibeflow-hooks", "after");
    const target = join(dir, "real-task-delete.mjs");
    writeFileSync(target, `// real\n`);
    symlinkSync(target, link);
    const resolved = expectResolved(resolveHookFile(projectDir, "after", "task.delete", home));
    expect(resolved.escapedRoot).toBe(false);
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

describe("module peers (Stage 1.5, ADR-0006)", () => {
  function writeProjectModuleHook(event = "task.update"): string {
    const dir = join(projectDir, ".vibeflow-hooks", "after");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `after-${event}.hook.mjs`);
    writeFileSync(file, `export default async () => ({});\n`);
    return file;
  }

  function writeGlobalModuleHook(event = "task.update"): string {
    const dir = join(home, ".vibeflow", "hooks", "after");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `after-${event}.hook.mjs`);
    writeFileSync(file, `export default async () => ({});\n`);
    return file;
  }

  it("a lone module peer resolves with mode 'module'", () => {
    const file = writeProjectModuleHook();
    const resolved = expectResolved(
      resolveHookFile(projectDir, "after", "task.update", home),
    );
    expect(resolved.file).toBe(file);
    expect(resolved.root).toBe("project");
    expect(resolved.mode).toBe("module");
  });

  it("project module beats global stdio beats shipped defaults", () => {
    const moduleFile = writeProjectModuleHook();
    const globalStdio = join(home, ".vibeflow", "hooks", "after");
    mkdirSync(globalStdio, { recursive: true });
    writeFileSync(join(globalStdio, "after-task.update.mjs"), `// global\n`);
    const first = expectResolved(
      resolveHookFile(projectDir, "after", "task.update", home),
    );
    expect(first.file).toBe(moduleFile);
    expect(first.mode).toBe("module");

    rmSync(moduleFile);
    const second = expectResolved(
      resolveHookFile(projectDir, "after", "task.update", home),
    );
    expect(second.root).toBe("global");
    expect(second.mode).toBe("stdio");
  });

  it("global module beats shipped defaults", () => {
    const moduleFile = writeGlobalModuleHook();
    const resolved = expectResolved(
      resolveHookFile(projectDir, "after", "task.update", home),
    );
    expect(resolved.file).toBe(moduleFile);
    expect(resolved.root).toBe("global");
    expect(resolved.mode).toBe("module");
  });

  it("stdio+module at the same level is an explicit conflict (no fallback)", () => {
    writeProjectModuleHook();
    const dir = join(projectDir, ".vibeflow-hooks", "after");
    const stdioFile = join(dir, "after-task.update.mjs");
    writeFileSync(stdioFile, `// stdio\n`);
    const resolved = resolveHookFile(projectDir, "after", "task.update", home);
    expect(isHookConflict(resolved)).toBe(true);
    if (!isHookConflict(resolved)) throw new Error("expected conflict");
    expect(resolved.root).toBe("project");
    expect(resolved.stdioFile).toBe(stdioFile);
    expect(resolved.moduleFile).toBe(join(dir, "after-task.update.hook.mjs"));
  });

  it("a higher-level conflict never degrades to a lower-level hook", () => {
    writeProjectModuleHook();
    const dir = join(projectDir, ".vibeflow-hooks", "after");
    writeFileSync(join(dir, "after-task.update.mjs"), `// stdio\n`);
    const globalDir = join(home, ".vibeflow", "hooks", "after");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "after-task.update.mjs"), `// global\n`);
    // Still the project-level conflict — the global file is invisible.
    expect(
      isHookConflict(resolveHookFile(projectDir, "after", "task.update", home)),
    ).toBe(true);
  });

  it("global-level conflict wins over shipped defaults", () => {
    const globalDir = join(home, ".vibeflow", "hooks", "after");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "after-task.update.mjs"), `// global\n`);
    writeFileSync(join(globalDir, "after-task.update.hook.mjs"), `export default () => ({});\n`);
    const resolved = resolveHookFile(projectDir, "after", "task.update", home);
    expect(isHookConflict(resolved)).toBe(true);
    if (!isHookConflict(resolved)) throw new Error("expected conflict");
    expect(resolved.root).toBe("global");
  });

  it("a dangling symlink in the pair is missing, not a conflict", () => {
    const dir = join(projectDir, ".vibeflow-hooks", "after");
    mkdirSync(dir, { recursive: true });
    symlinkSync(
      join(projectDir, "no-such-target.mjs"),
      join(dir, "after-task.update.mjs"),
    );
    const moduleFile = writeProjectModuleHook();
    const resolved = expectResolved(
      resolveHookFile(projectDir, "after", "task.update", home),
    );
    expect(resolved.file).toBe(moduleFile);
    expect(resolved.mode).toBe("module");
  });

  it("module in-root symlinks are accepted, escapes are marked", () => {
    const dir = join(projectDir, ".vibeflow-hooks", "after");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "real-module.mjs");
    writeFileSync(target, `export default () => ({});\n`);
    symlinkSync(target, join(dir, "after-task.update.hook.mjs"));
    const inRoot = expectResolved(
      resolveHookFile(projectDir, "after", "task.update", home),
    );
    expect(inRoot.mode).toBe("module");
    expect(inRoot.escapedRoot).toBe(false);

    rmSync(join(dir, "after-task.update.hook.mjs"));
    const outside = mkdtempSync(join(tmpdir(), "hook-outside-mod-"));
    const evil = join(outside, "evil.hook.mjs");
    writeFileSync(evil, `export default () => ({});\n`);
    symlinkSync(evil, join(dir, "after-task.update.hook.mjs"));
    const escaped = expectResolved(
      resolveHookFile(projectDir, "after", "task.update", home),
    );
    expect(escaped.mode).toBe("module");
    expect(escaped.escapedRoot).toBe(true);
  });

  it("directories masquerading as module peers are ignored", () => {
    const dir = join(projectDir, ".vibeflow-hooks", "after");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, "after-task.update.hook.mjs"));
    expect(resolveHookFile(projectDir, "after", "task.update", home)).toBeNull();
  });
});

describe("reportUnknownHookEvents with module peers (Stage 1.5)", () => {
  it("a known-event .hook.mjs peer is not an unknown event", () => {
    const dir = join(projectDir, ".vibeflow-hooks", "after");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "after-task.update.hook.mjs"), `export default () => ({});\n`);
    const lines: string[] = [];
    reportUnknownHookEvents(projectDir, (m) => lines.push(m));
    expect(lines).toHaveLength(0);
  });

  it("an unknown-event .hook.mjs peer is reported once, not interpreted", () => {
    const dir = join(projectDir, ".vibeflow-hooks", "after");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "after-task.quux.hook.mjs"), `export default () => ({});\n`);
    const lines: string[] = [];
    reportUnknownHookEvents(projectDir, (m) => lines.push(m));
    reportUnknownHookEvents(projectDir, (m) => lines.push(m));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("HOOK_UNKNOWN_EVENT");
    expect(lines[0]).toContain("task.quux");
    expect(lines[0]).toContain('"task.quux"');
  });
});
