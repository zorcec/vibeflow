/**
 * Merges the in-process (unit) v8 coverage with the CHILD-PROCESS (e2e)
 * coverage of the CLI, and reports the real number for `src/index.ts`.
 *
 * Why this script exists: the e2e suite spawns the CLI, and v8 coverage
 * collected by the vitest runner cannot see another process. The result was
 * that `src/index.ts` — a 4,000-line file that is almost entirely command
 * dispatch — was measured at ~10% no matter how much e2e exercised it, and
 * every new `--json` branch looked "untested" in the report while being pinned
 * by dozens of e2e assertions. The measurement was broken, not the tests.
 *
 * How the two sides are joined:
 *   unit → vitest's own v8 provider → istanbul `coverage-final.json`
 *   e2e  → `NODE_V8_COVERAGE` raw counters from each spawned CLI, attributed
 *          to the COVERAGE BUILD (`.coverage-cli/`, unminified + sourcemapped —
 *          see tsup.coverage.config.ts for why the shipped bundle cannot be
 *          used) → ast-v8-to-istanbul, which remaps through the build's
 *          source map → istanbul keyed by the ORIGINAL `src/**` path
 *   both → a position-keyed union that takes the `Math.max` of the two counts
 *          for each position (see the merge section for why this is not
 *          `istanbul-lib-coverage`'s own `merge`) → report
 *
 * Why `Math.max` and not a sum: a v8 run and an istanbul run describe the SAME
 * execution from two different angles. Summing their counters would count one
 * execution twice, and "lines" would quietly mean "times executed" instead of
 * "covered" — a number that rises as a test runs its subject in a loop.
 *
 * Thresholds: the unit pass inside this pipeline runs with the coverage
 * thresholds zeroed on purpose. The repo's configured thresholds (80/80/75/80)
 * are already unmet by the unit suite alone — `test:coverage` fails them at
 * HEAD, before this lane touched anything — and letting that failure
 * short-circuit the `&&` chain would mean the pipeline never reaches the
 * measurement it exists for. `test:coverage` still runs them unchanged, and
 * the merged report deliberately enforces nothing: setting a policy threshold
 * on a number that was previously unmeasurable is the owner's call, not this
 * script's.
 *
 * Dependencies: all of them are already present as transitive dependencies of
 * `@vitest/coverage-v8` (a devDependency this package already declares) —
 * `ast-v8-to-istanbul` and `istanbul-lib-coverage` — plus `vitest/node` for
 * the parser. Nothing is added to package.json. pnpm's strict layout does not
 * expose a transitive package to a bare import, so they are resolved through
 * `createRequire` anchored at `@vitest/coverage-v8`'s own package.json; if a
 * future dependency change breaks that anchor, this script fails loudly at
 * startup rather than silently reporting zero.
 */
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  assertMergeIsHonest,
  describeOneSidedFiles,
} from "./merge-coverage-guards.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");
const PKG = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf-8"));

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const UNIT_MAP = resolve(
  PKG_ROOT,
  arg("unit", "coverage/unit/coverage-final.json"),
);
const E2E_DIR = resolve(PKG_ROOT, arg("e2e", ".coverage-e2e"));
const CLI_DIR = resolve(PKG_ROOT, arg("cli-dir", ".coverage-cli"));
const OUT_DIR = resolve(PKG_ROOT, arg("out", "coverage/merged"));
/** The one file this whole pipeline exists to measure honestly. */
const SUBJECT = "src/index.ts";

// ── Dependency resolution (see the header) ──────────────────────────────────
const require = createRequire(join(PKG_ROOT, "package.json"));
const coverageV8Pkg = require.resolve("@vitest/coverage-v8/package.json");
const fromCoverage = createRequire(coverageV8Pkg);
const importFrom = async (specifier) =>
  import(pathToFileURL(fromCoverage.resolve(specifier)).href);

