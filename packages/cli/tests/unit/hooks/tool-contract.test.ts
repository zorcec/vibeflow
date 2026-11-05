/**
 * Tool naming contract (ADR-0007, T1): the registry covers every CLI
 * command path and every MCP tool, the filename grammar is total, and
 * the shipped default set is exactly the activity-bearing after keys.
 *
 * Failure markers (a test that survives its marker is not accepted):
 * - delete one HOOK_TOOLS row → the registry tests name the missing key;
 * - rename `auth.login` to `auth.after` → the grammar test fails.
 */
import { describe, it, expect, beforeAll } from "vitest";
import type { Command } from "commander";
import { manifest } from "../../../src/mcp/manifest.js";
import {
  HOOK_TOOLS,
  canonicalHookTool,
  findHookTool,
  type HookToolSpec,
} from "../../../src/core/hooks/tools.js";
import {
  hookFileName,
  parseHookFileName,
} from "../../../src/core/hooks/discover.js";

let createProgram: () => Command;

/** Depth-first walk of the commander tree (same pattern as drift.test.ts). */
function walkCommands(
  program: Command,
  visit: (path: string, cmd: Command) => void,
): void {
  const walk = (cmd: Command, path: string): void => {
    visit(path, cmd);
    for (const sub of cmd.commands) walk(sub, `${path} ${sub.name()}`);
  };
  for (const top of program.commands) walk(top, top.name());
}

function cliPaths(): Map<string, { hidden: boolean; hasAction: boolean }> {
  const program = createProgram();
  const out = new Map<string, { hidden: boolean; hasAction: boolean }>();
  walkCommands(program, (path, cmd) => {
    // Commander stores the action as an internal listener; presence is
    // observable via the private `_actionHandler`. A container node
    // (`authors`) registers no action of its own.
    const internals = cmd as unknown as { _actionHandler?: unknown; _hidden?: boolean };
    const hasAction = internals._actionHandler != null;
    out.set(path, { hidden: internals._hidden === true, hasAction });
  });
  return out;
}

