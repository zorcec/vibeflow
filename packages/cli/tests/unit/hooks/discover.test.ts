/**
 * Discovery tests (ADR-0007): precedence project > global > shipped,
 * override REPLACES, canonical roots, regular-file checks, the explicit
 * symlink rule, refused extensions, and unrunnable-file reporting.
 *
 * Flat layout: `<root>/tasks.after.mjs` — no `pre/`/`after/` subdirectory.
 * Lookup key is (tool, phase); shipped root is derived from the bundle
 * unless the `shippedDir` seam points elsewhere.
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
  parseHookFileName,
  refusedSibling,
  reportUnrunnableHookFiles,
  resetUnrunnableHookWarnings,
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
/** Isolated shipped root (empty) — hermetic, never the real bundle tree. */
let shippedDir: string;

beforeEach(() => {
  projectDir = mkdtempSync(join(tmpdir(), "hook-discover-proj-"));
  home = mkdtempSync(join(tmpdir(), "hook-discover-home-"));
  shippedDir = mkdtempSync(join(tmpdir(), "hook-discover-shipped-"));
  resetUnrunnableHookWarnings();
});

const opts = (): { home: string; shippedDir: string } => ({ home, shippedDir });

function writeProjectHook(tool = "tasks", phase = "after"): string {
  const dir = join(projectDir, ".vibeflow-hooks");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${tool}.${phase}.mjs`);
  writeFileSync(file, `// project hook\n`);
  return file;
}

function writeGlobalHook(tool = "tasks", phase = "after"): string {
  const dir = join(home, ".vibeflow", "hooks");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${tool}.${phase}.mjs`);
  writeFileSync(file, `// global hook\n`);
  return file;
}

function writeShippedHook(tool = "tasks", phase = "after"): string {
  mkdirSync(shippedDir, { recursive: true });
  const file = join(shippedDir, `${tool}.${phase}.mjs`);
  writeFileSync(file, `// shipped hook\n`);
  return file;
}

describe("resolveHookFile", () => {
  it("returns null when nothing exists", () => {
    expect(resolveHookFile(projectDir, "tasks", "after", opts())).toBeNull();
  });

  it("project beats global beats shipped (override REPLACES, never merges)", () => {
    const projectFile = writeProjectHook();
    const globalFile = writeGlobalHook();
    const shippedFile = writeShippedHook();
    void globalFile;
    void shippedFile;
    const resolved = expectResolved(resolveHookFile(projectDir, "tasks", "after", opts()));
    expect(resolved.file).toBe(projectFile);
    expect(resolved.root).toBe("project");
    expect(resolved.mode).toBe("stdio");

    rmSync(projectFile);
    const globalResolved = expectResolved(resolveHookFile(projectDir, "tasks", "after", opts()));
    expect(globalResolved.file).toBe(globalFile);
    expect(globalResolved.root).toBe("global");
  });

  it("falls back to the shipped root", () => {
    const shippedFile = writeShippedHook();
    const resolved = expectResolved(resolveHookFile(projectDir, "tasks", "after", opts()));
    expect(resolved.file).toBe(shippedFile);
    expect(resolved.root).toBe("shipped");
  });

  it("a missing shipped root is a miss, not an error", () => {
    expect(resolveHookFile(projectDir, "tasks", "after", { home, shippedDir: null })).toBeNull();
    expect(resolveHookFile(projectDir, "tasks", "after", { home, shippedDir: join(tmpdir(), "hook-no-such-dir") })).toBeNull();
  });

  it("before and after are independent files", () => {
    const before = writeProjectHook("tasks", "before");
    const afterResolved = resolveHookFile(projectDir, "tasks", "after", opts());
    expect(afterResolved).toBeNull();
    const beforeResolved = expectResolved(resolveHookFile(projectDir, "tasks", "before", opts()));
    expect(beforeResolved.file).toBe(before);
  });

  it("ignores directories masquerading as hook files (regular-file check)", () => {
    const dir = join(projectDir, ".vibeflow-hooks");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, "tasks.after.mjs"));
    expect(resolveHookFile(projectDir, "tasks", "after", opts())).toBeNull();
  });

  it("marks symlink escapes (no trusted<->untrusted inheritance)", () => {
    const outside = mkdtempSync(join(tmpdir(), "hook-outside-"));
    const target = join(outside, "evil.mjs");
    writeFileSync(target, `// outside\n`);
    const dir = join(projectDir, ".vibeflow-hooks");
    mkdirSync(dir, { recursive: true });
    symlinkSync(target, join(dir, "tasks.after.mjs"));
    const resolved = expectResolved(resolveHookFile(projectDir, "tasks", "after", opts()));
    expect(resolved.root).toBe("project");
    expect(resolved.escapedRoot).toBe(true);
    expect(resolved.file).toBe(target);
  });

  it("in-root symlinks are not escapes", () => {
    const dir = join(projectDir, ".vibeflow-hooks");
    mkdirSync(dir, { recursive: true });
    const target = join(dir, "real-tasks-after.mjs");
    writeFileSync(target, `// real\n`);
    symlinkSync(target, join(dir, "tasks.after.mjs"));
    const resolved = expectResolved(resolveHookFile(projectDir, "tasks", "after", opts()));
    expect(resolved.escapedRoot).toBe(false);
  });

  it("a shipped file that symlinks out is resolved with escapedRoot (emit refuses HOOK_SHIPPED_ESCAPED)", () => {
    const outside = mkdtempSync(join(tmpdir(), "hook-outside-shipped-"));
    const target = join(outside, "evil.mjs");
    writeFileSync(target, `// outside\n`);
    mkdirSync(shippedDir, { recursive: true });
    symlinkSync(target, join(shippedDir, "tasks.after.mjs"));
    const resolved = expectResolved(resolveHookFile(projectDir, "tasks", "after", opts()));
    expect(resolved.root).toBe("shipped");
    expect(resolved.escapedRoot).toBe(true);
  });
});

