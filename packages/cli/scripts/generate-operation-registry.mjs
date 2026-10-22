#!/usr/bin/env node
/**
 * generate-operation-registry.mjs — derive the operation-registry artifact
 * from the code (P0 ratchet, ticket 2d789b27).
 *
 * WHAT: parses (never executes) four sources with the TypeScript compiler
 * API and emits `src/core/operation-registry.gen.json` with stable key
 * ordering so diffs are reviewable:
 *   - src/index.ts            → command tree (nested paths) + flags per path
 *   - src/mcp/manifest.ts     → tool names + cliRef command/flags per tool
 *   - ../../api-core/src/mcp-tools.ts → input field names per XxxInput schema
 *   - src/core/operation-registry.ts  → declared mode/requirement/mapping
 *     plus the contract rows, and api-core operation-surface-contract.ts
 *     for the KNOWN_DELTAS ids.
 *
 * WHY the compiler API instead of regex (plan §8.2): nested commands
 * (`const authors = program.command("authors")` then `authors.command("link")`)
 * and `.addOption(new Option(...))` are invisible to line patterns but
 * trivial to a syntax walk. No build output is read — the artifact derives
 * from source, so a stale dist cannot launder a drift.
 *
 * Usage: node scripts/generate-operation-registry.mjs [--check]
 *   --check: exit 1 when the checked-in artifact differs (CI ratchet mode).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);
const ts = require("typescript");

const CLI_SRC = join(__dirname, "../src");
const API_CORE_SRC = join(__dirname, "../../api-core/src");
const OUT_PATH = join(CLI_SRC, "core/operation-registry.gen.json");

function parseFile(path) {
  const text = readFileSync(path, "utf-8");
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
}

/** Long flag from an option spec: "-p, --port <n>" → "--port". */
function longFlag(spec) {
  const m = spec.match(/--[A-Za-z][\w-]*/);
  return m ? m[0] : null;
}

/**
 * Walk the real Commander tree shape in src/index.ts.
 * Handles `program.command("x")…`, `const v = program.command("x")…` and
 * follow-up `v.command("y")…` statements; every `.option()`/`.addOption()`
 * in the same statement belongs to that statement's command.
 */
