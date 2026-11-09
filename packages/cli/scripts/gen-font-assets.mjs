#!/usr/bin/env node
/**
 * Copies the vendored Inter woff2 binaries (@vibeflow-tools/ui, the single
 * source of truth — ticket rrqdvoqkj5) into dist/client/fonts/ so the CLI
 * server can serve them to the board at `/__vibeflow__/fonts/<name>`.
 *
 * No base64 inlining (would inflate the inlined bundle), no CDN fetch:
 * same-origin bytes, long-cacheable like the codec wasm.
 *
 * Run automatically via scripts/build-atomic.mjs (staged builds honour
 * VIBEFLOW_DIST_DIR, same as gen-codec-assets.mjs).
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDistDir } from "./lib/dist-dir.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));

// Resolved from the workspace UI package (which owns the files), never
// downloaded — the bytes in dist are verbatim copies of the OFL-vendored
// files, so local and hosted render the same build of Inter.
const ASSETS = [
  "inter-300.woff2",
  "inter-400.woff2",
  "inter-500.woff2",
  "inter-600.woff2",
  "inter-700.woff2",
];

const outDir = resolve(resolveDistDir(root), "client/fonts");
mkdirSync(outDir, { recursive: true });

for (const name of ASSETS) {
  let src;
  try {
    // The woff2 files are NOT in ui's exports map (CSS/TS entry points
    // only), so resolve the package root and join — never a CDN download.
    const uiRoot = dirname(
      require.resolve("@vibeflow-tools/ui/package.json"),
    );
    src = join(uiRoot, "src", "kanban", "fonts", name);
  } catch {
    // Fallback: workspace-relative (ui owns the files).
    src = resolve(root, "../ui/src/kanban/fonts", name);
  }
  copyFileSync(src, join(outDir, name));
  console.log(`[gen-font-assets] ${name}`);
}
console.log("[gen-font-assets] done");