describe("refusedSibling", () => {
  it("refuses .before.js/.cjs loudly (never silently ignored)", () => {
    const dir = join(projectDir, ".vibeflow-hooks");
    mkdirSync(dir, { recursive: true });
    const jsFile = join(dir, "tasks.before.js");
    writeFileSync(jsFile, `// wrong extension\n`);
    expect(refusedSibling(dir, "tasks", "before")).toBe(jsFile);
    expect(resolveHookFile(projectDir, "tasks", "before", opts())).toBeNull();
    rmSync(jsFile);
    const cjsFile = join(dir, "tasks.before.cjs");
    writeFileSync(cjsFile, `// wrong extension\n`);
    expect(refusedSibling(dir, "tasks", "before")).toBe(cjsFile);
  });

  it("refuses bare .ts/.mts siblings (the .hook. infix is the adapter)", () => {
    const dir = join(projectDir, ".vibeflow-hooks");
    mkdirSync(dir, { recursive: true });
    const tsFile = join(dir, "tasks.before.ts");
    writeFileSync(tsFile, `// wrong extension\n`);
    expect(refusedSibling(dir, "tasks", "before")).toBe(tsFile);
    expect(resolveHookFile(projectDir, "tasks", "before", opts())).toBeNull();
  });

  it("returns null when no refused sibling exists", () => {
    const dir = join(projectDir, ".vibeflow-hooks");
    mkdirSync(dir, { recursive: true });
    expect(refusedSibling(dir, "tasks", "after")).toBeNull();
  });
});

describe("hookRoots", () => {
  it("uses canonical absolute roots with the shipped seam", () => {
    const roots = hookRoots(projectDir, opts());
    expect(roots.project).toBe(join(projectDir, ".vibeflow-hooks"));
    expect(roots.global).toBe(join(home, ".vibeflow", "hooks"));
    expect(roots.shipped).toBe(shippedDir);
    expect(existsSync(projectDir)).toBe(true);
  });
});

