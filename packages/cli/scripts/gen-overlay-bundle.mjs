#!/usr/bin/env node
/**
 * Generates src/client/overlay-bundle.gen.ts before the parallel tsup builds
 * start. Without this, the CLI tsup bundle would fail to resolve these
 * generated files since all tsup configs run in parallel.
 *
 * Run automatically via the "prebuild" npm script.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const monorepoRoot = resolve(root, "../..");
const entry = resolve(root, "src/client/overlay-browser/index.ts");
const outFile = resolve(root, "dist/client/overlay-browser.js");
const genTs = resolve(root, "src/client/overlay-bundle.gen.ts");
const esbuild = resolve(monorepoRoot, "node_modules/.bin/esbuild");

// Build the overlay IIFE with esbuild so it is ready before tsup's parallel builds
execSync(
  `"${esbuild}" "${entry}" --bundle --format=iife --platform=browser --target=chrome90 --outfile="${outFile}"`,
  { cwd: root, stdio: "inherit" },
);

const bundle = readFileSync(outFile, "utf-8");
writeFileSync(
  genTs,
  `// AUTO-GENERATED — run 'npm run build' to regenerate. Do not edit manually.\nexport const OVERLAY_BROWSER_BUNDLE = ${JSON.stringify(bundle)};\n`,
);
console.log("[gen-overlay-bundle] Generated src/client/overlay-bundle.gen.ts");
