import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

/**
 * CLI ESM build — runs AFTER tsup.config.ts so that
 * overlay-bundle.gen.ts and kanban-bundle.gen.ts are already populated.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist/cli",
  clean: false,
  sourcemap: false,
  minify: true,
  dts: true,
  banner: { js: "#!/usr/bin/env node" },
  // Playwright is a runtime dependency that cannot be bundled by esbuild
  // (chromium-bidi has deep CJS requires). Mark it external so it's
  // resolved at runtime via node_modules.
  external: ["playwright", "playwright-core"],
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
    copyFileSync("dist/cli/index.js", "dist/index.js");
    try {
      copyFileSync("dist/cli/index.d.ts", "dist/index.d.ts");
    } catch {
      /* optional */
    }
    // Copy EVERY emitted runtime module from dist/cli into dist — no
    // hand-maintained allowlist.
    //
    // This used to be a regex allowlist
    // (`/^(chunk|workspace|files|review-gate|git|verify-attestation)-/`).
    // Forgetting to extend it when a new dynamic import landed shipped a broken
    // dist that neither the build nor the source-importing unit tests caught:
    // `verify-attestation` was emitted but never synced, so every
    // `vibeflow tasks --edit` crashed with ERR_MODULE_NOT_FOUND (ticket
    // afd745a3). A glob has no per-chunk list to forget.
    for (const f of rds("dist/cli/").filter(
      (n: string) => n.endsWith(".js") && n !== "index.js",
    )) {
      copyFileSync(`dist/cli/${f}`, `dist/${f}`);
    }
    // Fail the build loudly if the packaged entry references a module that is
    // not on disk. tests/e2e/tsup-chunk-sync.test.ts asserts the same invariant
    // against the packaged output; this stops a broken dist being produced at all.
    const specifiers = [
      ...readFileSync("dist/index.js", "utf-8").matchAll(
        /(?:import|from)\s*\(?\s*["'](\.\/[^"']+)["']/g,
      ),
    ].map((m) => m[1]);
    const missing = specifiers.filter((s) => !existsSync(`dist/${s.slice(2)}`));
    if (missing.length > 0) {
      throw new Error(
        `[tsup] dist/index.js references modules that were not synced: ${missing.join(", ")}`,
      );
    }
    for (const dir of ["dist", "dist/cli"]) {
      try {
        for (const f of rds(dir).filter((n: string) => n.endsWith(".map"))) {
          const { rmSync } = await import("node:fs");
          rmSync(`${dir}/${f}`, { force: true });
        }
      } catch {
        /* ignore */
      }
    }
    chmodSync("dist/index.js", 0o755);
    console.log("[tsup] Synced dist/index.js ← dist/cli/index.js");
  },
});
