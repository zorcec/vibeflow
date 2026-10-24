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
 * P5 is fully routed (ticket 4a5f7df6): the standalone attach/delete,
 * explicit-commit and maintenance modes all run through shared operations,
 * so TEMPORARY_CLI_FLAGS is empty and the phase-boundary pin below fails
 * any P5 bypass entry that comes back. Later phases re-add their own
 * entries here until their extraction lands.
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
  OPERATION_IDS,
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
    // Every P5 mode is routed now, so its flags resolve through the
    // registry with no temporary bypass left (lookup order finds the
    // registry first; temporary membership is what used to mark the
    // not-yet-routed subset).
    expect(coveringSource("tasks --attach", deps)).toBe("registry");
    expect(coveringSource("tasks --json", deps)).toBe("classified");
  });

  it("phase boundary — P5 left no temporary bypass entries", () => {
    // Ticket 4a5f7df6 extraction is complete: attach, delete, explicit
    // commit and both maintenance modes run through shared operations, so
    // no flag may still claim a P5 bypass. A re-added entry fails here
    // until its phase's extraction lands and removes it again.
    expect(Object.keys(TEMPORARY_CLI_FLAGS)).toEqual([]);
    for (const id of [
      "attachFile",
      "deleteTaskOperation",
      "commitTaskPathsOperation",
      "normalizeTaskStore",
      "reindexTaskSortKeys",
    ] as const) {
      expect(
        OPERATION_REGISTRY[id].operationFn,
        `P5 operation "${id}" must stay extracted (non-null operationFn)`,
      ).not.toBeNull();
    }
  });
});

/**
 * Check 5 — storage reaches the migrated operation modules only through
 * named adapters (ticket 3d613068).
 *
 * `src/core/operations.ts` (the barrel) and `src/core/operations/*.ts` (the
 * migrated modules) must never import the file-backed store directly —
 * neither `core/tasks.js`, `core/comments.js` nor `core/files.js`, neither
 * statically nor dynamically (and aliasing the import changes nothing: the
 * scan matches the RESOLVED module, not the bound names). They reach
 * storage through `core/task-store.ts` (the ports) and pure helpers
 * (`task-links`, `task-listing`, `review-decision`, `verify-attestation`)
 * only. The approved local readers — `task-store.ts` itself and the
 * `review-gate.ts` compatibility wrapper — are deliberately NOT scanned.
 *
 * Specifiers resolve against the importing file: `./files.js` inside
 * `core/operations/` is a sibling port module (allowed), while `../tasks.js`
 * from the same directory is the store (denied). `import type` (and
 * type-position `import("…")`) are erased at runtime and cannot touch the
 * store, so the scan skips them: only runtime imports can violate the
 * boundary. Dynamic detection covers `await import("…")` — the only runtime
 * dynamic-import shape in this package (the one `import(x).then(…)` is the
 * server's `open`, outside the scanned scope).
 */

/**
 * Runtime import specifiers in one source text that resolve to a storage
 * module. `importerFile` is the path of the file `src` came from (a real
 * path for the tree scan, an operations-module path for the fixtures), used
 * to resolve relative specifiers. Covers `import … from "…"`, `import "…"`,
 * `export … from "…"` and `await import("…")`.
 */
