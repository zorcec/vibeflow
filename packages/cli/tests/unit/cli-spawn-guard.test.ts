/**
 * CLI spawn-isolation guard (ticket 8ac96ef9).
 *
 * Four test spawn sites once ran the CLI with the operator's real HOME —
 * one of them (`kanban-syntax.test.ts` spawning `vibeflow serve`) destroyed
 * the operator's auth token. Every CLI spawn is a credential-touching
 * operation, and the fix is mechanical, not per-site discipline: all child
 * env flows through `tests/e2e/spawn-isolated.ts`.
 *
 * A helper nobody is forced to use decays, so this test scans the suite for
 * raw CLI spawns that bypass the chokepoint and fails:
 *
 * - Rule A (no raw bundle references): no file outside the allowlist may
 *   name the CLI bundle (`"dist/index.js"`, `"dist/cli/index.js"`) or the
 *   `VIBEFLOW_E2E_CLI` override. To spawn the CLI you must name the bundle —
 *   unless you import it from the helper, which is the point. Allowlist:
 *   the chokepoint itself, the canary script (own temp HOME + tripwire
 *   below), and `readme-assets.test.ts` (asserts on the dist file inventory,
 *   never spawns).
 * - Rule B (no cwd-anchored dist): no `process.cwd()`-adjacent `dist`
 *   reference. The invoker cwd differs from the package root whenever a spec
 *   runs by absolute path, so cwd-anchored resolution lies depending on
 *   where you stand — anchor at `import.meta.url` via the helper.
 * - Rule C (no raw env spread): no `...process.env` in the test tree. A raw
 *   spread re-inherits HOME, GIT vars, and redirects; the chokepoint rebuilds the env
 *   field by field instead.
 * - Rule D (canary tripwire): `scripts/operation-drift-canary.mjs` is .mjs
 *   and cannot import the TS helper, so it carries its own copy of the
 *   isolation — this rule pins its temp HOME, ceiling, and GIT_* sweep so a
 *   regression here fails loudly.
 *
 * Non-vacuity: each rule was proven to bite by committing a temporary bad
 * fixture (raw spawn / cwd-anchored path / raw spread / gutted canary env)
 * and watching the corresponding assertion go red; fixtures removed after.
 * To re-prove, add any one of those to the scanned tree and run this file.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI_ROOT = join(HERE, "..", "..");
const REPO_ROOT = join(CLI_ROOT, "..", "..");

const THIS_FILE = join("packages", "cli", "tests", "unit", "cli-spawn-guard.test.ts");

/** Files allowed to name the CLI bundle (Rule A), repo-root-relative. */
const BUNDLE_ALLOWLIST = new Set([
  join("packages", "cli", "tests", "e2e", "spawn-isolated.ts"),
  join("scripts", "operation-drift-canary.mjs"),
  // Asserts on the dist file inventory (expected sizes); never spawns.
  join("packages", "cli", "tests", "unit", "readme-assets.test.ts"),
]);

function walk(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "node_modules" || entry === "dist") continue;
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, exts));
    else if (exts.some((e) => full.endsWith(e))) out.push(full);
  }
  return out;
}

/**
 * Strip block + line comments (quote-aware, so `https://…` inside a string
 * cannot truncate the line and hide a violation later on it).
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const BUNDLE_LITERAL = /["']dist\/(?:cli\/)?index\.js["']/;
// Segmented construction: join(…, "dist", "index.js") / join(…, "dist",
// "cli", "index.js") — the same bundle reference without a single literal.
const BUNDLE_SEGMENTS = /["']dist["']\s*,\s*(?:["']cli["']\s*,\s*)?["']index\.js["']/;
const E2E_CLI_IDENT = /(^|[^A-Za-z0-9_$])VIBEFLOW_E2E_CLI([^A-Za-z0-9_$]|$)/;
const CWD_DIST = /process\.cwd\(\)/;
const RAW_SPREAD = /\.\.\.process\.env/;

function scanTargets(): string[] {
  const files: string[] = [];
  for (const sub of ["e2e", "playwright", "integration", "unit", "helpers", "setup"]) {
    const dir = join(CLI_ROOT, "tests", sub);
    if (existsSync(dir)) files.push(...walk(dir, [".ts"]));
  }
  const rootScripts = join(REPO_ROOT, "scripts");
  if (existsSync(rootScripts)) files.push(...walk(rootScripts, [".mjs"]));
  return files;
}

describe("cli spawn-isolation guard (ticket 8ac96ef9)", () => {
  it("Rule A — no raw CLI-bundle references outside the allowlist", () => {
    const offenders: string[] = [];
    for (const file of scanTargets()) {
      const rel = relative(REPO_ROOT, file);
      if (rel === THIS_FILE) continue;
      if (BUNDLE_ALLOWLIST.has(rel)) continue;
      const code = stripComments(readFileSync(file, "utf-8"));
      if (BUNDLE_LITERAL.test(code) || BUNDLE_SEGMENTS.test(code) || E2E_CLI_IDENT.test(code)) {
        offenders.push(rel);
      }
    }
    expect(
      offenders,
      `raw CLI bundle reference outside tests/e2e/spawn-isolated.ts — ` +
        `import the entry + env from the helper instead:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("Rule B — no process.cwd()-anchored dist resolution in tests", () => {
    const offenders: string[] = [];
    for (const file of scanTargets()) {
      if (!file.endsWith(".ts")) continue;
      const rel = relative(REPO_ROOT, file);
      if (rel === THIS_FILE) continue;
      const code = stripComments(readFileSync(file, "utf-8"));
      const bad = code.split("\n").some((line) => CWD_DIST.test(line) && line.includes("dist"));
      if (bad) offenders.push(rel);
    }
    expect(
      offenders,
      `cwd-anchored dist path — anchor at import.meta.url via the helper:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("Rule C — no raw ...process.env spread in the test tree", () => {
    const offenders: string[] = [];
    for (const file of scanTargets()) {
      if (!file.endsWith(".ts")) continue;
      const rel = relative(REPO_ROOT, file);
      if (rel === THIS_FILE) continue;
      const code = stripComments(readFileSync(file, "utf-8"));
      if (RAW_SPREAD.test(code)) offenders.push(rel);
    }
    expect(
      offenders,
      `raw ...process.env spread re-inherits HOME, GIT vars, redirects — ` +
        `build the child env with isolatedCliEnv:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("Rule D — the .mjs canary keeps its own isolation (temp HOME + ceiling + GIT_* sweep)", () => {
    const canary = readFileSync(join(REPO_ROOT, "scripts", "operation-drift-canary.mjs"), "utf-8");
    expect(canary, "canary lost its temp HOME").toContain("vf-canary-home-");
    expect(canary, "canary lost its GIT_* sweep").toMatch(/startsWith\("GIT_"\)/);
    expect(canary, "canary lost its ceiling pin").toContain("GIT_CEILING_DIRECTORIES");
    expect(canary, "canary spawns outside isolatedEnv()").toContain("isolatedEnv()");
    expect(canary, "canary reintroduced a raw env spread").not.toMatch(/\.\.\.process\.env/);
  });
});
