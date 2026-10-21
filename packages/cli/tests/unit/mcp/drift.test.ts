/**
 * MCP Drift Test
 *
 * Ensures CLI commands and flags are properly mapped to MCP tools.
 * Fails if a new CLI flag is added without a corresponding MCP tool.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import {
  manifest,
  intentionallyNotExposed,
  mcpOnlyFields,
} from "../../../src/mcp/manifest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const srcRoot = join(__dirname, "../../../src");

let createProgram: () => Command;

/** MCP input field -> CLI flag spelling: taskId -> --task-id, sortKey -> --sort-key. */
const dashedField = (field: string) =>
  "--" + field.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

/**
 * Depth-first walk of the whole commander tree, including subcommands.
 * The path is space-joined (`"auth login"`), the same key format
 * intentionallyNotExposed.commands uses for nested commands.
 */
function walkCommands(
  program: Command,
  visit: (path: string, cmd: Command) => void,
): void {
  const walk = (cmd: Command, path: string) => {
    visit(path, cmd);
    for (const sub of cmd.commands) walk(sub, `${path} ${sub.name()}`);
  };
  for (const top of program.commands) walk(top, top.name());
}

/** Resolve a space-joined command path ("auth login") against the tree. */
function resolveCommand(program: Command, path: string): Command | undefined {
  let current: Command | undefined = program;
  for (const segment of path.split(" ")) {
    current = current?.commands.find((c) => c.name() === segment);
  }
  return current;
}

