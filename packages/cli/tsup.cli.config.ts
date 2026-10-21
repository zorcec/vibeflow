import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

/**
 * CLI ESM build — runs AFTER tsup.config.ts so that
 * overlay-bundle.gen.ts and kanban-bundle.gen.ts are already populated.
 *
 * DIST honours the atomic-build staging override (ticket 328b5420):
 * scripts/build-atomic.mjs sets VIBEFLOW_DIST_DIR=dist.next so the bundle
 * and the synced top-level copies land in the staging tree.
 */
const DIST = process.env.VIBEFLOW_DIST_DIR || "dist";
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  // Explicit node platform: without it a neutral/browser platform would let
  // esbuild inline CJS shims whose bare `require("crypto")` becomes a
  // runtime-throwing `__require` in ESM output ("Dynamic require of
  // \"crypto\" is not supported" — every CLI invocation dead on arrival
  // while the build itself stays green).
  platform: "node",
  target: "node22",
  outDir: `${DIST}/cli`,
  clean: false,
  sourcemap: false,
  minify: true,
  dts: true,
  // The `createRequire` shim keeps any residual CJS `require("crypto")`
  // (e.g. bundled CJS deps such as @noble/hashes pulled in via cuid2)
  // working under ESM, where esbuild's `__require` fallback would throw.
  // The shebang must stay the very first line.
  banner: {
    js: '#!/usr/bin/env node\nimport { createRequire as __vfCreateRequire } from "node:module"; const require = __vfCreateRequire(import.meta.url);',
  },
  // Playwright is a runtime dependency that cannot be bundled by esbuild
  // (chromium-bidi has deep CJS requires). Mark it external so it's
  // resolved at runtime via node_modules.
  // Node builtins stay external too, so the ESM output keeps
  // `import … from "node:crypto"` instead of emitting a CJS-interop
  // `require("crypto")` that throws at runtime.
  external: [
    "playwright",
    "playwright-core",
    /^node:/,
    "crypto",
    "fs",
    "path",
    "os",
    "util",
    "events",
    "stream",
    "child_process",
    "module",
  ],
  esbuildOptions(options) {
    try {
      const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as {
        version: string;
      };
      options.define = {
        ...options.define,
        __VIBEFLOW_CLI_VERSION__: JSON.stringify(pkg.version),
      };
    } catch (err) {
      throw new Error(`Failed to read package.json: ${err}`);
    }
  },
  onSuccess: async () => {
    const {
      copyFileSync,
      chmodSync,
      existsSync,
      readFileSync,
      readdirSync: rds,
    } = await import("node:fs");
    copyFileSync(`${DIST}/cli/index.js`, `${DIST}/index.js`);
    try {
      copyFileSync(`${DIST}/cli/index.d.ts`, `${DIST}/index.d.ts`);
    } catch {
      /* optional */
    }
    // Copy EVERY emitted runtime module from the cli dir into the output
    // root — no hand-maintained allowlist.
    //
    // This used to be a regex allowlist
    // (`/^(chunk|workspace|files|review-gate|git|verify-attestation)-/`).
    // Forgetting to extend it when a new dynamic import landed shipped a broken
    // dist that neither the build nor the source-importing unit tests caught:
    // `verify-attestation` was emitted but never synced, so every
    // `vibeflow tasks --edit` crashed with ERR_MODULE_NOT_FOUND (ticket
    // afd745a3). A glob has no per-chunk list to forget.
    for (const f of rds(`${DIST}/cli/`).filter(
      (n: string) => n.endsWith(".js") && n !== "index.js",
    )) {
      copyFileSync(`${DIST}/cli/${f}`, `${DIST}/${f}`);
    }
    // Fail the build loudly if the packaged entry references a module that is
    // not on disk. tests/e2e/tsup-chunk-sync.test.ts asserts the same invariant
    // against the packaged output; this stops a broken dist being produced at all.
    const specifiers = [
      ...readFileSync(`${DIST}/index.js`, "utf-8").matchAll(
        /(?:import|from)\s*\(?\s*["'](\.\/[^"']+)["']/g,
      ),
    ].map((m) => m[1]);
    const missing = specifiers.filter((s) => !existsSync(`${DIST}/${s.slice(2)}`));
    if (missing.length > 0) {
      throw new Error(
        `[tsup] ${DIST}/index.js references modules that were not synced: ${missing.join(", ")}`,
      );
    }
    for (const dir of [DIST, `${DIST}/cli`]) {
      try {
        for (const f of rds(dir).filter((n: string) => n.endsWith(".map"))) {
          const { rmSync } = await import("node:fs");
          rmSync(`${dir}/${f}`, { force: true });
        }
      } catch {
        /* ignore */
      }
    }
    chmodSync(`${DIST}/index.js`, 0o755);
    console.log(`[tsup] Synced ${DIST}/index.js ← ${DIST}/cli/index.js`);
  },
});
