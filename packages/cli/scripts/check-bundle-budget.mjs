#!/usr/bin/env node
/**
 * Bundle budget check (P17).
 *
 * The design-system effort has no remote CI by decision (ADR-0004 here,
 * ADR-0007 in the private repo) — the local hooks are the gate. This script is
 * the cheap half: it compares the built board/overlay artefacts against the
 * committed numbers in `packages/cli/bundle-budget.json` and fails on growth.
 *
 * Why a committed budget rather than "smaller than last commit": the baseline
 * must be reviewable in the diff. A silent 40 KB growth shows up as a number
 * someone had to type.
 *
 * usage:
 *   node packages/cli/scripts/check-bundle-budget.mjs
 *   node packages/cli/scripts/check-bundle-budget.mjs --json
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const BUDGET_PATH = resolve(ROOT, "packages/cli/bundle-budget.json");
const JSON_OUT = process.argv.includes("--json");

function readBudget() {
  return JSON.parse(readFileSync(BUDGET_PATH, "utf8"));
}

function sizeOf(relPath) {
  const abs = resolve(ROOT, relPath);
  if (!existsSync(abs)) return null;
  return statSync(abs).size;
}

const budget = readBudget();
const rows = [];

for (const [relPath, spec] of Object.entries(budget.artifacts)) {
  const actual = sizeOf(relPath);
  rows.push({
    artifact: relPath.replace("packages/cli/", ""),
    actual,
    budget: spec.budget,
    delta: actual === null ? null : actual - spec.budget,
    ok: actual !== null && actual <= spec.budget,
    why: spec.why,
  });
}

// The overlay utility subset lives inside overlay-css.gen.ts; measure it from
// the generated constant so the subset itself cannot grow unnoticed.
const overlayGen = resolve(ROOT, "packages/cli/dist/client/overlay-css.gen.ts");
const genSource = existsSync(overlayGen)
  ? readFileSync(overlayGen, "utf8")
  : readFileSync(resolve(ROOT, "packages/cli/src/client/overlay-css.gen.ts"), "utf8");
const subsetMatch = genSource.match(/export const OVERLAY_UTIL_CSS = `([\s\S]*?)`;/);
const subsetBytes = subsetMatch ? Buffer.byteLength(subsetMatch[1], "utf8") : null;
const subsetSpec = budget.overlayUtilitySubset;
rows.push({
  artifact: "OVERLAY_UTIL_CSS (shadow-root utility subset)",
  actual: subsetBytes,
  budget: subsetSpec.budget,
  delta: subsetBytes === null ? null : subsetBytes - subsetSpec.budget,
  ok: subsetBytes !== null && subsetBytes <= subsetSpec.budget,
  why: subsetSpec.why,
});

const failed = rows.filter((row) => !row.ok);

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: failed.length === 0, rows }, null, 2));
} else {
  const width = Math.max(...rows.map((r) => r.artifact.length));
  console.log(`bundle budget (allowance ${budget.allowancePercent}%, measured ${budget.measuredAt})\n`);
  console.log(
    `${"artifact".padEnd(width)}  ${"current".padStart(9)}  ${"budget".padStart(9)}  ${"delta".padStart(9)}  status`,
  );
  for (const row of rows) {
    const current = row.actual === null ? "MISSING" : String(row.actual);
    const delta = row.delta === null ? "—" : (row.delta > 0 ? "+" : "") + row.delta;
    console.log(
      `${row.artifact.padEnd(width)}  ${current.padStart(9)}  ${String(row.budget).padStart(9)}  ${delta.padStart(9)}  ${row.ok ? "ok" : "OVER BUDGET"}`,
    );
  }
  if (failed.length) {
    console.error("\n✗ bundle budget exceeded:");
    for (const row of failed) {
      console.error(
        `  ${row.artifact}: ${row.actual ?? "missing"} > ${row.budget}${row.actual === null ? "" : ` (+${row.delta})`} — ${row.why}`,
      );
    }
    console.error(
      "\nIf the growth is intended, raise the number in packages/cli/bundle-budget.json IN THE SAME COMMIT and say why in the message.",
    );
  } else {
    console.log("\n✓ every artefact is within budget");
  }
}

process.exit(failed.length ? 1 : 0);
