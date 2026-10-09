#!/usr/bin/env node
/**
 * Copies the image-codec wasm binaries (@jsquash, pure wasm — no native
 * deps) into dist/client/codecs/ so the CLI server can serve them to the
 * browser bundles at `/__vibeflow__/codecs/<name>`.
 *
 * The Emscripten JS glue is bundled (lazily evaluated); only these .wasm
 * binaries stay out of the bundles and load on first transform.
 *
 * Run automatically via the "prebuild" npm script.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(root, "package.json"));

const ASSETS = [
  "@jsquash/webp/codec/enc/webp_enc.wasm",
  "@jsquash/webp/codec/dec/webp_dec.wasm",
  "@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm",
];

const outDir = resolve(root, "dist/client/codecs");
mkdirSync(outDir, { recursive: true });

for (const spec of ASSETS) {
  let src;
  try {
    src = require.resolve(spec);
  } catch {
    // Fallback: workspace-relative (ui owns the @jsquash dependency).
    src = resolve(root, "../ui/node_modules", spec);
  }
  const name = spec.split("/").pop();
  copyFileSync(src, join(outDir, name));
  console.log(`[gen-codec-assets] ${name}`);
}
console.log("[gen-codec-assets] done");
