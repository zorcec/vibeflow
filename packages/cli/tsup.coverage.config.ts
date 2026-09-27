import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";

/**
 * COVERAGE-ONLY CLI build — never shipped, never part of `pnpm build`.
 *
 * Why it exists: the e2e suite spawns the CLI as a CHILD PROCESS, so v8
 * coverage collected by the vitest runner cannot see it. `NODE_V8_COVERAGE`
 * collects the child's counters, but those counters are attributed to whatever
 * file the child actually executed — and the shipped CLI is a MINIFIED bundle
 * with `sourcemap: false` whose `.map` files `tsup.cli.config.ts` actively
 * DELETES in `onSuccess`. Un-minified source that v8 attributes to
 * `src/index.ts` is therefore unreachable from the shipped artifact, and
 * `src/index.ts` coverage was stuck at whatever the in-process unit tests
 * happened to touch (~10%) no matter how much e2e exercised it.
 *
 * So this build differs from the shipped one in exactly the two properties
 * coverage needs and nothing else:
 *   - `sourcemap: true`  → the merge script can map bundle offsets back to
 *                          `src/index.ts` and its imports;
 *   - `minify: false`    → one statement per source statement, so the remap is
 *                          meaningful instead of pointing into a minified blob.
 *
 * Everything else (entry, format, target, externals, the build-time version
 * define) is copied from `tsup.cli.config.ts` on purpose: a coverage build that
 * bundles differently from the shipped one would measure a program nobody runs.
 *
 * `onSuccess` is deliberately ABSENT — the shipped config's copy step and its
 * "delete every .map" cleanup would remove the very map this build exists for.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  outDir: ".coverage-cli",
  clean: true,
  sourcemap: true,
  minify: false,
  dts: false,
  banner: { js: "#!/usr/bin/env node" },
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
});