describe("MCP drift test", () => {
  beforeAll(async () => {
    // Import src/index.ts for the commander tree without running the CLI or
    // touching the network (entry guards in src/index.ts). Removed right
    // after import: the guards evaluate at import time, and any CLI spawned
    // from this process must parse normally.
    process.env.VIBEFLOW_CLI_SKIP_PARSE = "1";
    process.env.VIBEFLOW_CLI_SKIP_REFRESH = "1";
    try {
      ({ createProgram } = await import("../../../src/index.js"));
    } finally {
      delete process.env.VIBEFLOW_CLI_SKIP_PARSE;
      delete process.env.VIBEFLOW_CLI_SKIP_REFRESH;
    }
  });

  it("every tool in manifest has required fields", () => {
    for (const tool of manifest) {
      expect(tool.name).toBeTruthy();
      expect(tool.title).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.cliRef).toBeDefined();
      expect(tool.cliRef.command).toBeTruthy();
      expect(tool.cliRef.flags).toBeInstanceOf(Array);
      expect(tool.category).toBeTruthy();
      expect(tool.annotations).toBeDefined();
      expect(typeof tool.annotations.readOnlyHint).toBe("boolean");
      expect(typeof tool.annotations.destructiveHint).toBe("boolean");
      expect(typeof tool.annotations.idempotentHint).toBe("boolean");
      expect(typeof tool.annotations.openWorldHint).toBe("boolean");
      expect(tool.input).toBeDefined();
      expect(typeof tool.run).toBe("function");
    }
  });

  it("tool names are unique", () => {
    const names = manifest.map((m) => m.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  it("all 12 MCP tools are registered", () => {
    // Ticket 53b622fc: export_prompt was REMOVED (breaking) — 12 became 11.
    // get_task covers the single-task read, `vibeflow tasks --get` the render.
    // `pull` (board → local additive sync) brings the count back to 12.
    const expectedTools = [
      "add_comment",
      "attach_file",
      "claim_next_task",
      "create_task",
      "get_integration_guide",
      "get_project",
      "get_task",
      "list_tasks",
      "pull",
      "start_kanban",
      "update_task",
      "verify_task",
    ];
    const actualTools = manifest.map((m) => m.name).sort();
    expect(actualTools).toEqual(expectedTools);
  });

  it("read-only tools have readOnlyHint=true", () => {
    const readOnlyTools = [
      "list_tasks",
      "get_task",
      "get_project",
      "get_integration_guide",
    ];
    for (const tool of manifest) {
      if (readOnlyTools.includes(tool.name)) {
        expect(tool.annotations.readOnlyHint).toBe(true);
      }
    }
  });

  it("no tool is destructive — push_tasks (the only destructiveHint tool) is gone", () => {
    const destructive = manifest.filter((t) => t.annotations.destructiveHint);
    expect(destructive.map((t) => t.name)).toEqual([]);
  });

  it("push and the deprecated aliases stay hidden; auth is the visible canonical spelling", () => {
    // push_tasks is gone from the MCP surface and push is classified as
    // deliberately unexposed — the online sync stays available via hidden CLI
    // push, exactly as the intentionallyNotExposed reason states.
    // Ticket b3b1ee24: `vibeflow auth {login,logout,status}` is the canonical
    // user-facing spelling (visible in help); bare login/logout/status stay
    // as hidden deprecated aliases that print a redirect notice.
    expect(manifest.some((m) => m.name === "push_tasks")).toBe(false);
    expect(manifest.some((m) => m.cliRef.command === "push")).toBe(false);
    expect(intentionallyNotExposed.commands.push).toBeTruthy();
    const program = createProgram();
    // The deprecated aliases still exist in the commander tree ...
    for (const name of ["login", "logout", "status", "push"]) {
      const cmd = program.commands.find((c) => c.name() === name);
      expect(cmd, `hidden CLI command "${name}" went missing`).toBeDefined();
      // ... but render nothing in top-level help (commander v12: _hidden).
      expect(
        (cmd as unknown as { _hidden?: boolean })._hidden,
        `"${name}" is no longer hidden`,
      ).toBe(true);
    }
    // ... while `auth` itself is visible with its login/logout/status group.
    const auth = program.commands.find((c) => c.name() === "auth");
    expect(auth, 'CLI command "auth" went missing').toBeDefined();
    expect(
      (auth as unknown as { _hidden?: boolean })._hidden ?? false,
      '"auth" should be visible (canonical online-auth spelling)',
    ).toBe(false);
    for (const sub of ["login", "logout", "status"]) {
      expect(
        auth!.commands.some((c) => c.name() === sub),
        `"vibeflow auth ${sub}" went missing`,
      ).toBe(true);
    }
  });

  it("cliRef flags are non-empty for tasks command tools", () => {
    const tasksTools = manifest.filter((m) => m.cliRef.command === "tasks");
    for (const tool of tasksTools) {
      expect(tool.cliRef.flags.length).toBeGreaterThan(0);
    }
  });

  it("snapshot of tool names matches fixture", () => {
    const toolNames = manifest.map((m) => m.name).sort();
    expect(toolNames).toMatchSnapshot();
  });

  it("all input schemas are zod raw shapes", () => {
    for (const tool of manifest) {
      // ZodRawShape is a plain object of { key: ZodType }
      expect(tool.input).toBeDefined();
      expect(typeof tool.input).toBe("object");
      for (const val of Object.values(tool.input)) {
        expect(typeof (val as { parse?: unknown }).parse).toBe("function");
      }
    }
  });

  it("operations layer lives in core, not mcp (spec §1)", () => {
    expect(existsSync(join(srcRoot, "core", "operations.ts"))).toBe(true);
    expect(existsSync(join(srcRoot, "mcp", "operations.ts"))).toBe(false);
  });

  it("mcp modules do not implement task logic themselves", () => {
    for (const f of ["manifest.ts", "server.ts", "http.ts"]) {
      const src = readFileSync(join(srcRoot, "mcp", f), "utf-8");
      expect(src).not.toMatch(/writeFileSync|mkdirSync\(/);
    }
  });

  it("G4 — mcp modules never parse argv or import commander", () => {
    // readdir, not a hard-coded list: a NEW file dropped into src/mcp/ is
    // scanned automatically. The MCP layer is a sibling of the CLI, never a
    // second argv-driven surface (plan §3).
    const mcpDir = join(srcRoot, "mcp");
    const files = readdirSync(mcpDir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThanOrEqual(4);
    for (const f of files) {
      const src = readFileSync(join(mcpDir, f), "utf-8");
      expect(
        src,
        `src/mcp/${f} must not import commander or read process.argv`,
      ).not.toMatch(/from "commander"|process\.argv/);
    }
  });

  it("G4 — every tool's run body calls a function imported from core/operations", () => {
    // The manifest is the only bridge: each `run:` wrapper must delegate to
    // a named import from ../core/operations.js — never to a local helper,
    // the CLI module, or an argv-driven path.
    const manifestSrc = readFileSync(join(srcRoot, "mcp", "manifest.ts"), "utf-8");
    const importBlock = manifestSrc.match(
      /import \{([\s\S]*?)\} from "\.\.\/core\/operations\.js";/,
    );
    expect(importBlock, "manifest.ts must import from ../core/operations.js").toBeTruthy();
    const imported = new Set(
      [...importBlock![1].matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map((m) => m[1]),
    );
    const runCalls = [
      ...manifestSrc.matchAll(/run:\s*\(ctx, input\)\s*=>\s*([A-Za-z_$][\w$]*)\(/g),
    ].map((m) => m[1]);
    // Shape guard: if the `run:` shape changes, the regex finds nothing —
    // fail loudly instead of passing vacuously.
    expect(runCalls.length, "no `run: (ctx, input) => fn(...)` bodies matched").toBe(
      manifest.length,
    );
    for (const fn of runCalls) {
      expect(
        imported.has(fn),
        `tool run body calls \`${fn}\`, which is not imported from core/operations.ts`,
      ).toBe(true);
    }
  });

  it("the CLI program is introspectable without executing a command", () => {
    const program = createProgram();
    const names = program.commands.map((c) => c.name()).sort();
    expect(names).toEqual([
      "auth",
      // Local-only enrichment (git author emails). Deliberately NOT an MCP
      // tool: it writes the git-tracked task store, which must stay a
      // deliberate human action, never something an agent triggers remotely.
      "authors",
      "changelog",
      "kanban",
      "login",
      "logout",
      "mcp",
      "openapi",
      // Board → local additive sync (the inverse of hidden push); exposed as
      // the `pull` MCP tool, so it must never be classified as unexposed.
      "pull",
      "push",
      "serve",
      "status",
      "tasks",
      "telemetry",
      "verify",
      "watch",
    ]);
    // A factory, not a singleton — each call builds a fresh tree.
    expect(createProgram()).not.toBe(program);
  });

  it("G1 coverage — every option on every subcommand is owned by a cliRef or explicitly not exposed", () => {
    const program = createProgram();
    // Owned = some tool's cliRef names the flag, scoped to the same command.
    const owned = new Set(
      manifest.flatMap((tool) =>
        tool.cliRef.flags.map((flag) => `${tool.cliRef.command} ${flag}`),
      ),
    );
    const unclassified: string[] = [];
    for (const cmd of program.commands) {
      const command = cmd.name();
      // A wholly-unexposed command is classified as a whole (§6.1).
      if (command in intentionallyNotExposed.commands) continue;
      for (const opt of cmd.options) {
        const flag = opt.long ?? opt.short;
        if (!flag || flag === "--help") continue; // framework artifact
        const key = `${command} ${flag}`;
        if (!owned.has(key) && !(key in intentionallyNotExposed.flags)) {
          unclassified.push(key);
        }
      }
    }
    expect(
      unclassified,
      `unclassified CLI flags — map each to a tool cliRef or give it a reason in intentionallyNotExposed: ${unclassified.join(", ")}`,
    ).toEqual([]);
  });

  it("G1 classification — no stale intentionallyNotExposed entries", () => {
    const program = createProgram();
    for (const key of Object.keys(intentionallyNotExposed.commands)) {
      // Path-resolved: nested commands are keyed "parent child".
      expect(
        resolveCommand(program, key),
        `intentionallyNotExposed.commands lists "${key}", which is not a CLI command`,
      ).toBeDefined();
    }
    for (const key of Object.keys(intentionallyNotExposed.flags)) {
      const sep = key.indexOf(" ");
      const command = key.slice(0, sep);
      const flag = key.slice(sep + 1);
      const cmd = resolveCommand(program, command);
      expect(
        cmd,
        `intentionallyNotExposed.flags key "${key}" names a nonexistent command`,
      ).toBeDefined();
      expect(
        cmd!.options.some((o) => o.long === flag),
        `intentionallyNotExposed.flags key "${key}" names a flag that no longer exists`,
      ).toBe(true);
    }
  });

  it("G1 reverse — every cliRef command exists and every cliRef flag exists on that command", () => {
    const program = createProgram();
    for (const tool of manifest) {
      const cmd = program.commands.find(
        (c) => c.name() === tool.cliRef.command,
      );
      expect(
        cmd,
        `${tool.name}: cliRef.command "${tool.cliRef.command}" is not a CLI command`,
      ).toBeDefined();
      for (const flag of tool.cliRef.flags) {
        // Commander stores `--no-parent` as an option with long ===
        // "--no-parent", and `--get`/`--edit` as long options too, so
        // matching on `long` covers negatable and optional-arg flags.
        expect(
          cmd!.options.some((o) => o.long === flag),
          `${tool.name}: cliRef claims \`${tool.cliRef.command} ${flag}\`, which does not exist on that command`,
        ).toBe(true);
      }
    }
  });

  // ── G1 extension: commands, schema strength, and honest reasons ────────
  //
  // The original G1 coverage check walked only TOP-LEVEL commands and only
  // asked whether each flag was named by some cliRef (or classified). Three
  // blind spots that leaves: a command nobody maps and nobody classifies (as
  // long as its flags happen to be owned), a flag the cliRef names that the
  // tool's INPUT SCHEMA never declares (the name exists, the field does not),
  // and classification entries that say nothing. These three checks close
  // them — the flag one by asserting the schema spells the flag, not merely
  // that a cliRef mentions the command.

  it("G1 commands — every registered command is referenced by a cliRef or classified with a reason", () => {
    const program = createProgram();
    const mapped = new Set(manifest.map((t) => t.cliRef.command));
    const unclassified: string[] = [];
    walkCommands(program, (path) => {
      if (!mapped.has(path) && !(path in intentionallyNotExposed.commands)) {
        unclassified.push(path);
      }
    });
    expect(
      unclassified,
      `CLI commands with no MCP tool and no entry in intentionallyNotExposed.commands — ` +
        `map one via cliRef or give the command an explicit reason: ${unclassified.join(", ")}`,
    ).toEqual([]);
  });

  it("G1 schema — every flag of a mapped command is declared by a tool input schema or classified", () => {
    const program = createProgram();
    const mapped = new Set(manifest.map((t) => t.cliRef.command));
    const uncovered: string[] = [];
    walkCommands(program, (path, cmd) => {
      if (!mapped.has(path)) return; // unmapped commands are covered (or failed) by the check above
      const tools = manifest.filter((t) => t.cliRef.command === path);
      for (const opt of cmd.options) {
        const flag = opt.long ?? opt.short;
        if (!flag || flag === "--help") continue; // framework artifact
        // Covered only when the cliRef names the flag AND the tool's own
        // input schema declares the field that dashes to it — a cliRef that
        // merely mentions the command proves nothing about the schema.
        const schemaDeclares = tools.some(
          (t) =>
            t.cliRef.flags.includes(flag) &&
            Object.keys(t.input).some((field) => dashedField(field) === flag),
        );
        if (schemaDeclares) continue;
        if (`${path} ${flag}` in intentionallyNotExposed.flags) continue;
        uncovered.push(`${path} ${flag}`);
      }
    });
    expect(
      uncovered,
      `CLI flags of mapped commands that no tool input schema declares and no reason covers — ` +
        `add the schema field, or classify the flag in intentionallyNotExposed.flags: ${uncovered.join(", ")}`,
    ).toEqual([]);
  });

  it("G1 reasons — every classification entry carries a substantive reason (no silent catch-all)", () => {
    // An entry without a reason is worse than a missing one: it reads as
    // reviewed when nobody reviewed it. Same bar G5 holds mcpOnlyFields to.
    for (const group of ["commands", "flags"] as const) {
      for (const [key, reason] of Object.entries(
        intentionallyNotExposed[group],
      )) {
        expect(
          (reason ?? "").trim().length,
          `intentionallyNotExposed.${group}["${key}"] has no reason — every entry must state WHY the surface is not schema-mapped`,
        ).toBeGreaterThan(20);
      }
    }
  });

  // ── G5: the reverse direction G1 never asked ───────────────────────────
  //
  // G1 walks the CLI and fails on an unclassified flag. It never asks the
  // opposite question: does every MCP input field correspond to something a
  // CLI user can actually type? That blind spot let `update_task` advertise
  // `--set-parent` (surgical) while its real input was a destructive
  // whole-set `links` replace — the flag names existed, so G1 went green and
  // the semantic divergence shipped.
  //
  // A field is COVERED when, in order:
  //   1. it is structural — `dryRun` (every mutating tool exposes it; the CLI
  //      spells it `--dry-run`), or `id` resolving to a task selector the
  //      tool's own cliRef already names, or a positional task-id argument;
  //   2. a real CLI flag on that command matches its dashed form;
  //   3. some tool's cliRef names that flag;
  //   4. it is classified in `mcpOnlyFields` with a reason.
  // Anything else is a divergence nobody has looked at, and fails.

  it("G5 — every MCP input field maps to a CLI flag or is classified", () => {
    const program = createProgram();

    const commandByName = new Map(program.commands.map((c) => [c.name(), c]));
    const flagsOn = (name: string) =>
      new Set(
        (commandByName.get(name)?.options ?? [])
          .map((o) => o.long ?? o.short)
          .filter(Boolean) as string[],
      );
    const dashed = dashedField;

    const ownedFlags = new Set(
      manifest.flatMap((t) => t.cliRef.flags.map((f) => f)),
    );

    // A tool's `id` is covered when its own cliRef already names a selector
    // (`--get`, `--edit`, `--next`), or its command takes a positional task id.
    const TASK_SELECTORS = new Set(["--get", "--edit", "--next"]);

    const uncovered: string[] = [];
    for (const tool of manifest) {
      const cmdFlags = flagsOn(tool.cliRef.command);
      const positionalTaskId = (
        commandByName.get(tool.cliRef.command)?.registeredArguments ?? []
      ).some((a) => /task|arg/i.test(a.name()));
      const namesSelector = tool.cliRef.flags.some((f) =>
        TASK_SELECTORS.has(f),
      );

      for (const field of Object.keys(tool.input)) {
        const key = `${tool.name}.${field}`;
        if (key in mcpOnlyFields) continue;

        if (field === "dryRun") continue;
        if (field === "id" && (namesSelector || positionalTaskId)) continue;

        const d = dashed(field);
        if (cmdFlags.has(d) || ownedFlags.has(d)) continue;

        uncovered.push(key);
      }
    }

    expect(
      uncovered,
      `MCP input fields with no CLI analogue and no entry in mcpOnlyFields — ` +
        `add a cliRef flag, or classify the field with a real reason: ${uncovered.join(", ")}`,
    ).toEqual([]);
  });

  it("G5 — no stale mcpOnlyFields entries, and every entry carries a reason", () => {
    for (const [key, reason] of Object.entries(mcpOnlyFields)) {
      const sep = key.indexOf(".");
      expect(sep, `mcpOnlyFields key "${key}" is not "tool.field"`).toBeGreaterThan(0);
      const toolName = key.slice(0, sep);
      const field = key.slice(sep + 1);
      const tool = manifest.find((t) => t.name === toolName);
      expect(
        tool,
        `mcpOnlyFields lists "${key}", but no tool named "${toolName}" exists`,
      ).toBeDefined();
      expect(
        Object.keys(tool!.input),
        `mcpOnlyFields lists "${key}", but ${toolName} has no input field "${field}" ` +
          `(rename or remove it — a stale exemption hides a real divergence)`,
      ).toContain(field);
      // An entry with no reason is worse than a missing one: it reads as
      // reviewed when nobody reviewed it.
      expect(
        (reason ?? "").trim().length,
        `mcpOnlyFields["${key}"] has no reason`,
      ).toBeGreaterThan(20);
    }
  });

  it("G5 — update_task link fields merge, and the description must say so", () => {
    // This gate was born from a real divergence. `update_task` used to carry a
    // `links` field with REPLACE semantics — omitting a link deleted it —
    // while advertising `cliRef: ["--set-parent"]`, which is surgical and
    // preserves everything it does not name. Every name-based gate passed it.
    //
    // `links` is now MERGE, matching the CLI. The description is what an agent
    // actually reads (it rarely opens the schema), so it has to state the
    // semantics; these needles are what stop a future edit from quietly
    // reverting either the field or the wording.
    const update = manifest.find((m) => m.name === "update_task")!;
    const fields = Object.keys(update.input);

    expect(fields).toContain("links");
    expect(fields).toContain("addLinks");
    expect(fields).toContain("removeLinks");
    // clearLinks is the ONLY destructive path; without it there would be no
    // way to clear links at all.
    expect(fields).toContain("clearLinks");

    // The description must name each field's semantics, not just its existence.
    for (const needle of ["MERGE", "clearLinks", "removeLinks", "PRESERVED"]) {
      expect(
        update.description,
        `update_task.description must explain "${needle}" — an agent reads this, not the schema`,
      ).toContain(needle);
    }

    // And it must not still advertise the old destructive behaviour. If
    // `links` ever goes back to replacing, this fails before the description
    // can quietly keep promising preservation.
    expect(
      update.description,
      "update_task.description still claims links replace the set — links is MERGE now",
    ).not.toMatch(/REPLACES the entire link set/i);
  });

  it("G5 — create_task link fields merge, and the description must say so", () => {
    // The silent-drop this gate pins: `create_task` accepted a `links`
    // parameter and answered ok:true while discarding it — the zod schema
    // had no `links` field, so the unknown key was stripped and the created
    // child landed unlinked. A passing unit test alone could miss a repeat,
    // so the parameter set itself is pinned here: the field must exist and
    // the description must state the merge semantic an agent actually reads.
    const create = manifest.find((m) => m.name === "create_task")!;
    const fields = Object.keys(create.input);

    expect(fields).toContain("links");
    expect(fields).toContain("parent");

    // The description must name the merge semantic and the refusal, not just
    // the field's existence.
    for (const needle of ["MERGE", "links", "parent", "REFUSED"]) {
      expect(
        create.description,
        `create_task.description must explain "${needle}" — an agent reads this, not the schema`,
      ).toContain(needle);
    }
  });
});
