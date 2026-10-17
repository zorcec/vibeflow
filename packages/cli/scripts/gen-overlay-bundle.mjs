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
import { resolveDistDir } from "./lib/dist-dir.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const monorepoRoot = resolve(root, "../..");
const entry = resolve(root, "src/client/overlay-browser/index.ts");
// Staged builds (VIBEFLOW_DIST_DIR, ticket 328b5420) write here instead of
// the live dist/; the atomic-sync step carries the artifact across.
const outFile = resolve(resolveDistDir(root), "client/overlay-browser.js");
const genTs = resolve(root, "src/client/overlay-bundle.gen.ts");
const esbuild = resolve(monorepoRoot, "node_modules/.bin/esbuild");

// Build the overlay IIFE with esbuild so it is ready before tsup's parallel builds.
// Minify flags must match the overlay-browser entry in tsup.config.ts
// (minifyWhitespace + minifySyntax, identifiers intact): tests/unit/overlay.test.ts
// asserts on the compact string shape, and whichever of the two pipelines runs
// last wins — an unminified prebuild artifact left behind by an interrupted build
// used to poison every later `test` run and commit (ticket 7b9b5242).
// Do NOT use full --minify here: identifier mangling would rename functions
// the tests and tsup output keep (e.g. setupClickToAnnotate, submitTask).
execSync(
  `"${esbuild}" "${entry}" --bundle --format=iife --platform=browser --target=chrome90 --minify-whitespace --minify-syntax --define:import.meta.url='"file:///vibeflow-bundle/"' --outfile="${outFile}"`,
  { cwd: root, stdio: "inherit" },
);

const bundle = readFileSync(outFile, "utf-8");
writeFileSync(
  genTs,
  `// AUTO-GENERATED — run 'npm run build' to regenerate. Do not edit manually.\nexport const OVERLAY_BROWSER_BUNDLE = ${JSON.stringify(bundle)};\n`,
);
console.log("[gen-overlay-bundle] Generated src/client/overlay-bundle.gen.ts");