const { convert } = await importFrom("ast-v8-to-istanbul");
const v8cov = await importFrom("@bcoe/v8-coverage");
// These are CJS packages: under ESM the named exports node can statically
// detect are only the ones cjs-module-lexer found, so the real API (including
// `createCoverageMap`) hangs off `default`. Take `default` when it is there.
const cjs = async (specifier) => {
  const mod = await importFrom(specifier);
  return mod.default ?? mod;
};
const libCoverage = await cjs("istanbul-lib-coverage");
const libReport = await cjs("istanbul-lib-report");
const reports = await cjs("istanbul-reports");
const { parseAstAsync } = await import("vitest/node");

// ── Inputs ───────────────────────────────────────────────────────────────────
if (!existsSync(UNIT_MAP)) {
  throw new Error(
    `unit coverage map not found: ${UNIT_MAP}\n` +
      `Run the unit coverage pass first (vitest run --coverage --coverage.reportsDirectory=coverage/unit --coverage.reporter=json).`,
  );
}
if (!existsSync(E2E_DIR)) {
  throw new Error(`e2e coverage dir not found: ${E2E_DIR}`);
}
const unitMap = libCoverage.createCoverageMap(
  JSON.parse(readFileSync(UNIT_MAP, "utf-8")),
);

// Raw v8 counters per bundle file, merged across every child process.
//
// `mergeProcessCovs` (from @bcoe/v8-coverage, a dependency of
// @vitest/coverage-v8) is doing real work here, not ceremony. Concatenating
// each child's `functions` array instead looks equivalent and is not: the
// converter matches a v8 function to its AST node by position and takes the
// entry it finds first, so a child that never called a function contributes
// its `count: 0` entry first and the function reads as uncovered. Measured on
// this repo, concatenating reported 54/1304 statements covered for
// `src/index.ts`; merging properly reports 608/1380. That is the whole
// difference between a number that means something and one that does not.
const byFile = new Map();
let rawFiles = 0;
for (const entry of readdirSync(E2E_DIR)) {
  if (!entry.endsWith(".json")) continue;
  rawFiles++;
  const parsed = JSON.parse(readFileSync(join(E2E_DIR, entry), "utf-8"));
  for (const result of parsed.result ?? []) {
    // Only the coverage build's own bundles. node_modules coverage is not
    // interesting here and would dominate the conversion cost.
    if (!result.url.startsWith("file:")) continue;
    const filePath = fileURLToPath(result.url);
    if (!filePath.startsWith(CLI_DIR + "/")) continue;
    const existing = byFile.get(filePath) ?? [];
    existing.push({ result: [result] });
    byFile.set(filePath, existing);
  }
}
const mergedFunctions = new Map(
  [...byFile].map(([filePath, covs]) => [
    filePath,
    v8cov.mergeProcessCovs(covs).result[0]?.functions ?? [],
  ]),
);


// ── Convert + remap each executed bundle back to src/** ─────────────────────
const e2eMap = libCoverage.createCoverageMap({});
for (const [filePath, functions] of mergedFunctions) {
  const mapPath = `${filePath}.map`;
  if (!existsSync(mapPath)) {
    throw new Error(
      `no source map for ${filePath} — the coverage build must emit one (tsup.coverage.config.ts sets sourcemap:true).`,
    );
  }
  const code = readFileSync(filePath, "utf-8");
  const sourceMap = JSON.parse(readFileSync(mapPath, "utf-8"));
  const ast = await parseAstAsync(code);
  const converted = await convert({
    code,
    sourceMap,
    ast,
    // `url`, not a path: the converter runs it through fileURLToPath.
    coverage: { functions, url: pathToFileURL(filePath).href },
  });
  e2eMap.merge(converted);
}

