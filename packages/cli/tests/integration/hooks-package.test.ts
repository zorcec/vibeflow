/**
 * Installed-package contract (ADR-0007, T6): the module-hook loader, the
 * `@vibeflow-tools/cli/hooks` types, and the in-package shipped defaults
 * must survive packaging.
 *
 * Local source tests can all pass while a published binary lacks its loader
 * or declarations, so this file installs the real tarball into a fresh
 * project OUTSIDE the workspace (Node >= 22) and proves, against the
 * installed tree — never workspace symlinks or `src/` paths:
 * - the tarball contains the loader (both layouts) + `hooks.d.ts`;
 * - no shipped declaration references source;
 * - a `tsc --noEmit` JS/TS consumer resolves the subpath, narrows
 *   event/payload, and rejects bad events/phases/results;
 * - both CLI entry layouts execute a module hook whose path carries
 *   spaces, Unicode, `#`, `%`, and `?`, returning its instruction as
 *   exactly one JSON document.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureTaskDirs } from "../../src/core/tasks.js";
// Child env for CLI spawns flows through the isolation chokepoint
// (ticket 8ac96ef9) — never a hand-rolled spread.
import { isolatedCliEnv } from "../e2e/spawn-isolated.js";

const CLI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSC_BIN = join(CLI_ROOT, "node_modules", ".bin", "tsc");

/** Fresh temp install root — /tmp is outside the workspace by construction. */
let installRoot: string;
let pkgDir: string;
let tarball: string;

/** Local build-tool invocation (npm pack, tsc) — field-by-field copy, no spread. */
function sh(cmd: string, args: string[], cwd: string, extraEnv: Record<string, string> = {}): string {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) env[key] = value;
  for (const [key, value] of Object.entries(extraEnv)) env[key] = value;
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf-8",
    timeout: 120_000,
    env,
  });
}

interface Spawned {
  code: number | null;
  stdout: string;
  stderr: string;
}

function spawnCli(entry: string, args: string[], cwd: string, home: string): Spawned {
  const child = spawnSync(process.execPath, [entry, ...args], {
    cwd,
    env: isolatedCliEnv({
      home,
      cwd,
      env: { VIBEFLOW_HOOKS: "1", VIBEFLOW_TRUST_HOOKS: "1" },
    }),
    encoding: "utf-8",
    timeout: 30_000,
  });
  return {
    code: child.status,
    stdout: String(child.stdout ?? ""),
    stderr: String(child.stderr ?? ""),
  };
}

function writeModuleHook(projectDir: string, instructions: string): void {
  const dir = join(projectDir, ".vibeflow-hooks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "tasks.after.hook.mjs"),
    `export default async (envelope) => ({ instructions: ${JSON.stringify(instructions)} + envelope.activity });\n`,
  );
}

function writeStdioHook(projectDir: string, instructions: string): void {
  const dir = join(projectDir, ".vibeflow-hooks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "tasks.after.mjs"),
    `let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{process.stdout.write(JSON.stringify({instructions:${JSON.stringify(instructions)}}));});\n`,
  );
}

function writeTsHook(projectDir: string, instructions: string): void {
  const dir = join(projectDir, ".vibeflow-hooks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "tasks.after.hook.ts"),
    `export default async (envelope: { activity: unknown }): Promise<{ instructions: string }> => ({ instructions: ${JSON.stringify(instructions)} });\n`,
  );
}

function editTask(entry: string, projectDir: string, home: string): unknown {
  const added = spawnCli(entry, ["tasks", "--add", "--title", "pkg hook task", "--json"], projectDir, home);
  expect(added.code).toBe(0);
  const id = (JSON.parse(added.stdout) as { task: { id: string } }).task.id;
  const edited = spawnCli(
    entry,
    ["tasks", "--edit", id, "--set-status", "in-progress", "--json"],
    projectDir,
    home,
  );
  expect(edited.code).toBe(0);
  // Exactly ONE JSON document on stdout — byte-clean for piping.
  return JSON.parse(edited.stdout);
}