export function findStorageImports(
  src: string,
  importerFile = "<root>/src/core/operations/tasks.ts",
): string[] {
  const isStorage = (spec: string) => {
    if (!spec.startsWith(".")) return false;
    const base = importerFile.split("/").slice(0, -1);
    const parts: string[] = [...base];
    for (const seg of spec.split("/")) {
      if (seg === "." || seg === "") continue;
      else if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    const resolved = parts.join("/");
    return /\/core\/(tasks|comments|files)\.js$/.test(resolved);
  };
  const offenders: string[] = [];
  for (const rawLine of src.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("import type")) continue;
    // Static: import … from "spec" / import "spec" / export … from "spec".
    const staticMatch =
      line.match(/\bimport\s+(?:[^"']*?\sfrom\s+)?["']([^"']+)["']/) ??
      line.match(/\bexport\s+(?:[^"']*?\sfrom\s+)["']([^"']+)["']/);
    if (staticMatch && isStorage(staticMatch[1])) {
      offenders.push(staticMatch[1]);
      continue;
    }
    // Dynamic: await import("spec"). Type-position `: import("…")` /
    // `as import("…")` never awaits, so awaiting is what separates a read
    // that can touch the store from a type that is erased.
    const dynamicRe = /\bawait\s+import\s*\(\s*["']([^"']+)["']\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = dynamicRe.exec(line)) !== null) {
      if (isStorage(m[1])) offenders.push(m[1]);
    }
  }
  return offenders;
}

describe("operation storage boundary (check 5)", () => {
  it("migrated operation modules reach storage only through named adapters", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const barrel = path.join(srcRoot, "core/operations.ts");
    const dir = path.join(srcRoot, "core/operations");
    const files = [
      barrel,
      ...fs
        .readdirSync(dir)
        .filter((f: string) => f.endsWith(".ts"))
        .map((f: string) => path.join(dir, f)),
    ];
    expect(files.length).toBeGreaterThan(1);
    const offenders: string[] = [];
    for (const file of files) {
      const found = findStorageImports(fs.readFileSync(file, "utf-8"), file);
      for (const spec of found) offenders.push(`${file}: ${spec}`);
    }
    expect(
      offenders,
      `migrated operation modules must not import storage directly (use the task-store ports): ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("negative fixture — aliased static and dynamic storage imports are rejected", () => {
    // Aliasing the bound name hides nothing: the resolved module is denied.
    expect(
      findStorageImports(
        'import * as tasksModule from "../tasks.js";',
      ),
    ).toEqual(['../tasks.js']);
    expect(
      findStorageImports(
        'import { listTasks as lt } from "../core/tasks.js";',
        "<root>/src/core/operations.ts",
      ),
    ).toEqual(['../core/tasks.js']);
    expect(
      findStorageImports(
        'const { x } = await import("../comments.js");',
      ),
    ).toEqual(['../comments.js']);
    expect(
      findStorageImports('export { y } from "../files.js";'),
    ).toEqual(['../files.js']);
  });

  it("negative fixture — sibling port modules, type-only and non-storage imports pass", () => {
    // Sibling port modules resolve inside core/operations/, not core/.
    expect(
      findStorageImports('export { x } from "./operations/tasks.js";'),
    ).toEqual([]);
    expect(
      findStorageImports('import { y } from "./files.js";'),
    ).toEqual([]);
    // Erased at runtime: cannot touch the store.
    expect(
      findStorageImports('import type { FileInfo } from "../files.js";'),
    ).toEqual([]);
    expect(
      findStorageImports(
        "const reads: import(\"../tasks.js\").TaskReadFinding[] = [];",
      ),
    ).toEqual([]);
    expect(
      findStorageImports(
        'const x = foo as import("../tasks.js").Task;',
      ),
    ).toEqual([]);
    // The allowed neighbours: ports, pure helpers, services.
    expect(
      findStorageImports(
        [
          'import { resolveOperationPorts } from "../task-store.js";',
          'import { taskRelations } from "../task-links.js";',
          'import { queryTaskList } from "../task-listing.js";',
          'import { decideReviewTransition } from "../review-decision.js";',
          'import { loadSettings } from "../settings.js";',
          'const { commitTaskChanges } = await import("../git.js");',
          'const { verifyTask } = await import("../commands/verify.js");',
          'import { localTaskStore } from "./task-store.js";',
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

/**
 * Check 6 — same-operation identity (P8, ticket dc9a42ac).
 *
 * G4 in drift.test.ts proves each manifest `run:` body calls A function
 * imported from core/operations. That is necessary but not sufficient: a
 * tool could call the WRONG operation (same module, different semantics)
 * and G4 would stay green. This check resolves, per tool, the operation
 * row that claims it in `mcpTools` and asserts the `run:` body calls
 * EXACTLY that row's `operationFn` symbol — paired CLI/MCP capabilities
 * share one implementation, not merely one module.
 */

/** Tool name → the `run: (ctx, input) => FN(` symbol it delegates to. */
export function toolRunSymbols(manifestSrc: string): Map<string, string> {
  const names: Array<{ index: number; name: string }> = [];
  for (const m of manifestSrc.matchAll(/name:\s*"([^"]+)"/g)) {
    names.push({ index: m.index ?? 0, name: m[1] });
  }
  const runs = new Map<string, string>();
  const runRe = /run:\s*\(ctx,\s*input\)\s*=>\s*([A-Za-z_$][\w$]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = runRe.exec(manifestSrc)) !== null) {
    const at = m.index ?? 0;
    let owner = "";
    for (const n of names) {
      if (n.index < at) owner = n.name;
      else break;
    }
    if (owner) runs.set(owner, m[1]);
  }
  return runs;
}

describe("operation identity (check 6)", () => {
  it("every manifest tool calls its registered operation symbol", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const manifestSrc = fs.readFileSync(
      path.join(srcRoot, "mcp/manifest.ts"),
      "utf-8",
    );
    const runs = toolRunSymbols(manifestSrc);
    // Shape guard: if the `run:` shape changes, the map is short and this
    // fails loudly instead of passing vacuously (same discipline as G4).
    expect(runs.size).toBe(manifest.length);
    const offenders: string[] = [];
    for (const tool of manifest) {
      const owner = Object.values(OPERATION_REGISTRY).find((r) =>
        r.mcpTools.includes(tool.name),
      );
      expect(
        owner,
        `manifest tool "${tool.name}" is claimed by no operation-registry row`,
      ).toBeDefined();
      if (owner!.operationFn === null) {
        offenders.push(
          `${tool.name}: registry row "${owner!.id}" has no operationFn — a paired tool must name its shared implementation`,
        );
        continue;
      }
      const actual = runs.get(tool.name);
      expect(
        actual,
        `manifest tool "${tool.name}" has no parsed run body — the run shape drifted past toolRunSymbols`,
      ).toBeDefined();
      if (actual !== owner!.operationFn) {
        offenders.push(
          `${tool.name}: run body calls \`${actual}\` but registry row "${owner!.id}" registers \`${owner!.operationFn}\``,
        );
      }
    }
    expect(
      offenders,
      `tools not calling their registered operation: ${offenders.join("; ")}`,
    ).toEqual([]);
  });

  it("negative fixture — a tool calling the wrong operation symbol is rejected", () => {
    const registryFn = "updateTask";
    const manifestSrc = `
      { name: "update_task", run: (ctx, input) => getTask(ctx, input) },
    `;
    const runs = toolRunSymbols(manifestSrc);
    expect(runs.get("update_task")).toBe("getTask");
    expect(runs.get("update_task")).not.toBe(registryFn);
  });

  it("negative fixture — an unclaimed tool has no registry owner", () => {
    const owner = Object.values(OPERATION_REGISTRY).find((r) =>
      r.mcpTools.includes("nonexistent_tool"),
    );
    expect(owner).toBeUndefined();
  });
});

/**
 * Check 7 — finality (P8, ticket dc9a42ac).
 *
 * "Final" is enforced, not asserted in prose:
 *   - TEMPORARY_CLI_FLAGS is empty and the api-core temporary migration
 *     list is empty (every P1–P7 removal phase has landed);
 *   - no registry reason promises a future extraction (FINAL-classified
 *     rows say FINAL; routed rows name the landed phase);
 *   - every SURFACE_STORAGE_USES row is well-formed (real operation or
 *     "renderer", matching kind, substantive reason).
 */
describe("final boundaries (check 7)", () => {
  it("no registry reason promises a future extraction", () => {
    const futureRe =
      /P[1-9]\s+(extracts|unifies|unify|lands\b(?!.*landed)|removal|increment|will handle|not-?yet-routed)|will be |not yet |TODO|temporar/i;
    const offenders = Object.values(OPERATION_REGISTRY)
      .filter((r) => futureRe.test(r.reason))
      .map((r) => r.id);
    expect(
      offenders,
      `operations promising future extraction (route them or FINAL-classify them): ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("every null-operationFn row is FINAL-classified", () => {
    const offenders: string[] = [];
    for (const record of Object.values(OPERATION_REGISTRY)) {
      if (record.operationFn !== null) continue;
      if (!record.reason.startsWith("FINAL:")) {
        offenders.push(record.id);
      }
      expect(
        record.mcpTools,
        `null-operationFn row "${record.id}" must expose no MCP tool`,
      ).toEqual([]);
    }
    expect(
      offenders,
      `unrouted operations without FINAL classification: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("both temporary migration lists are empty", async () => {
    expect(Object.keys(TEMPORARY_CLI_FLAGS)).toEqual([]);
    const apiCore = await import("@vibeflow-tools/api-core");
    expect(apiCore.TEMPORARY_MIGRATION_ENTRIES).toEqual([]);
  });

  it("SURFACE_STORAGE_USES rows are well-formed", async () => {
    const { SURFACE_STORAGE_USES } = await import(
      "../../src/core/operation-registry.js"
    );
    const offenders: string[] = [];
    for (const [key, row] of Object.entries(SURFACE_STORAGE_USES)) {
      const typed = row as {
        operation: string;
        kind: string;
        reason: string;
      };
      if (!/^src\/\S+ \S+$/.test(key)) {
        offenders.push(`${key}: key is not "src/<file> <callee>"`);
      }
      const isRenderer = typed.operation === "renderer";
      const isOp = OPERATION_IDS.includes(typed.operation);
      if (!isRenderer && !isOp) {
        offenders.push(`${key}: unknown operation "${typed.operation}"`);
      }
      // Read-only display rows may name the operation they read through
      // (or "renderer" for pure formatting); only write-path rows MUST name
      // the operation they own to.
      if (isRenderer && typed.kind !== "renderer" && typed.kind !== "bootstrap") {
        offenders.push(`${key}: "renderer" operation with kind "${typed.kind}"`);
      }
      if (!isRenderer && typed.kind !== "write-path" && typed.kind !== "renderer" && typed.kind !== "bootstrap") {
        offenders.push(
          `${key}: operation "${typed.operation}" with unknown kind "${typed.kind}"`,
        );
      }
      if (typed.kind === "write-path" && isRenderer) {
        offenders.push(
          `${key}: write-path rows must name their owning operation, not "renderer"`,
        );
      }
      if ((typed.reason ?? "").trim().length <= 20) {
        offenders.push(`${key}: reason is missing or boilerplate`);
      }
    }
    expect(
      offenders,
      `malformed surface-storage inventory rows: ${offenders.join("; ")}`,
    ).toEqual([]);
    expect(Object.keys(SURFACE_STORAGE_USES).length).toBeGreaterThan(0);
  });

  it("negative fixture — future-phase language fails the finality scan", () => {
    const futureRe =
      /P[1-9]\s+(extracts|unifies|unify|lands\b(?!.*landed)|removal|increment|will handle|not-?yet-routed)|will be |not yet |TODO|temporar/i;
    expect(futureRe.test("Local-only; never an MCP tool (P6 extracts).")).toBe(
      true,
    );
    expect(
      futureRe.test("Stays a deliberate human action (P6 landed)."),
    ).toBe(false);
  });
});

/**
 * Check 8 — no-bypass import boundaries (P8, ticket dc9a42ac).
 *
 * Two directions, both recursive through local helpers:
 *   (a) surface modules (index, mcp/*, agent-chat, cli/renderers) reach
 *       task storage ONLY through inventoried callees — a new unlisted
 *       storage use fails, a listed use that disappears fails as stale;
 *   (b) operation modules never import surface/transport code, never print,
 *       and never set process state — comments and string literals are
 *       stripped first so prose about a surface cannot fail the gate.
 */

const STORAGE_BASENAME_RE = /\/core\/(tasks|comments|files)\.js$/;

/** Resolve a relative specifier against its importer to a src-root path. */
function resolveSrcPath(
  importerFile: string,
  spec: string,
): string | null {
  if (!spec.startsWith(".")) return null;
  const parts = importerFile.split("/");
  parts.pop();
  for (const seg of spec.split("/")) {
    if (seg === "." || seg === "") continue;
    else if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}

/**
 * Original exported names a surface file pulls at RUNTIME from task-storage
 * modules (aliases resolved: `saveFile as saveTaskFile` counts as
 * `saveFile`). Type-only imports are erased and cannot touch the store.
 * Imports may span lines — matching runs over the whole text, not per line.
 */
export function surfaceStorageCallees(
  src: string,
  importerFile: string,
): string[] {
  const found: string[] = [];
  const isStorage = (spec: string) => {
    const resolved = resolveSrcPath(importerFile, spec);
    return resolved !== null && STORAGE_BASENAME_RE.test(resolved);
  };
  const pushNames = (body: string, sep: "as" | ":") => {
    for (const part of body.split(",")) {
      const cells = sep === "as" ? part.split(/\s+as\s+/) : part.split(":");
      const orig = cells[0].trim();
      if (orig && orig !== "type" && !orig.startsWith("type ")) {
        found.push(orig);
      }
    }
  };
  const noTypeImports = src.replace(/\bimport\s+type\s*\{[^}]*\}\s*from\s*["'][^"']+["'];?/g, "");
  const staticRe = /\bimport\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = staticRe.exec(noTypeImports)) !== null) {
    if (isStorage(m[2])) pushNames(m[1], "as");
  }
  const sideRe = /\bimport\s*["']([^"']+)["'];?/g;
  while ((m = sideRe.exec(noTypeImports)) !== null) {
    if (isStorage(m[1])) found.push("<side-effect>");
  }
  const exportRe = /\bexport\s*\{([\s\S]*?)\}\s*from\s*["']([^"']+)["']/g;
  while ((m = exportRe.exec(noTypeImports)) !== null) {
    if (isStorage(m[2])) pushNames(m[1], "as");
  }
  const dynamicRe = /\bawait\s+import\s*\(\s*["']([^"']+)["']\s*\)/g;
  while ((m = dynamicRe.exec(noTypeImports)) !== null) {
    if (!isStorage(m[1])) continue;
    const before = noTypeImports.slice(0, m.index);
    const destructure = before.match(/\{([^{}]*)\}\s*=\s*$/);
    if (destructure) pushNames(destructure[1], ":");
    else found.push("<namespace>");
  }
  return [...new Set(found)];
};

const SURFACE_FILES = [
  "index.ts",
  "mcp/manifest.ts",
  "mcp/server.ts",
  "mcp/stdio.ts",
  "mcp/http.ts",
  "server/agent-chat/mcp.ts",
  "cli/renderers/task-reads.ts",
];

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
}

/** Runtime surface markers in operation modules (comments/strings removed). */
export function findSurfaceImports(
  src: string,
  importerFile = "<root>/src/core/operations/tasks.ts",
): string[] {
  const offenders: string[] = [];
  const noComments = stripComments(src);
  // Static + dynamic specifiers first (string literals still present).
  const specs: string[] = [];
  for (const rawLine of noComments.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("import type")) continue;
    const sm =
      line.match(/\bimport\s+(?:[^"']*?\sfrom\s+)?["']([^"']+)["']/) ??
      line.match(/\bexport\s+(?:[^"']*?\sfrom\s+)["']([^"']+)["']/);
    if (sm) specs.push(sm[1]);
    const dynRe = /\bawait\s+import\s*\(\s*["']([^"']+)["']\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = dynRe.exec(line)) !== null) specs.push(m[1]);
  }
  for (const spec of specs) {
    if (spec === "commander" || spec.startsWith("@modelcontextprotocol")) {
      offenders.push(spec);
      continue;
    }
    if (spec === "chalk") {
      offenders.push(spec);
      continue;
    }
    const resolved = resolveSrcPath(importerFile, spec);
    if (
      resolved !== null &&
      (/\/src\/index\.js$/.test(resolved) ||
        /\/src\/mcp\//.test(resolved) ||
        /\/src\/server\/agent-chat\//.test(resolved))
    ) {
      offenders.push(spec);
    }
  }
  // Code markers with strings removed (prose about a surface cannot fail).
  const code = noComments.replace(/(["'`])(?:(?!\1|\\).|\\.)*\1/g, '""');
  for (const m of code.matchAll(
    /\bprocess\.exitCode\s*=|\bprocess\.argv\b|\bconsole\.\w+\s*\(/g,
  )) {
    offenders.push(m[0].trim());
  }
  return [...new Set(offenders)];
}

describe("surface/operation import boundaries (check 8)", () => {
  it("surface storage uses are exactly the inventoried set (no more, no fewer)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { SURFACE_STORAGE_USES } = await import(
      "../../src/core/operation-registry.js"
    );
    const live = new Map<string, string[]>();
    for (const rel of SURFACE_FILES) {
      const abs = path.join(srcRoot, rel);
      if (!fs.existsSync(abs)) continue;
      const callees = surfaceStorageCallees(
        fs.readFileSync(abs, "utf-8"),
        `<root>/src/${rel}`,
      );
      if (callees.length > 0) live.set(`src/${rel}`, callees);
    }
    const unlisted: string[] = [];
    for (const [file, callees] of live) {
      for (const callee of callees) {
        if (!( `${file} ${callee}` in SURFACE_STORAGE_USES)) {
          unlisted.push(
            `${file} ${callee}: surface storage use with no inventory row — route it through its operation or classify it in SURFACE_STORAGE_USES`,
          );
        }
      }
    }
    expect(unlisted).toEqual([]);
    const stale = Object.keys(SURFACE_STORAGE_USES).filter((key) => {
      const sep = key.indexOf(" ");
      const file = key.slice(0, sep);
      const callee = key.slice(sep + 1);
      return !(live.get(file) ?? []).includes(callee);
    });
    expect(
      stale,
      `stale inventory rows (storage use is gone — remove the row): ${stale.join(", ")}`,
    ).toEqual([]);
  });

  it("mcp, agent-chat and renderers use no task storage directly", async () => {
    const { SURFACE_STORAGE_USES } = await import(
      "../../src/core/operation-registry.js"
    );
    const rows = Object.keys(SURFACE_STORAGE_USES).filter((k) =>
      k.startsWith("src/index.ts "),
    );
    // Transports and renderers stay pure: any storage row outside index.ts
    // is a new bypass, not a classification.
    expect(
      Object.keys(SURFACE_STORAGE_USES).filter((k) => !k.startsWith("src/index.ts ")),
      "storage inventory outside src/index.ts — transports/renderers must stay storage-free",
    ).toEqual([]);
    expect(rows.length).toBeGreaterThan(0);
  });

  it("operations import no surface modules, print nothing, set no process state", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const barrel = path.join(srcRoot, "core/operations.ts");
    const dir = path.join(srcRoot, "core/operations");
    const files = [
      barrel,
      ...fs
        .readdirSync(dir)
        .filter((f: string) => f.endsWith(".ts"))
        .map((f: string) => path.join(dir, f)),
    ];
    const offenders: string[] = [];
    for (const file of files) {
      for (const spec of findSurfaceImports(
        fs.readFileSync(file, "utf-8"),
        file,
      )) {
        offenders.push(`${file}: ${spec}`);
      }
    }
    expect(
      offenders,
      `operations reaching into surfaces (import the port/service instead): ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("negative fixture — aliased, dynamic and helper storage uses are caught", () => {
    expect(
      surfaceStorageCallees(
        'import { listTasks as lt } from "../core/tasks.js";',
        "<root>/src/index.ts",
      ),
    ).toEqual(["listTasks"]);
    expect(
      surfaceStorageCallees(
        'const { saveFile: saveTaskFile } = await import("./core/files.js");',
        "<root>/src/index.ts",
      ),
    ).toEqual(["saveFile"]);
    expect(
      surfaceStorageCallees(
        'import type { Task } from "../core/tasks.js";',
        "<root>/src/index.ts",
      ),
    ).toEqual([]);
    expect(
      surfaceStorageCallees(
        'import { queryTaskList } from "../core/task-listing.js";',
        "<root>/src/index.ts",
      ),
    ).toEqual([]);
  });

  it("negative fixture — operation surface imports, prints and exits are caught", () => {
    expect(
      findSurfaceImports('import { Command } from "commander";'),
    ).toEqual(["commander"]);
    expect(
      findSurfaceImports('const m = await import("../../mcp/server.js");'),
    ).toEqual(["../../mcp/server.js"]);
    expect(
      findSurfaceImports("process.exitCode = 1;", "<root>/src/core/x.ts"),
    ).toEqual(["process.exitCode ="]);
    expect(findSurfaceImports("console.log(x);")).toEqual(["console.log("]);
    // Prose about a surface and type-only imports cannot fail the gate.
    expect(
      findSurfaceImports(
        "// the CLI renderer reads this\nimport type { X } from '../index.js';",
      ),
    ).toEqual([]);
    expect(
      findSurfaceImports('/* see src/mcp/server.ts */\nconst ok = true;'),
    ).toEqual([]);
  });
});

/**
 * Check 9 — every KNOWN_DELTAS entry is executable (P8, ticket dc9a42ac).
 *
 * A delta that names no live wiring and pins no behavior is a comment, not
 * a contract — and an unused/stale delta fails exactly like an unclassified
 * divergence (plan §3.3). This suite is the executable side: for every delta
 * id it asserts the registry/manifest facts the delta's text depends on,
 * plus a live behavior probe where one is side-effect-free (tmp project,
 * dry-run, or read-only). A new delta without a probe fails (exact key
 * match, both directions); a probe whose wiring changed fails at the fact.
 */
describe("known deltas are executable (check 9)", () => {

  it("every delta is structurally sound and has a probe (no stale, no missing)", async () => {
    const apiCore = await import("@vibeflow-tools/api-core");
    const deltas: Array<{
      id: string;
      operation: string;
      surfaces: string[];
      kind: string;
      reason: string;
      expected: string;
      ticket: string;
    }> = [...apiCore.KNOWN_DELTAS];
    const ids = deltas.map((d) => d.id).sort();
    expect(new Set(ids).size).toBe(ids.length);
    for (const d of deltas) {
      expect(
        OPERATION_IDS.includes(d.operation),
        `delta "${d.id}" names unknown operation "${d.operation}"`,
      ).toBe(true);
      for (const s of d.surfaces) {
        expect(
          ["cli", "local-mcp", "local-http-mcp", "agent-chat", "hosted-mcp", "api"],
          `delta "${d.id}" names unknown surface "${s}"`,
        ).toContain(s);
      }
      expect(d.kind.length).toBeGreaterThan(0);
      expect((d.reason ?? "").trim().length).toBeGreaterThan(20);
      expect((d.expected ?? "").trim().length).toBeGreaterThan(20);
      expect((d.ticket ?? "").trim().length).toBeGreaterThan(0);
    }
    expect(ids).toEqual(Object.keys(DELTA_PROBES).sort());
  });

  it("each delta's declared wiring holds and its probe passes", async () => {
    for (const id of Object.keys(DELTA_PROBES).sort()) {
      await DELTA_PROBES[id]();
    }
  });

  it("negative fixture — an unprobed delta and a stale probe both fail", () => {
    const apiIds = ["push-mcp-absent", "made-up-delta"];
    const probes = { "push-mcp-absent": () => {} };
    expect(Object.keys(probes).sort()).not.toEqual([...apiIds].sort());
    expect(Object.keys(DELTA_PROBES).sort()).toContain("push-mcp-absent");
    expect(Object.keys(DELTA_PROBES)).not.toContain("made-up-delta");
  });
});

/** One executable probe per KNOWN_DELTAS id (see check 9 above). */
const DELTA_PROBES: Record<string, () => Promise<void>> = {
  "push-mcp-absent": async () => {
    // The one destructive sync stays CLI-only: no tool, empty binding,
    // missing mapping. Resurrecting push_tasks fails here first.
    expect(manifest.some((m) => m.name === "push_tasks")).toBe(false);
    expect(OPERATION_REGISTRY.pushTasks.mcpTools).toEqual([]);
    expect(OPERATION_REGISTRY.pushTasks.mapping).toBe("missing");
  },
  "hosted-pull-absent": async () => {
    // Local pull exists on both surfaces; hosted has no local store, so
    // the absence is declared, not drift.
    expect(manifest.some((m) => m.name === "pull")).toBe(true);
    expect(OPERATION_REGISTRY.pullFromBoard.mcpTools).toEqual(["pull"]);
  },
  "hosted-project-identity": async () => {
    // Local get_project answers the startup-pinned filesystem root —
    // hosted answers board identity instead (declared alternative).
    const { getProject } = await import("../../src/core/operations.js");
    const dir = (await import("node:os")).tmpdir();
    const result = await getProject({ projectDir: dir, mode: "local" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.root).toBe(dir);
      expect(typeof result.data.name).toBe("string");
    }
    expect(OPERATION_REGISTRY.getProject.mapping).toBe(
      "intentionally-different",
    );
  },
  "hosted-server-answers": async () => {
    // Local preview binds nothing and names the URLs it would serve;
    // hosted returns a board deep link instead (declared alternative).
    const { startKanban } = await import("../../src/core/operations.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const result = await startKanban(
      { projectDir: mkdtempSync(join(tmpdir(), "delta-kanban-")), mode: "local" },
      { dryRun: true },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as { started: boolean; url: string };
      expect(data.started).toBe(false);
      expect(typeof data.url).toBe("string");
    }
    expect(OPERATION_REGISTRY.startKanban.mapping).toBe("one-to-one");
  },
  "hosted-guide-answers": async () => {
    const { getIntegrationGuide } = await import(
      "../../src/core/operations.js"
    );
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const result = await getIntegrationGuide(
      {
        projectDir: mkdtempSync(join(tmpdir(), "delta-guide-")),
        mode: "local",
      },
      {},
    );
    expect(result.ok).toBe(true);
    expect(OPERATION_REGISTRY.getIntegrationGuide.mapping).toBe("one-to-one");
  },
  "hosted-verify-local-only": async () => {
    // The engine reads local task/baseline files and drives a local
    // browser: local-only by requirement, intentionally different by
    // mapping; hosted answers VERIFY_ENGINE_LOCAL_ONLY.
    expect(OPERATION_REGISTRY.verifyTaskOp.requirement).toBe("local-only");
    expect(OPERATION_REGISTRY.verifyTaskOp.mapping).toBe(
      "intentionally-different",
    );
    expect(manifest.some((m) => m.name === "verify_task")).toBe(true);
  },
  "hosted-update-no-checkout-git": async () => {
    // One shared updateTask implementation; the review auto-commit SHA is
    // CLI/local-only chrome (no checkout hosted), never asserted there.
    expect(OPERATION_REGISTRY.updateTask.mapping).toBe("one-to-one");
    expect(OPERATION_REGISTRY.updateTask.mcpTools).toEqual(["update_task"]);
  },
  "cli-mcp-transport-envelopes": async () => {
    // The operation returns the internal ok/data/steps shape; each surface
    // maps it to its own envelope (CLI {ok:true,...}, MCP content text).
    const { listTasks } = await import("../../src/core/operations.js");
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "delta-env-"));
    mkdirSync(join(dir, ".vibeflow", "tasks"), { recursive: true });
    writeFileSync(
      join(dir, ".vibeflow", "tasks", "t1.json"),
      JSON.stringify({
        id: "t1",
        title: "T",
        description: "",
        status: "todo",
        selector: "/",
        created: "2026-01-01T00:00:00.000Z",
      }),
    );
    const result = await listTasks({ projectDir: dir, mode: "local" }, {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Array.isArray(result.data.tasks)).toBe(true);
    }
    expect(OPERATION_REGISTRY.listTasks.mapping).toBe("one-to-one");
  },
  "verify-raw-result-envelope": async () => {
    // verify --json prints the raw VerifyResult (whose ok is page-health
    // evidence), not the {ok:true,result} CLI envelope — pinned here so
    // no "uniformity" cleanup silently rewrites the wire.
    expect(OPERATION_REGISTRY.verifyTaskOp.mapping).toBe(
      "intentionally-different",
    );
    expect(
      manifest.find((m) => m.name === "verify_task")!.category,
    ).toBe("task-mutate");
  },
  "pull-push-bare-reports": async () => {
    // pull/push --json print bare counters/reports, never wrapped in the
    // tasks {ok:true,...} envelope.
    expect(OPERATION_REGISTRY.pullFromBoard.requirement).toBe("sync");
    expect(OPERATION_REGISTRY.pushTasks.requirement).toBe("sync");
  },
  "status-human-text-envelope": async () => {
    // status/auth status --json still prints the human summary; the
    // machine probe is get_project. No MCP tool may depend on a status
    // JSON envelope.
    expect(OPERATION_REGISTRY.getAccountStatus.mcpTools).toEqual([]);
    expect(OPERATION_REGISTRY.getAccountStatus.mapping).toBe(
      "intentionally-different",
    );
  },
  "attach-duplicate-policy": async () => {
    // Same implementation, explicit per-surface policy: MCP replaces
    // bytes in place (live probe); CLI standalone attach refuses
    // duplicates (pinned by tasks-attach e2e).
    const { attachFile } = await import("../../src/core/operations.js");
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "delta-attach-"));
    mkdirSync(join(dir, ".vibeflow", "tasks"), { recursive: true });
    writeFileSync(
      join(dir, ".vibeflow", "tasks", "t1.json"),
      JSON.stringify({
        id: "t1",
        title: "T",
        description: "",
        status: "todo",
        selector: "/",
        created: "2026-01-01T00:00:00.000Z",
        files: [],
      }),
    );
    const ctx = { projectDir: dir, mode: "local" } as const;
    const b64 = (s: string) => Buffer.from(s).toString("base64");
    const first = await attachFile(ctx, {
      id: "t1",
      filename: "note.md",
      contentB64: b64("v1"),
    });
    expect(first.ok).toBe(true);
    const second = await attachFile(ctx, {
      id: "t1",
      filename: "note.md",
      contentB64: b64("v2-longer"),
    });
    expect(second.ok).toBe(true);
    const { globSync } = await import("node:fs");
    const matches = globSync(join(dir, ".vibeflow", "tasks", "**", "t1.json"));
    expect(matches).toHaveLength(1);
    const stored = JSON.parse(
      (await import("node:fs")).readFileSync(matches[0], "utf-8"),
    );
    expect(stored.files).toHaveLength(1);
    expect(OPERATION_REGISTRY.attachFile.mapping).toBe(
      "intentionally-different",
    );
  },
  "cli-only-unbounded-listing": async () => {
    // list_tasks pages (limit/offset/nextCursor) and deliberately has no
    // unbounded mode; CLI --all assembles everything itself.
    const { ListTasksInput } = await import("@vibeflow-tools/api-core");
    expect("all" in ListTasksInput.shape).toBe(false);
    const ops = await import("../../src/core/operations.js");
    expect(typeof ops.listAllTasksForCli).toBe("function");
    expect(OPERATION_REGISTRY.listTasks.mcpTools).toEqual(["list_tasks"]);
  },
  "local-only-http-chat": async () => {
    // Board tools mount on HTTP/chat only in the offline branch (server
    // wiring, e2e-pinned); the registry records listTasks as the
    // representative selected-board capability.
    expect(OPERATION_REGISTRY.listTasks.requirement).toBe("selected-board");
  },
  "chat-context-tools": async () => {
    // Classified chat-only capabilities with operation wrappers and no
    // CLI spelling and no main-manifest tool.
    for (const id of ["readPageText", "readPageDom"] as const) {
      expect(OPERATION_REGISTRY[id].cli).toEqual([]);
      expect(OPERATION_REGISTRY[id].mcpTools).toEqual([]);
      expect(OPERATION_REGISTRY[id].operationFn).not.toBeNull();
    }
    expect(
      manifest.some(
        (m) => m.name === "read_page_text" || m.name === "read_page_dom",
      ),
    ).toBe(false);
  },
  "openapi-raw-document": async () => {
    // Raw bytes, no envelope: the data IS the document.
    const { getOpenApiDocument } = await import(
      "../../src/core/operations.js"
    );
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const result = await getOpenApiDocument(
      { projectDir: mkdtempSync(join(tmpdir(), "delta-openapi-")), mode: "local" },
      {},
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.data.content).toBe("string");
      expect(result.data.content.length).toBeGreaterThan(0);
      expect(JSON.parse(result.data.content)).toBeTruthy();
    }
  },
  "changelog-raw-text": async () => {
    const { getChangelog } = await import("../../src/core/operations.js");
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const result = await getChangelog(
      { projectDir: mkdtempSync(join(tmpdir(), "delta-changelog-")), mode: "local" },
      {},
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.data.text).toBe("string");
    }
  },
};