// ── Merge ────────────────────────────────────────────────────────────────────
// NOT `libCoverage.mergeCoverage`. That merges by istanbul id, and the two
// sides do not share a geometry: the unit pass measures the vite-transformed
// module and the e2e pass measures the esbuild bundle remapped through its
// source map. Both describe the same ORIGINAL TypeScript, so they agree on
// source POSITIONS and disagree on everything else — statement order, ids, and
// the map's own line/column base. Merging by id would sum counts onto the
// wrong lines and report a number that is confidently wrong, which is worse
// than the unmeasured number this script exists to replace.
//
// So the union is keyed on position: a line/column is covered when EITHER pass
// executed it. That is the only merge that means "the suite covers this code".
const posKey = (loc) => `${loc.start.line}:${loc.start.column}`;

function unionFile(filePath, sides) {
  const statements = new Map();
  const functions = new Map();
  const branches = new Map();
  for (const side of sides) {
    for (const [id, loc] of Object.entries(side.statementMap)) {
      const key = posKey(loc);
      const prev = statements.get(key);
      // `end` can differ by a column between the two passes; the start is the
      // identifying part, and a differing end never means a different
      // statement in practice for a single file's own AST traversal.
      if (prev) prev.count = Math.max(prev.count, side.s[id] ?? 0);
      else statements.set(key, { loc, count: side.s[id] ?? 0 });
    }
    for (const [id, fn] of Object.entries(side.fnMap)) {
      const key = posKey(fn.decl ?? fn.loc);
      const prev = functions.get(key);
      if (prev) prev.count = Math.max(prev.count, side.f[id] ?? 0);
      else functions.set(key, { loc: fn.decl ?? fn.loc, name: fn.name, count: side.f[id] ?? 0 });
    }
    // Branches need the ordinal within a (line, type) group to pair up: two
    // `if`s of the same type on one line are distinct branches.
    const seen = new Map();
    for (const [id, br] of Object.entries(side.branchMap)) {
      const group = `${posKey(br.loc)}:${br.type}`;
      const nth = seen.get(group) ?? 0;
      seen.set(group, nth + 1);
      const key = `${group}#${nth}`;
      const counts = side.b[id] ?? [];
      const prev = branches.get(key);
      if (prev) {
        prev.count = prev.count.map((c, i) => Math.max(c, counts[i] ?? 0));
        // The two sides agree on positions, so they agree on the arm
        // locations; keep whichever side actually carried them (a remapped
        // bundle can come through with none) so the branchMap we write is a
        // shape istanbul accepts rather than `locations: []` over real counts.
        if (
          prev.locations.length !== prev.count.length &&
          (br.locations?.length ?? 0) === counts.length
        ) {
          prev.locations = [...br.locations];
        }
      } else {
        branches.set(key, {
          loc: br.loc,
          type: br.type,
          count: [...counts],
          locations: [...(br.locations ?? [])],
        });
      }
    }
  }
  const out = { path: filePath, statementMap: {}, s: {}, fnMap: {}, f: {}, branchMap: {}, b: {} };
  let n = 0;
  for (const [, v] of statements) {
    out.statementMap[n] = v.loc;
    out.s[n] = v.count;
    n++;
  }
  n = 0;
  for (const [, v] of functions) {
    out.fnMap[n] = { name: v.name, loc: v.loc, decl: v.loc };
    out.f[n] = v.count;
    n++;
  }
  n = 0;
  for (const [, v] of branches) {
    // One count per arm, and one location per arm: a consumer that maps an arm
    // index back to source must not find an empty list where the counts are.
    const count = v.count.length > 0 ? v.count : [0];
    const locations =
      v.locations.length === count.length
        ? v.locations
        : count.map(() => v.loc);
    out.branchMap[n] = { loc: v.loc, type: v.type, locations };
    out.b[n] = count;
    n++;
  }
  return out;
}

const allFiles = new Set([
  ...Object.keys(unitMap.toJSON()),
  ...Object.keys(e2eMap.toJSON()),
]);
const merged = {};
for (const file of allFiles) {
  const sides = [unitMap.toJSON(), e2eMap.toJSON()].map((m) => m[file]).filter(Boolean);
  merged[file] = unionFile(file, sides);
}

const mergedMap = libCoverage.createCoverageMap(merged);