beforeAll(() => {
  expect(process.version).toMatch(/^v(2[2-9]|[3-9]\d)/);
  expect(existsSync(TSC_BIN)).toBe(true);
  installRoot = mkdtempSync(join(tmpdir(), "hook-pkg-install-"));
  // Paranoia: the install root must not resolve inside the workspace.
  expect(resolve(installRoot).startsWith(resolve(CLI_ROOT))).toBe(false);
  const packed = sh("npm", ["pack", "--pack-destination", installRoot], CLI_ROOT);
  const tgz = packed.trim().split("\n").pop() as string;
  tarball = join(installRoot, tgz);
  expect(existsSync(tarball)).toBe(true);
  const proj = join(installRoot, "consumer-proj");
  mkdirSync(proj, { recursive: true });
  writeFileSync(
    join(proj, "package.json"),
    JSON.stringify({ name: "hook-pkg-consumer", type: "module", version: "0.0.0" }),
  );
  sh("npm", ["install", "--no-audit", "--no-fund", tarball], proj);
  pkgDir = join(proj, "node_modules", "@vibeflow-tools", "cli");
  expect(existsSync(join(pkgDir, "dist", "index.js"))).toBe(true);
}, 120_000);

afterAll(() => {
  if (installRoot) rmSync(installRoot, { recursive: true, force: true });
});