function extractCommands(indexPath) {
  const sf = parseFile(indexPath);
  const varToPath = new Map(); // authors -> "authors"
  const commands = new Map(); // path -> { flags:Set, positionals:[] }

  const ensure = (path) => {
    if (!commands.has(path))
      commands.set(path, { flags: new Set(), positionals: [] });
    return commands.get(path);
  };

  const isCommandCall = (node) =>
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "command" &&
    node.arguments.length >= 1 &&
    ts.isStringLiteralLike(node.arguments[0]);

  const baseOf = (call) => {
    const obj = call.expression.expression;
    if (ts.isIdentifier(obj)) {
      if (obj.text === "program") return "";
      return varToPath.get(obj.text) ?? null;
    }
    return null;
  };

  const optionsIn = (root, rec) => {
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "option" &&
        node.arguments.length >= 1 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        const flag = longFlag(node.arguments[0].text);
        if (flag) rec.flags.add(flag);
      }
      if (
        ts.isNewExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "Option" &&
        node.arguments.length >= 1 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        const flag = longFlag(node.arguments[0].text);
        if (flag) rec.flags.add(flag);
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "argument" &&
        node.arguments.length >= 1 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        rec.positionals.push(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
  };

  const defineCommand = (call, statementRoot) => {
    const base = baseOf(call);
    if (base === null) return;
    const name = call.arguments[0].text;
    const path = base === "" ? name : `${base} ${name}`;
    const rec = ensure(path);
    // `const v = program.command("x")…`: the declarator init is the outermost
    // chain — options live anywhere inside the same declaration.
    if (
      ts.isVariableDeclaration(statementRoot) &&
      ts.isIdentifier(statementRoot.name)
    ) {
      varToPath.set(statementRoot.name.text, path);
    }
    optionsIn(statementRoot, rec);
  };

  // A statement is one chain (program.command("x").option….action…): the
  // single .command() call inside it names the command; every .option() in
  // the same chain belongs to it. An action callback never registers a
  // subcommand, so the first .command() found is the definition.
  const findCommand = (root) => {
    let found = null;
    const visitInner = (n) => {
      if (found) return;
      if (isCommandCall(n)) {
        found = n;
        return;
      }
      ts.forEachChild(n, visitInner);
    };
    visitInner(root);
    return found;
  };

  const visit = (node) => {
    if (ts.isExpressionStatement(node)) {
      const cmd = findCommand(node);
      if (cmd && baseOf(cmd) !== null) defineCommand(cmd, node);
      return; // options already collected; do not double-walk
    }
    if (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.length === 1
    ) {
      const decl = node.declarationList.declarations[0];
      if (decl.initializer) {
        const cmd = findCommand(decl.initializer);
        if (cmd && baseOf(cmd) !== null) defineCommand(cmd, decl);
        return;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return commands;
}

/** Tool names + cliRef from src/mcp/manifest.ts (object literals only). */
function extractManifest(manifestPath) {
  const sf = parseFile(manifestPath);
  const tools = new Map(); // name -> { cliCommand, cliFlags[] }
  const visit = (node) => {
    if (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.length === 1
    ) {
      const decl = node.declarationList.declarations[0];
      if (
        decl.name.text === "manifest" &&
        decl.initializer &&
        ts.isArrayLiteralExpression(decl.initializer)
      ) {
        for (const el of decl.initializer.elements) {
          if (!ts.isObjectLiteralExpression(el)) continue;
          let name = null;
          let cliCommand = null;
          let cliFlags = [];
          for (const prop of el.properties) {
            if (
              !ts.isPropertyAssignment(prop) ||
              !ts.isIdentifier(prop.name)
            )
              continue;
            if (
              prop.name.text === "name" &&
              ts.isStringLiteralLike(prop.initializer)
            ) {
              name = prop.initializer.text;
            }
            if (
              prop.name.text === "cliRef" &&
              ts.isObjectLiteralExpression(prop.initializer)
            ) {
              for (const cp of prop.initializer.properties) {
                if (!ts.isPropertyAssignment(cp) || !ts.isIdentifier(cp.name))
                  continue;
                if (
                  cp.name.text === "command" &&
                  ts.isStringLiteralLike(cp.initializer)
                ) {
                  cliCommand = cp.initializer.text;
                }
                if (
                  cp.name.text === "flags" &&
                  ts.isArrayLiteralExpression(cp.initializer)
                ) {
                  cliFlags = cp.initializer.elements
                    .filter((e) => ts.isStringLiteralLike(e))
                    .map((e) => e.text);
                }
              }
            }
          }
          if (name) tools.set(name, { cliCommand, cliFlags });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return tools;
}

/** Top-level field names of each `XxxInput = z.object({...})` schema. */
function extractSchemaFields(mcpToolsPath) {
  const sf = parseFile(mcpToolsPath);
  const schemas = new Map(); // ListTasksInput -> [fields]
  const visit = (node) => {
    if (
      (ts.isVariableStatement(node) || ts.isVariableDeclarationList(node)) &&
      true
    ) {
      const decls = ts.isVariableStatement(node)
        ? node.declarationList.declarations
        : node.declarations;
      for (const decl of decls) {
        if (
          !ts.isIdentifier(decl.name) ||
          !decl.initializer ||
          !ts.isCallExpression(decl.initializer)
        )
          continue;
        const schemaName = decl.name.text;
        if (!/Input$/.test(schemaName)) continue;
        // z.object({ ... }) — the object literal may be nested as the first
        // argument of the z.object(...) call.
        const findObj = (n) => {
          if (ts.isObjectLiteralExpression(n)) return n;
          let found = null;
          ts.forEachChild(n, (c) => {
            if (!found) found = findObj(c);
          });
          return found;
        };
        const obj = findObj(decl.initializer);
        if (!obj) continue;
        const fields = [];
        for (const prop of obj.properties) {
          if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
            const key = prop.name.text ?? prop.name.getText(sf);
            fields.push(key);
          }
        }
        schemas.set(schemaName, fields);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return schemas;
}

/** Declared registry rows: mode/requirement/mapping/cli/mcpTools/operationFn. */
function extractRegistry(registryPath) {
  const sf = parseFile(registryPath);
  const rows = new Map();
  const temporary = new Map();
  const cliFlags = new Map();
  const readStrArray = (init) =>
    ts.isArrayLiteralExpression(init)
      ? init.elements
          .filter((e) => ts.isStringLiteralLike(e))
          .map((e) => e.text)
      : null;
  const readStr = (init) =>
    ts.isStringLiteralLike(init)
      ? init.text
      : init.kind === ts.SyntaxKind.NullKeyword
        ? null
        : undefined;

  const visit = (node) => {
    if (
      ts.isVariableStatement(node) &&
      node.declarationList.declarations.length === 1
    ) {
      const decl = node.declarationList.declarations[0];
      const varName = decl.name.text;
      if (
        (varName === "OPERATION_REGISTRY" ||
          varName === "REGISTRY_CLI_FLAGS" ||
          varName === "TEMPORARY_CLI_FLAGS") &&
        decl.initializer &&
        ts.isObjectLiteralExpression(decl.initializer)
      ) {
        for (const prop of decl.initializer.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const key =
            ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)
              ? prop.name.text
              : null;
          if (!key) continue;
          if (
            varName === "OPERATION_REGISTRY" &&
            ts.isObjectLiteralExpression(prop.initializer)
          ) {
            const row = {};
            for (const fp of prop.initializer.properties) {
              if (!ts.isPropertyAssignment(fp) || !ts.isIdentifier(fp.name))
                continue;
              const fkey = fp.name.text;
              if (
                fkey === "mode" ||
                fkey === "requirement" ||
                fkey === "mapping"
              ) {
                if (ts.isStringLiteralLike(fp.initializer))
                  row[fkey] = fp.initializer.text;
              } else if (fkey === "cli" || fkey === "mcpTools") {
                row[fkey] = readStrArray(fp.initializer) ?? [];
              } else if (fkey === "operationFn") {
                row[fkey] = readStr(fp.initializer);
              }
            }
            rows.set(key, row);
          } else if (
            varName === "REGISTRY_CLI_FLAGS" &&
            ts.isStringLiteralLike(prop.initializer)
          ) {
            cliFlags.set(key, prop.initializer.text);
          } else if (
            varName === "TEMPORARY_CLI_FLAGS" &&
            ts.isObjectLiteralExpression(prop.initializer)
          ) {
            let phase = null;
            for (const fp of prop.initializer.properties) {
              if (
                ts.isPropertyAssignment(fp) &&
                ts.isIdentifier(fp.name) &&
                fp.name.text === "phase" &&
                ts.isStringLiteralLike(fp.initializer)
              ) {
                phase = fp.initializer.text;
              }
            }
            temporary.set(key, phase);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { rows, temporary, cliFlags };
}

/** KNOWN_DELTAS ids from the api-core surface contract. */
function extractDeltaIds(contractPath) {
  const sf = parseFile(contractPath);
  const ids = [];
  const visit = (node) => {
    if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "id" &&
      ts.isStringLiteralLike(node.initializer)
    ) {
      ids.push(node.initializer.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return [...new Set(ids)].sort();
}

// ── main ──────────────────────────────────────────────────────────────────

const commands = extractCommands(join(CLI_SRC, "index.ts"));
const tools = extractManifest(join(CLI_SRC, "mcp/manifest.ts"));
const schemas = extractSchemaFields(join(API_CORE_SRC, "mcp-tools.ts"));
const { rows, temporary, cliFlags } = extractRegistry(
  join(CLI_SRC, "core/operation-registry.ts"),
);
const deltaIds = extractDeltaIds(
  join(API_CORE_SRC, "operation-surface-contract.ts"),
);

// Tool name → schema: manifest `input: ListTasksInput.shape` is not parsed
// here; the convention is <CamelName>Input, derived from the tool name.
const toolToSchema = (tool) =>
  tool
    .split("_")
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join("") + "Input";

const sorted = (iter) => [...iter].sort();

const artifact = {
  generatedBy: "scripts/generate-operation-registry.mjs",
  commands: Object.fromEntries(
    sorted(commands.keys()).map((path) => [
      path,
      {
        flags: sorted(commands.get(path).flags),
        positionals: commands.get(path).positionals,
      },
    ]),
  ),
  tools: Object.fromEntries(
    sorted(tools.keys()).map((name) => {
      const t = tools.get(name);
      const schemaFields = schemas.get(toolToSchema(name)) ?? null;
      return [
        name,
        {
          cliCommand: t.cliCommand,
          cliFlags: [...t.cliFlags].sort(),
          inputFields: schemaFields ? [...schemaFields].sort() : null,
        },
      ];
    }),
  ),
  registry: Object.fromEntries(
    sorted(rows.keys()).map((id) => [
      id,
      {
        mapping: rows.get(id).mapping ?? null,
        mcpTools: [...(rows.get(id).mcpTools ?? [])].sort(),
        mode: rows.get(id).mode ?? null,
        cli: [...(rows.get(id).cli ?? [])].sort(),
        operationFn: rows.get(id).operationFn ?? null,
        requirement: rows.get(id).requirement ?? null,
      },
    ]),
  ),
  registryCliFlags: Object.fromEntries(
    sorted(cliFlags.keys()).map((k) => [k, cliFlags.get(k)]),
  ),
  temporaryCliFlags: Object.fromEntries(
    sorted(temporary.keys()).map((k) => [k, temporary.get(k)]),
  ),
  deltas: deltaIds,
};

const out = JSON.stringify(artifact, null, 2) + "\n";

if (process.argv.includes("--check")) {
  const current = readFileSync(OUT_PATH, "utf-8");
  if (current !== out) {
    console.error(
      "operation-registry.gen.json is stale — run node scripts/generate-operation-registry.mjs and commit the result.",
    );
    process.exit(1);
  }
  console.log("operation-registry.gen.json is current.");
} else {
  writeFileSync(OUT_PATH, out);
  console.log(
    `wrote ${OUT_PATH} (${Object.keys(artifact.commands).length} commands, ${Object.keys(artifact.tools).length} tools, ${Object.keys(artifact.registry).length} operations).`,
  );
}