// ── Report ───────────────────────────────────────────────────────────────────
// Percentages come from istanbul's own summariser over the merged geometry, so
// the reported number and the written report can never disagree.
const summarise = (coverageMap, filePath) =>
  filePath
    ? coverageMap.fileCoverageFor(filePath).toSummary().data
    : null;

const pct = (summary, kind) => {
  const key = { lines: "lines", branches: "branches", functions: "functions" }[kind];
  const s = summary?.[key];
  if (!s) return null;
  return { covered: s.covered, total: s.total, pct: s.pct };
};

const subjectKey = Object.keys(merged).find((k) => k.endsWith(SUBJECT));
const unitFiles = Object.keys(unitMap.toJSON());
const e2eFiles = Object.keys(e2eMap.toJSON());
const unitKey = unitFiles.find((k) => k.endsWith(SUBJECT));
const e2eKey = e2eFiles.find((k) => k.endsWith(SUBJECT));

// Everything below this line is arithmetic on a pair of maps. If the pair is
// not a pair, the arithmetic still runs and still prints a number under a
// "merged" heading — so the shape of the inputs is asserted FIRST, and a
// one-sided merge is a refusal rather than a quietly smaller number. See
// scripts/merge-coverage-guards.mjs for what each rule protects against.
assertMergeIsHonest({
  subject: SUBJECT,
  rawE2eFiles: rawFiles,
  executedBundleFiles: mergedFunctions.size,
  remappedFiles: e2eFiles,
  unitFiles,
  e2eFiles,
  unitKey,
  e2eKey,
  e2eEntry: e2eKey ? e2eMap.toJSON()[e2eKey] : undefined,
});
const unitSummary = summarise(
  libCoverage.createCoverageMap(unitMap.toJSON()),
  unitKey,
);
const e2eSummary = summarise(libCoverage.createCoverageMap(e2eMap.toJSON()), e2eKey);
const mergedSummary = summarise(mergedMap, subjectKey);

const rows = ["lines", "branches", "functions"].map((kind) => ({
  kind,
  unit: pct(unitSummary, kind),
  e2e: pct(e2eSummary, kind),
  merged: pct(mergedSummary, kind),
}));

const show = (label, v) =>
  v ? `${v.covered}/${v.total} (${v.pct.toFixed(2)}%)` : "not measured";

console.log("");
console.log(`Merged coverage for ${SUBJECT} (${PKG.name}@${PKG.version})`);
console.log(
  `  unit = ${rawFiles} raw coverage file(s) from the e2e children, ${mergedFunctions.size} executed bundle file(s)` +
    (e2eKey ? "" : " — the e2e pass reached no src/index.ts code"),
);
console.log(
  `  sides = ${describeOneSidedFiles(unitFiles, e2eFiles)} \u2014 expected away from ${SUBJECT}: the browser bundles are not in the CLI bundle`,
);
console.log("");
console.log(
  `  ${"metric".padEnd(10)}${"unit only".padEnd(22)}${"e2e only".padEnd(22)}merged`,
);
for (const r of rows) {
  console.log(
    `  ${r.kind.padEnd(10)}${show("unit", r.unit).padEnd(22)}${show(
      "e2e",
      r.e2e,
    ).padEnd(22)}${show("merged", r.merged)}`,
  );
}
console.log("");

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  join(OUT_DIR, "coverage-final.json"),
  JSON.stringify(merged),
  "utf-8",
);
const context = libReport.createContext({
  coverageMap: mergedMap,
  dir: OUT_DIR,
  sourceFinder: (filePath) => {
    const abs = filePath.startsWith("file:")
      ? fileURLToPath(filePath)
      : filePath;
    return existsSync(abs) ? readFileSync(abs, "utf-8") : null;
  },
});
for (const name of ["text", "json", "lcovonly"]) {
  reports
    .create(name, { file: name === "text" ? undefined : name })
    .execute(context);
}
console.log(
  `[coverage] merged report written to ${relative(PKG_ROOT, OUT_DIR)}/ (text, json, lcov)`,
);
