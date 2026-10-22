/**
 * Operation boundary ratchet (P0, ticket 2d789b27).
 *
 * Extends the tests/unit/mcp/drift.test.ts pattern (same commander walk, same
 * manifest + intentionallyNotExposed sources) with the four failure modes the
 * unification plan requires:
 *
 *   1. a new CLI flag/subcommand with no registry entry fails;
 *   2. a registry entry naming a command/flag/tool that no longer exists fails;
 *   3. an MCP tool input schema that drifted from its registry contract fails;
 *   4. an operation that changes mode without the registry saying so fails
 *      (any registry edit without a regen fails via the artifact comparison).
 *
 * Pre-existing reds are NOT papered over: the sibling-lane standalone
 * attach/delete modes (tasks --attach/--move/--delete/--yes) are covered as
 * TEMPORARY_CLI_FLAGS with their P5 removal phase — the drift.test.ts G1
 * checks still fail on them until the sibling lane classifies its own flags,
 * and that list is recorded in the ticket comment, not fixed here.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import {
  manifest,
  intentionallyNotExposed,
} from "../../src/mcp/manifest.js";
import {
  OPERATION_REGISTRY,
  REGISTRY_CLI_FLAGS,
  TEMPORARY_CLI_FLAGS,
} from "../../src/core/operation-registry.js";
import { KNOWN_DELTAS } from "@vibeflow-tools/api-core";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const srcRoot = join(__dirname, "../../src");

let createProgram: () => Command;

type Artifact = {
  commands: Record<string, { flags: string[]; positionals: string[] }>;
  tools: Record<
    string,
    { cliCommand: string; cliFlags: string[]; inputFields: string[] | null }
  >;
  registry: Record<
    string,
    {
      mapping: string | null;
      mcpTools: string[];
      mode: string | null;
      cli: string[];
      operationFn: string | null;
      requirement: string | null;
    }
  >;
  registryCliFlags: Record<string, string>;
  temporaryCliFlags: Record<string, string | null>;
  deltas: string[];
};

function loadArtifact(): Artifact {
  return JSON.parse(
    readFileSync(
      join(srcRoot, "core/operation-registry.gen.json"),
      "utf-8",
    ),
  );
}

/** Depth-first walk of the whole commander tree, including subcommands. */
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

/**
 * Pure coverage lookup shared by check 1 and the negative fixtures below:
 * returns the source that covers a "command --flag" key, or null when
 * nothing covers it (which is what must fail the suite).
 */
export function coveringSource(
  flagKey: string,
  deps: {
    registryCliFlags: Record<string, string>;
    temporaryCliFlags: Record<string, unknown>;
    classifiedFlags: Record<string, string>;
  },
): "registry" | "temporary" | "classified" | null {
  if (flagKey in deps.registryCliFlags) return "registry";
  if (flagKey in deps.temporaryCliFlags) return "temporary";
  if (flagKey in deps.classifiedFlags) return "classified";
  return null;
}