describe("reportUnrunnableHookFiles (the one scanner)", () => {
  it("reports refused suffixes once per path (HOOK_BAD_EXTENSION)", () => {
    const dir = join(projectDir, ".vibeflow-hooks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tasks.after.js"), `// wrong\n`);
    const lines: string[] = [];
    reportUnrunnableHookFiles(projectDir, { ...opts(), onWarn: (m) => lines.push(m) });
    reportUnrunnableHookFiles(projectDir, { ...opts(), onWarn: (m) => lines.push(m) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("HOOK_BAD_EXTENSION");
  });

  it("reports unknown tools once per path (HOOK_UNKNOWN_TOOL)", () => {
    const dir = join(projectDir, ".vibeflow-hooks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "frobnicate.after.mjs"), `// unknown\n`);
    const lines: string[] = [];
    reportUnrunnableHookFiles(projectDir, { ...opts(), onWarn: (m) => lines.push(m) });
    reportUnrunnableHookFiles(projectDir, { ...opts(), onWarn: (m) => lines.push(m) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("HOOK_UNKNOWN_TOOL");
    expect(lines[0]).toContain("frobnicate");
  });

  it("reports unsupported cells: .before on a read tool (HOOK_NOT_GATEABLE)", () => {
    const dir = join(projectDir, ".vibeflow-hooks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "kanban.before.mjs"), `// not gateable\n`);
    const lines: string[] = [];
    reportUnrunnableHookFiles(projectDir, { ...opts(), onWarn: (m) => lines.push(m) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("HOOK_NOT_GATEABLE");
    expect(lines[0]).toContain("kanban");
  });

  it("reports mcp.after and the authors container", () => {
    const dir = join(projectDir, ".vibeflow-hooks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "mcp.after.mjs"), `// no after\n`);
    writeFileSync(join(dir, "authors.after.mjs"), `// container\n`);
    const lines: string[] = [];
    reportUnrunnableHookFiles(projectDir, { ...opts(), onWarn: (m) => lines.push(m) });
    expect(lines.some((l) => l.includes("HOOK_NO_AFTER") && l.includes("mcp"))).toBe(true);
    expect(lines.some((l) => l.includes("HOOK_CONTAINER_TOOL") && l.includes("authors"))).toBe(true);
  });

  it("valid files stay silent; non-hook names are ignored", () => {
    const dir = join(projectDir, ".vibeflow-hooks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tasks.after.mjs"), `// ok\n`);
    writeFileSync(join(dir, "trust.json"), `{}\n`);
    writeFileSync(join(dir, "bypass-audit.log"), ``);
    writeFileSync(join(dir, "verify.after.config.json"), `{}\n`);
    const lines: string[] = [];
    reportUnrunnableHookFiles(projectDir, { ...opts(), onWarn: (m) => lines.push(m) });
    expect(lines).toEqual([]);
  });

  it("a bare .ts file is refused (HOOK_BAD_EXTENSION), not an unknown tool", () => {
    const dir = join(projectDir, ".vibeflow-hooks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tasks.after.ts"), `// bare\n`);
    const lines: string[] = [];
    reportUnrunnableHookFiles(projectDir, { ...opts(), onWarn: (m) => lines.push(m) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("HOOK_BAD_EXTENSION");
  });
});

describe("module peers (kept from v1, flat names)", () => {
  function writeProjectModuleHook(tool = "tasks", phase = "after"): string {
    const dir = join(projectDir, ".vibeflow-hooks");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${tool}.${phase}.hook.mjs`);
    writeFileSync(file, `export default async () => ({});\n`);
    return file;
  }

  function writeGlobalModuleHook(tool = "tasks", phase = "after"): string {
    const dir = join(home, ".vibeflow", "hooks");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${tool}.${phase}.hook.mjs`);
    writeFileSync(file, `export default async () => ({});\n`);
    return file;
  }

  it("a lone module peer resolves with mode 'module'", () => {
    const file = writeProjectModuleHook();
    const resolved = expectResolved(resolveHookFile(projectDir, "tasks", "after", opts()));
    expect(resolved.file).toBe(file);
    expect(resolved.root).toBe("project");
    expect(resolved.mode).toBe("module");
  });

  it("project module beats global stdio beats shipped default", () => {
    const moduleFile = writeProjectModuleHook();
    writeGlobalHook();
    writeShippedHook();
    const first = expectResolved(resolveHookFile(projectDir, "tasks", "after", opts()));
    expect(first.file).toBe(moduleFile);
    expect(first.mode).toBe("module");

    rmSync(moduleFile);
    const second = expectResolved(resolveHookFile(projectDir, "tasks", "after", opts()));
    expect(second.root).toBe("global");
    expect(second.mode).toBe("stdio");
  });

  it("stdio+module at the same level is an explicit conflict (no fallback)", () => {
    writeProjectModuleHook();
    const dir = join(projectDir, ".vibeflow-hooks");
    const stdioFile = join(dir, "tasks.after.mjs");
    writeFileSync(stdioFile, `// stdio\n`);
    const resolved = resolveHookFile(projectDir, "tasks", "after", opts());
    expect(isHookConflict(resolved)).toBe(true);
    if (!isHookConflict(resolved)) throw new Error("expected conflict");
    expect(resolved.root).toBe("project");
    expect(resolved.files).toEqual([stdioFile, join(dir, "tasks.after.hook.mjs")]);
  });

  it("a higher-level conflict never degrades to a lower-level hook", () => {
    writeProjectModuleHook();
    const dir = join(projectDir, ".vibeflow-hooks");
    writeFileSync(join(dir, "tasks.after.mjs"), `// stdio\n`);
    writeGlobalHook();
    expect(isHookConflict(resolveHookFile(projectDir, "tasks", "after", opts()))).toBe(true);
  });

  it("a dangling symlink in the pair is missing, not a conflict", () => {
    const dir = join(projectDir, ".vibeflow-hooks");
    mkdirSync(dir, { recursive: true });
    symlinkSync(join(projectDir, "no-such-target.mjs"), join(dir, "tasks.after.mjs"));
    const moduleFile = writeProjectModuleHook();
    const resolved = expectResolved(resolveHookFile(projectDir, "tasks", "after", opts()));
    expect(resolved.file).toBe(moduleFile);
    expect(resolved.mode).toBe("module");
  });

  it("directories masquerading as module peers are ignored", () => {
    const dir = join(projectDir, ".vibeflow-hooks");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, "tasks.after.hook.mjs"));
    expect(resolveHookFile(projectDir, "tasks", "after", opts())).toBeNull();
  });
});

describe("TypeScript module peers (kept from v1, flat names)", () => {
  function writeTsHook(name: string): string {
    const dir = join(projectDir, ".vibeflow-hooks");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, name);
    writeFileSync(file, `export default async () => ({});\n`);
    return file;
  }

  it("a lone .hook.ts peer resolves with mode 'module-ts'", () => {
    const file = writeTsHook("tasks.after.hook.ts");
    const resolved = expectResolved(resolveHookFile(projectDir, "tasks", "after", opts()));
    expect(resolved.file).toBe(file);
    expect(resolved.root).toBe("project");
    expect(resolved.mode).toBe("module-ts");
  });

  it("a lone .hook.mts peer resolves with mode 'module-ts'", () => {
    const file = writeTsHook("tasks.after.hook.mts");
    const resolved = expectResolved(resolveHookFile(projectDir, "tasks", "after", opts()));
    expect(resolved.file).toBe(file);
    expect(resolved.mode).toBe("module-ts");
  });

  it("project .hook.ts beats global .hook.mjs (precedence is level-first, not mode-first)", () => {
    const tsFile = writeTsHook("tasks.after.hook.ts");
    const globalDir = join(home, ".vibeflow", "hooks");
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, "tasks.after.hook.mjs"), `export default () => ({});\n`);
    const resolved = expectResolved(resolveHookFile(projectDir, "tasks", "after", opts()));
    expect(resolved.file).toBe(tsFile);
    expect(resolved.root).toBe("project");
    expect(resolved.mode).toBe("module-ts");
  });

  it("any two executables at one level conflict: mjs+ts, ts+mts", () => {
    const dir = join(projectDir, ".vibeflow-hooks");
    mkdirSync(dir, { recursive: true });
    const stdioFile = join(dir, "tasks.after.mjs");
    const mjsFile = join(dir, "tasks.after.hook.mjs");
    writeFileSync(stdioFile, `// stdio\n`);
    writeFileSync(mjsFile, `export default () => ({});\n`);
    const pair = resolveHookFile(projectDir, "tasks", "after", opts());
    expect(isHookConflict(pair)).toBe(true);
    if (!isHookConflict(pair)) throw new Error("expected conflict");
    expect(pair.files).toEqual([stdioFile, mjsFile]);
  });

  it("a .hook.ts peer does not shadow a refused bare .ts (refusal wins by absence)", () => {
    const dir = join(projectDir, ".vibeflow-hooks");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "tasks.after.ts"), `// wrong extension\n`);
    const hookFile = writeTsHook("tasks.after.hook.ts");
    const resolved = expectResolved(resolveHookFile(projectDir, "tasks", "after", opts()));
    expect(resolved.file).toBe(hookFile);
    expect(resolved.mode).toBe("module-ts");
    expect(refusedSibling(dir, "tasks", "after")).toBe(join(dir, "tasks.after.ts"));
  });
});

describe("parseHookFileName (grammar unit)", () => {
  it("parses all four executable suffixes with tool + phase", () => {
    expect(parseHookFileName("tasks.after.mjs")).toEqual({
      tool: "tasks",
      phase: "after",
      executable: true,
      mode: "stdio",
    });
    expect(parseHookFileName("auth.login.before.hook.mjs")).toEqual({
      tool: "auth.login",
      phase: "before",
      executable: true,
      mode: "module",
    });
    expect(parseHookFileName("create_task.after.hook.ts")).toEqual({
      tool: "create_task",
      phase: "after",
      executable: true,
      mode: "module-ts",
    });
    expect(parseHookFileName("verify.before.hook.mts")).toEqual({
      tool: "verify",
      phase: "before",
      executable: true,
      mode: "module-ts",
    });
  });

  it("marks refused suffixes non-executable and ignores non-hook names", () => {
    expect(parseHookFileName("tasks.after.js")?.executable).toBe(false);
    expect(parseHookFileName("tasks.before.cjs")?.executable).toBe(false);
    expect(parseHookFileName("tasks.after.ts")?.executable).toBe(false);
    expect(parseHookFileName("trust.json")).toBeNull();
    expect(parseHookFileName("bypass-audit.log")).toBeNull();
  });
});