describe("tool registry vs the commander tree", () => {
  let paths: Map<string, { hidden: boolean; hasAction: boolean }>;

  beforeAll(async () => {
    process.env.VIBEFLOW_CLI_SKIP_PARSE = "1";
    process.env.VIBEFLOW_CLI_SKIP_REFRESH = "1";
    try {
      ({ createProgram } = await import("../../../src/index.js"));
    } finally {
      delete process.env.VIBEFLOW_CLI_SKIP_PARSE;
      delete process.env.VIBEFLOW_CLI_SKIP_REFRESH;
    }
    paths = cliPaths();
  });

  it("every command path except help is a registry row, a hidden alias, or a container", () => {
    const missing: string[] = [];
    const dotted = (path: string): string => path.split(" ").join(".");
    for (const [path, info] of paths) {
      if (path === "help") continue;
      const key = dotted(path);
      const row = findHookTool(key, "cli");
      if (row) continue;
      // Hidden spellings resolve via aliases (login/logout/status).
      const canonical = canonicalHookTool(key.split(".").pop() as string);
      if (canonical !== (key.split(".").pop() as string) && findHookTool(canonical, "cli")) continue;
      // A container node has subcommands and no action of its own.
      if (!info.hasAction) {
        const containerRow = HOOK_TOOLS.find((s) => s.tool === key && s.surface === "cli");
        if (
          containerRow?.before.status === "unsupported" &&
          containerRow?.after.status === "unsupported"
        )
          continue;
      }
      missing.push(path);
    }
    expect(missing).toEqual([]);
  });

  it("every registry CLI row names a real command path, canonical key, or hidden alias", () => {
    const phantom: string[] = [];
    const dotted = new Set(
      [...paths.keys()].filter((p) => p !== "help").map((p) => p.split(" ").join(".")),
    );
    for (const spec of HOOK_TOOLS.filter((s) => s.surface === "cli")) {
      if (spec.before.status === "unsupported" && spec.after.status === "unsupported") {
        // Containers must still name a real node.
        if (!dotted.has(spec.tool)) phantom.push(spec.tool);
        continue;
      }
      if (dotted.has(spec.tool)) continue;
      // A bare alias name (login/logout/status) resolves to its canonical key.
      const aliasHit = (spec.aliases ?? []).some((a) => dotted.has(a));
      if (aliasHit) continue;
      phantom.push(spec.tool);
    }
    expect(phantom).toEqual([]);
  });

  it("hidden aliases resolve to their canonical key", () => {
    expect(canonicalHookTool("login")).toBe("auth.login");
    expect(canonicalHookTool("logout")).toBe("auth.logout");
    expect(canonicalHookTool("status")).toBe("auth.status");
    expect(canonicalHookTool("tasks")).toBe("tasks");
  });

  it("before/after cells are exhaustive and consistent", () => {
    const problems: string[] = [];
    for (const spec of HOOK_TOOLS) {
      for (const phase of ["before", "after"] as const) {
        const cell = spec[phase];
        if (cell.status === "supported" && cell.activities.length === 0 && phase === "before") {
          problems.push(`${spec.surface}:${spec.tool}.${phase}: supported before with no activities`);
        }
      }
      // A supported before cell must cover ≥1 activity (a gate needs something to gate).
      if (spec.before.status === "supported" && spec.before.activities.length === 0) {
        problems.push(`${spec.surface}:${spec.tool}: empty before activities`);
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("tool registry vs the MCP manifest (13 tools)", () => {
  it("the manifest is the source of truth: 13 tools", () => {
    expect(manifest.map((t) => t.name).sort()).toEqual(
      [
        "add_comment",
        "attach_file",
        "claim_next_task",
        "create_task",
        "get_file",
        "get_integration_guide",
        "get_project",
        "get_task",
        "list_tasks",
        "pull",
        "start_kanban",
        "update_task",
        "verify_task",
      ].sort(),
    );
  });

  it("every manifest tool has a registry row; no phantom MCP rows", () => {
    const missing = manifest
      .map((t) => t.name)
      .filter((name) => !findHookTool(name, "mcp"));
    expect(missing).toEqual([]);
    const names = new Set(manifest.map((t) => t.name));
    const phantom = HOOK_TOOLS.filter((s) => s.surface === "mcp" && !names.has(s.tool)).map(
      (s) => s.tool,
    );
    expect(phantom).toEqual([]);
  });

  it("every manifest tool that performs an activity has a supported before cell", () => {
    const activityTools = ["create_task", "update_task", "claim_next_task", "add_comment", "verify_task", "pull"];
    for (const name of activityTools) {
      const row = findHookTool(name, "mcp");
      expect(row?.before.status, name).toBe("supported");
      expect(row?.after.status, name).toBe("supported");
    }
    const readTools = ["list_tasks", "get_task", "get_file", "attach_file", "get_project", "start_kanban", "get_integration_guide"];
    for (const name of readTools) {
      const row = findHookTool(name, "mcp");
      expect(row?.before.status, name).toBe("unsupported");
      expect(row?.after.status, name).toBe("supported");
    }
  });
});

describe("filename grammar (§3)", () => {
  it("hookFileName round-trips through the parser for every key × phase × mode", () => {
    const failures: string[] = [];
    const modes = ["stdio", "module", "module-ts"] as const;
    for (const spec of HOOK_TOOLS) {
      for (const phase of ["before", "after"] as const) {
        for (const mode of modes) {
          if (mode === "module-ts") {
            for (const suffix of [".hook.mts", ".hook.ts"]) {
              const name = `${spec.tool}.${phase}${suffix}`;
              const parsed = parseHookFileName(name);
              if (!parsed || parsed.tool !== spec.tool || parsed.phase !== phase || !parsed.executable || parsed.mode !== "module-ts") {
                failures.push(name);
              }
            }
            continue;
          }
          const name = hookFileName(spec.tool, phase, mode);
          const parsed = parseHookFileName(name);
          if (!parsed || parsed.tool !== spec.tool || parsed.phase !== phase || !parsed.executable || parsed.mode !== mode) {
            failures.push(name);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("no registry tool contains a before/after segment (phase is the parse anchor)", () => {
    const bad = HOOK_TOOLS.filter((s) =>
      s.tool.split(".").some((segment) => segment === "before" || segment === "after"),
    ).map((s) => s.tool);
    expect(bad).toEqual([]);
  });

  it("refused suffixes parse as non-executable (never silently runnable)", () => {
    for (const rest of ["js", "cjs", "ts", "mts"] as const) {
      for (const phase of ["before", "after"] as const) {
        const parsed = parseHookFileName(`tasks.${phase}.${rest}`);
        expect(parsed, `tasks.${phase}.${rest}`).not.toBeNull();
        expect(parsed?.executable).toBe(false);
      }
    }
  });

  it("non-hook files do not parse (trust.json, audit log, config)", () => {
    for (const name of ["trust.json", "bypass-audit.log", "tasks.after.config.json", "README.md", "after-task.update.mjs"]) {
      expect(parseHookFileName(name), name).toBeNull();
    }
  });
});

describe("shipped default set (D10)", () => {
  it("is exactly the activity-bearing after keys (9 files)", () => {
    // `pull` is ONE key shared by two surfaces (one file, no fallback).
    const tools = [
      ...new Set(
        HOOK_TOOLS.filter(
          (s) => s.after.status === "supported" && s.after.activities.length > 0,
        ).map((s) => s.tool),
      ),
    ];
    const keys = tools.map((tool) => `${tool}.after.mjs`).sort();
    expect(keys).toEqual(
      [
        "add_comment.after.mjs",
        "claim_next_task.after.mjs",
        "create_task.after.mjs",
        "pull.after.mjs",
        "push.after.mjs",
        "tasks.after.mjs",
        "update_task.after.mjs",
        "verify.after.mjs",
        "verify_task.after.mjs",
      ].sort(),
    );
    // One CLI row + one MCP row share `pull` (per-surface defaults, no fallback).
    const pullRows = HOOK_TOOLS.filter(
      (s) => s.tool === "pull" && s.after.status === "supported" && s.after.activities.length > 0,
    );
    expect(pullRows.map((s) => s.surface).sort()).toEqual(["cli", "mcp"]);
  });

  it("the committed defaults tree matches the contract (no .before defaults)", async () => {
    const { readdirSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const defaultsDir = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "..",
      "src",
      "core",
      "hooks",
      "defaults",
    );
    const onDisk = readdirSync(defaultsDir).filter((f) => f !== "VERSION").sort();
    expect(onDisk.filter((f) => f.includes(".before."))).toEqual([]);
    const expected = [
      ...new Set(
        HOOK_TOOLS.filter(
          (s) => s.after.status === "supported" && s.after.activities.length > 0,
        ).map((s: HookToolSpec) => `${s.tool}.after.mjs`),
      ),
    ].sort();
    // Marker: add a gated tool without a default → this names it.
    expect(onDisk).toEqual(expected);
  });
});