describe("hooks-package", () => {
  it("tarball ships the loader (both layouts) + hooks.d.ts + dist/hooks/defaults and no src/", () => {
    const out = sh("npm", ["pack", "--dry-run", "--json"], CLI_ROOT);
    const [summary] = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
    const paths = summary.files.map((f) => f.path);
    expect(paths).toContain("dist/hook-loader.mjs");
    expect(paths).toContain("dist/cli/hook-loader.mjs");
    expect(paths).toContain("dist/hooks.d.ts");
    // In-package shipped defaults (ADR-0007 D10): exactly the 9
    // activity-bearing after files + VERSION, read in place. Marker:
    // remove "dist/hooks/" from files and the shipped-default run below
    // fails with HOOK_SHIPPED_DEFAULTS_MISSING.
    expect(paths).toContain("dist/hooks/defaults/VERSION");
    for (const file of [
      "tasks.after.mjs",
      "update_task.after.mjs",
      "claim_next_task.after.mjs",
      "add_comment.after.mjs",
      "verify.after.mjs",
      "verify_task.after.mjs",
      "push.after.mjs",
      "pull.after.mjs",
      "create_task.after.mjs",
    ]) {
      expect(paths).toContain(`dist/hooks/defaults/${file}`);
    }
    expect(paths.filter((p) => p.startsWith("src/"))).toEqual([]);
  });

  it("installed declarations resolve from the package, not source", () => {
    const dts = readFileSync(join(pkgDir, "dist", "hooks.d.ts"), "utf-8");
    expect(dts).toContain("HookAfterHandler");
    expect(dts).toContain("HookAfterResult");
    expect(dts).toContain("HookAfterEnvelope");
    expect(dts).not.toContain("src/core/hooks");
    expect(dts).not.toContain("../src");
    expect(dts).not.toContain("packages/cli/src");
    // Self-contained: no relative type import escapes into any source tree.
    expect(dts).not.toMatch(/from\s+["']\.\./);
    expect(dts).not.toMatch(/import\(["']\.\./);
    // The subpath export exists and is types-only (no runtime entry).
    const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8")) as {
      exports: Record<string, unknown>;
    };
    expect(manifest.exports["./hooks"]).toEqual({ types: "./dist/hooks.d.ts" });
    // No runtime entry for ./hooks anywhere: not in exports, not in bin.
    expect(JSON.stringify(manifest.exports)).not.toContain("hooks.js");
    const bin = (manifest as { bin?: Record<string, string> }).bin ?? {};
    expect(Object.values(bin).some((v) => v.includes("hooks"))).toBe(false);
  });

  it("tsc resolves @vibeflow-tools/cli/hooks: narrowing holds, bad shapes fail", () => {
    const proj = join(installRoot, "consumer-proj");
    writeFileSync(
      join(proj, "consumer.ts"),
      `import type {\n` +
        `  HookAfterEnvelope,\n` +
        `  HookAfterHandler,\n` +
        `  HookConfirmedPayloads,\n` +
        `  HookAfterResult,\n` +
        `  HookEnvelope,\n` +
        `  HookActivity,\n` +
        `} from "@vibeflow-tools/cli/hooks";\n` +
        `\n` +
        `export function taskIdOf(envelope: HookAfterEnvelope<"task.update">): string {\n` +
        `  const id: string = envelope.payload.taskId;\n` +
        `  const changed: string[] = envelope.payload.changed;\n` +
        `  void changed;\n` +
        `  return id;\n` +
        `}\n` +
        `\n` +
        `export function commentOf(union: HookEnvelope): string | null {\n` +
        `  if (union.activity === "task.comment") {\n` +
        `    return union.payload.commentId;\n` +
        `  }\n` +
        `  return null;\n` +
        `}\n` +
        `\n` +
        `export const claimHandler: HookAfterHandler<"task.claim"> = async (envelope) => {\n` +
        `  const from: string = envelope.payload.from;\n` +
        `  void from;\n` +
        `  return { instructions: "claimed" };\n` +
        `};\n` +
        `\n` +
        `export const noop: HookAfterResult = {};\n` +
        `\n` +
        `export function touchTypes(payloads: HookConfirmedPayloads, event: HookActivity): void {\n` +
        `  void payloads;\n` +
        `  void event;\n` +
        `}\n` +
        `\n` +
        `// @ts-expect-error unknown activities are not hook activities\n` +
        `export type BadActivity = HookAfterEnvelope<"task.frobnicate">;\n` +
        `\n` +
        `export const badResult: HookAfterResult = {\n` +
        `  // @ts-expect-error instructions must be a string\n` +
        `  instructions: 42,\n` +
        `};\n` +
        `\n` +
        `export const extraResult: HookAfterResult = {\n` +
        `  instructions: "x",\n` +
        `  // @ts-expect-error extra keys are rejected at runtime\n` +
        `  extra: 1,\n` +
        `};\n` +
        `\n` +
        `export function prePhaseImpossible(envelope: HookAfterEnvelope<"task.update">): void {\n` +
        `  // @ts-expect-error phase is after-only\n` +
        `  const phase: "before" = envelope.phase;\n` +
        `  void phase;\n` +
        `}\n` +
        `\n` +
        `export function noCommentOnUpdate(envelope: HookAfterEnvelope<"task.update">): void {\n` +
        `  // @ts-expect-error task.update payloads have no commentId\n` +
        `  const id: string = envelope.payload.commentId;\n` +
        `  void id;\n` +
        `}\n`,
    );
    writeFileSync(
      join(proj, "consumer.js"),
      `// @ts-check\n` +
        `/** @type {import('@vibeflow-tools/cli/hooks').HookAfterHandler<'task.update'>} */\n` +
        `export default async (envelope) => {\n` +
        `  return { instructions: \`saw \${envelope.activity} (\${envelope.payload.taskId})\` };\n` +
        `};\n`,
    );
    // Unused @ts-expect-error directives fail the run — the negatives are real.
    sh(
      TSC_BIN,
      [
        "--noEmit",
        "--strict",
        "--target",
        "es2022",
        "--module",
        "nodenext",
        "--moduleResolution",
        "nodenext",
        "--allowJs",
        "--checkJs",
        join(proj, "consumer.ts"),
        join(proj, "consumer.js"),
      ],
      proj,
    );
  });

  it("installed dist/index.js executes a project stdio hook (special-char path)", () => {
    const projectDir = join(installRoot, "proj stdio señor #1?%");
    mkdirSync(projectDir, { recursive: true });
    ensureTaskDirs(projectDir);
    const home = mkdtempSync(join(tmpdir(), "hook-pkg-home-"));
    writeStdioHook(projectDir, "installed-stdio:");
    const doc = editTask(join(pkgDir, "dist", "index.js"), projectDir, home) as {
      ok: boolean;
      instructions?: string[];
    };
    expect(doc.ok).toBe(true);
    expect(doc.instructions).toEqual(["installed-stdio:"]);
    rmSync(home, { recursive: true, force: true });
  });

  it("installed dist/index.js executes a project module-ts hook (special-char path)", () => {
    const projectDir = join(installRoot, "proj ts señor #2?%");
    mkdirSync(projectDir, { recursive: true });
    ensureTaskDirs(projectDir);
    const home = mkdtempSync(join(tmpdir(), "hook-pkg-ts-home-"));
    writeTsHook(projectDir, "installed-ts:");
    const doc = editTask(join(pkgDir, "dist", "index.js"), projectDir, home) as {
      ok: boolean;
      instructions?: string[];
    };
    expect(doc.ok).toBe(true);
    expect(doc.instructions).toEqual(["installed-ts:"]);
    rmSync(home, { recursive: true, force: true });
  });

  it("installed dist/index.js falls back to the SHIPPED tasks.after.mjs (no project/global file)", () => {
    // Genuine installed-layout proof: the shipped default runs from the
    // installed tree with nothing overriding it — the unconditional
    // update text rides the document.
    const projectDir = join(installRoot, "proj shipped-default");
    mkdirSync(projectDir, { recursive: true });
    ensureTaskDirs(projectDir);
    const home = mkdtempSync(join(tmpdir(), "hook-pkg-shipped-home-"));
    const doc = editTask(join(pkgDir, "dist", "index.js"), projectDir, home) as {
      ok: boolean;
      instructions?: string[];
    };
    expect(doc.ok).toBe(true);
    expect(doc.instructions?.join("\n")).toContain('NEVER set a task status to "done"');
    rmSync(home, { recursive: true, force: true });
  });

  it("installed dist/index.js executes a module hook (special-char path)", () => {
    const projectDir = join(installRoot, "proj with spaces señor #1?%");
    mkdirSync(projectDir, { recursive: true });
    ensureTaskDirs(projectDir);
    const home = mkdtempSync(join(tmpdir(), "hook-pkg-home-"));
    writeModuleHook(projectDir, "installed:");
    const doc = editTask(join(pkgDir, "dist", "index.js"), projectDir, home) as {
      ok: boolean;
      instructions?: string[];
    };
    expect(doc.ok).toBe(true);
    expect(doc.instructions).toEqual(["installed:task.update"]);
    rmSync(home, { recursive: true, force: true });
  });

  it("dist/cli/index.js layout resolves its sibling loader", () => {
    // The alternate packaged layout (dev dist tree): the runner resolves
    // ./hook-loader.mjs from the executing bundle's own location.
    const repoCliEntry = join(CLI_ROOT, "dist", "cli", "index.js");
    expect(existsSync(repoCliEntry)).toBe(true);
    expect(existsSync(join(CLI_ROOT, "dist", "cli", "hook-loader.mjs"))).toBe(true);
    const projectDir = mkdtempSync(join(tmpdir(), "hook-pkg-cli-proj-"));
    ensureTaskDirs(projectDir);
    const home = mkdtempSync(join(tmpdir(), "hook-pkg-cli-home-"));
    try {
      writeModuleHook(projectDir, "cli-layout:");
      const doc = editTask(repoCliEntry, projectDir, home) as {
        ok: boolean;
        instructions?: string[];
      };
      expect(doc.ok).toBe(true);
      expect(doc.instructions).toEqual(["cli-layout:task.update"]);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