describe("operation boundary ratchet", () => {
  beforeAll(async () => {
    process.env.VIBEFLOW_CLI_SKIP_PARSE = "1";
    process.env.VIBEFLOW_CLI_SKIP_REFRESH = "1";
    try {
      ({ createProgram } = await import("../../src/index.js"));
    } finally {
      delete process.env.VIBEFLOW_CLI_SKIP_PARSE;
      delete process.env.VIBEFLOW_CLI_REFRESH;
      delete process.env.VIBEFLOW_CLI_SKIP_REFRESH;
    }
  });

  it("check 1 — every CLI flag is owned by the registry, temporary, or classified", () => {
    const program = createProgram();
    const uncovered: string[] = [];
    walkCommands(program, (path, cmd) => {
      if (path in intentionallyNotExposed.commands) return;
      for (const opt of cmd.options) {
        const flag = opt.long ?? opt.short;
        if (!flag || flag === "--help") continue;
        const key = `${path} ${flag}`;
        if (
          coveringSource(key, {
            registryCliFlags: REGISTRY_CLI_FLAGS,
            temporaryCliFlags: TEMPORARY_CLI_FLAGS,
            classifiedFlags: intentionallyNotExposed.flags,
          }) === null
        ) {
          uncovered.push(key);
        }
      }
    });
    expect(
      uncovered,
      `unregistered CLI flags — add each to REGISTRY_CLI_FLAGS (or TEMPORARY_CLI_FLAGS with a removal phase) and regen: ${uncovered.join(", ")}`,
    ).toEqual([]);
  });

  it("check 1 — every CLI command path is bound to an operation or classified", () => {
    const program = createProgram();
    const boundCommands = new Set(
      Object.values(OPERATION_REGISTRY).flatMap((r) =>
        r.cli.filter((c) => !c.includes(" --")),
      ),
    );
    const unbound: string[] = [];
    walkCommands(program, (path) => {
      if (boundCommands.has(path)) return;
      if (path in intentionallyNotExposed.commands) return;
      unbound.push(path);
    });
    expect(
      unbound,
      `CLI commands with no operation binding and no classification: ${unbound.join(", ")}`,
    ).toEqual([]);
  });

  it("check 1b — every temporary flag is also intent-mapped (no silent catch-all)", () => {
    const dangling = Object.keys(TEMPORARY_CLI_FLAGS).filter(
      (k) => !(k in REGISTRY_CLI_FLAGS),
    );
    expect(
      dangling,
      `TEMPORARY_CLI_FLAGS entries with no REGISTRY_CLI_FLAGS intent mapping: ${dangling.join(", ")}`,
    ).toEqual([]);
    for (const [key, entry] of Object.entries(TEMPORARY_CLI_FLAGS)) {
      expect(
        entry.phase,
        `TEMPORARY_CLI_FLAGS["${key}"] names no removal phase`,
      ).toMatch(/^P[1-9]/);
      expect(
        entry.reason.trim().length,
        `TEMPORARY_CLI_FLAGS["${key}"] has no reason`,
      ).toBeGreaterThan(20);
    }
  });

  it("check 2 — every registry CLI binding resolves to a live command/flag", () => {
    const program = createProgram();
    for (const record of Object.values(OPERATION_REGISTRY)) {
      for (const binding of record.cli) {
        const sep = binding.indexOf(" --");
        if (sep === -1) {
          expect(
            resolveCommand(program, binding),
            `operation ${record.id} binds command "${binding}", which no longer exists`,
          ).toBeDefined();
        } else {
          const cmd = resolveCommand(program, binding.slice(0, sep));
          const flag = binding.slice(sep + 1);
          expect(
            cmd,
            `operation ${record.id} binds "${binding}" but command "${binding.slice(0, sep)}" no longer exists`,
          ).toBeDefined();
          expect(
            cmd!.options.some((o) => o.long === flag),
            `operation ${record.id} binds "${binding}" but that flag no longer exists`,
          ).toBe(true);
        }
      }
    }
    for (const key of Object.keys(REGISTRY_CLI_FLAGS)) {
      const sep = key.indexOf(" --");
      const cmd = resolveCommand(program, key.slice(0, sep));
      expect(
        cmd,
        `REGISTRY_CLI_FLAGS["${key}"] names a command that no longer exists`,
      ).toBeDefined();
    }
    for (const key of Object.keys(TEMPORARY_CLI_FLAGS)) {
      const sep = key.indexOf(" --");
      const cmd = resolveCommand(program, key.slice(0, sep));
      expect(
        cmd,
        `TEMPORARY_CLI_FLAGS["${key}"] names a command that no longer exists`,
      ).toBeDefined();
    }
  });

  it("check 2 — every registry MCP tool exists in the manifest (both directions)", () => {
    const toolNames = new Set(manifest.map((t) => t.name));
    for (const record of Object.values(OPERATION_REGISTRY)) {
      for (const tool of record.mcpTools) {
        expect(
          toolNames.has(tool),
          `operation ${record.id} names MCP tool "${tool}", which is not in the manifest`,
        ).toBe(true);
      }
    }
    const boundTools = new Set(
      Object.values(OPERATION_REGISTRY).flatMap((r) => r.mcpTools),
    );
    for (const tool of manifest) {
      expect(
        boundTools.has(tool.name),
        `manifest tool "${tool.name}" has no operation-registry row — bind it or record why it is missing`,
      ).toBe(true);
    }
  });

  it("check 2 — every non-null operation symbol is still exported from core/operations", async () => {
    const operations = await import("../../src/core/operations.js");
    for (const record of Object.values(OPERATION_REGISTRY)) {
      if (record.operationFn === null) continue;
      expect(
        typeof (operations as Record<string, unknown>)[record.operationFn],
        `operation ${record.id} names core/operations symbol "${record.operationFn}", which is no longer exported`,
      ).toBe("function");
    }
  });

  it("check 3 — every MCP tool input schema matches its registry contract", () => {
    const artifact = loadArtifact();
    for (const tool of manifest) {
      const recorded = artifact.tools[tool.name];
      expect(
        recorded,
        `manifest tool "${tool.name}" has no generated contract entry — regen the artifact`,
      ).toBeDefined();
      const liveFields = Object.keys(tool.input).sort();
      expect(
        recorded.inputFields,
        `tool "${tool.name}": generator found no schema (expected ${liveFields.join(",")}) — check the <Name>Input convention`,
      ).not.toBeNull();
      expect(
        recorded.inputFields,
        `MCP tool "${tool.name}" input schema drifted from its registry contract (live: ${liveFields.join(",")}; recorded: ${(recorded.inputFields ?? []).join(",")}) — regen the artifact if the change is intended`,
      ).toEqual(liveFields);
    }
    const liveNames = new Set(manifest.map((t) => t.name));
    for (const name of Object.keys(artifact.tools)) {
      expect(
        liveNames.has(name),
        `registry contract records removed MCP tool "${name}" — regen the artifact`,
      ).toBe(true);
    }
  });

  it("check 4 — the checked-in artifact matches the declared registry (regen on any edit)", () => {
    const artifact = loadArtifact();
    const liveRegistry: Artifact["registry"] = Object.fromEntries(
      Object.values(OPERATION_REGISTRY).map((r) => [
        r.id,
        {
          mapping: r.mapping,
          mcpTools: [...r.mcpTools].sort(),
          mode: r.mode,
          cli: [...r.cli].sort(),
          operationFn: r.operationFn,
          requirement: r.requirement,
        },
      ]),
    );
    expect(
      artifact.registry,
      "operation-registry.gen.json is stale — run node scripts/generate-operation-registry.mjs and commit the result (a mode/mapping change without a regen fails here by design)",
    ).toEqual(liveRegistry);
    expect(
      artifact.registryCliFlags,
      "registryCliFlags drifted without a regen — run the generator",
    ).toEqual({ ...REGISTRY_CLI_FLAGS });
    const liveTemporary = Object.fromEntries(
      Object.entries(TEMPORARY_CLI_FLAGS).map(([k, v]) => [k, v.phase]),
    );
    expect(
      artifact.temporaryCliFlags,
      "temporaryCliFlags drifted without a regen — run the generator",
    ).toEqual(liveTemporary);
    expect(
      artifact.deltas,
      "KNOWN_DELTAS changed without a regen — run the generator",
    ).toEqual([...KNOWN_DELTAS.map((d) => d.id)].sort());
  });

  it("check 4 — modes and mappings use the closed vocabulary", () => {
    for (const record of Object.values(OPERATION_REGISTRY)) {
      expect(["local", "online", "both"]).toContain(record.mode);
      expect(["selected-board", "local-only", "sync", "none"]).toContain(
        record.requirement,
      );
      expect(["one-to-one", "intentionally-different", "missing"]).toContain(
        record.mapping,
      );
      expect(record.reason.trim().length).toBeGreaterThan(20);
    }
    // push_tasks must stay absent from the MCP surface: the one destructive
    // sync tool is a hidden CLI command, and resurrecting it must fail here.
    expect(manifest.some((m) => m.name === "push_tasks")).toBe(false);
    expect(OPERATION_REGISTRY.pushTasks.mcpTools).toEqual([]);
  });

  // ── Negative fixtures: prove the guard itself would fail ───────────────
  //
  // These do NOT touch the live tree — they run the same pure lookup the
  // live checks use against synthetic inputs, so a future refactor that
  // accidentally makes coveringSource total (always non-null) fails here.

  it("negative fixture — an unregistered flag has no covering source", () => {
    expect(
      coveringSource("tasks --definitely-not-a-flag", {
        registryCliFlags: REGISTRY_CLI_FLAGS,
        temporaryCliFlags: TEMPORARY_CLI_FLAGS,
        classifiedFlags: intentionallyNotExposed.flags,
      }),
    ).toBeNull();
  });

  it("negative fixture — each coverage source is reachable", () => {
    const deps = {
      registryCliFlags: REGISTRY_CLI_FLAGS,
      temporaryCliFlags: TEMPORARY_CLI_FLAGS,
      classifiedFlags: intentionallyNotExposed.flags,
    };
    expect(coveringSource("tasks --get", deps)).toBe("registry");
    // Temporary flags are a subset of the intent map (lookup order finds
    // the registry first); the temporary membership is what marks them
    // as not-yet-routed.
    expect(coveringSource("tasks --attach", deps)).toBe("registry");
    expect("tasks --attach" in deps.temporaryCliFlags).toBe(true);
    expect(coveringSource("tasks --json", deps)).toBe("classified");
  });
});
