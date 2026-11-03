#!/usr/bin/env node
/**
 * Drift guard: README tool table vs machine-readable tool catalog.
 *
 * Compares the `Tool | What it does` table in the repo-root README.md
 * against `packages/cli/tool-catalog.json` (projected from
 * `packages/cli/src/mcp/manifest.ts` — see tests/unit/mcp/tool-catalog.test.ts).
 * Exit non-zero on any mismatch: never edit either surface by hand without
 * regenerating the other.
 *
 * Dependency-free by design (only node:fs / node:path) so it runs anywhere.
 *
 * Usage: node scripts/check-tool-docs.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const README = path.join(ROOT, "README.md");
const CATALOG = path.join(ROOT, "packages", "cli", "tool-catalog.json");

const catalog = JSON.parse(fs.readFileSync(CATALOG, "utf8"));
const catalogNames = catalog.map((e) => e.name);

const readme = fs.readFileSync(README, "utf8");
const tableBlock = readme.match(/### Tools\n\n(\|.*\n)+/);
if (!tableBlock) {
  console.error("check-tool-docs: ### Tools table not found in README.md");
  process.exit(1);
}
const readmeNames = [...tableBlock[0].matchAll(/^`?\| `([a-z_]+)` \|/gm)].map(
  (m) => m[1],
);

const missing = catalogNames.filter((n) => !readmeNames.includes(n));
const extra = readmeNames.filter((n) => !catalogNames.includes(n));
const orderDrift =
  missing.length === 0 &&
  extra.length === 0 &&
  readmeNames.join(",") !== catalogNames.join(",");

let failed = false;
for (const n of missing) {
  console.error(`check-tool-docs: catalog tool missing from README table: ${n}`);
  failed = true;
}
for (const n of extra) {
  console.error(`check-tool-docs: README row has no catalog tool (phantom?): ${n}`);
  failed = true;
}
if (orderDrift) {
  console.error(
    "check-tool-docs: README row order differs from catalog (manifest) order.\n" +
      `  catalog: ${catalogNames.join(",")}\n  readme:  ${readmeNames.join(",")}`,
  );
  failed = true;
}
if (failed) {
  console.error(
    "check-tool-docs: regenerate the catalog (UPDATE_TOOL_CATALOG=1 vitest run tests/unit/mcp/tool-catalog.test.ts) and update the README table to match.",
  );
  process.exit(1);
}
console.log(`check-tool-docs: OK — ${catalogNames.length} tools in sync.`);
