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
  esbuildOptions(options) {
    const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as { version: string };
    options.define = { ...options.define, __VIBEFLOW_CLI_VERSION__: JSON.stringify(pkg.version) };
  },
  onSuccess: async () => {
    const { copyFileSync, chmodSync, readdirSync: rds } = await import("node:fs");
    copyFileSync("dist/cli/index.js", "dist/index.js");
    try { copyFileSync("dist/cli/index.d.ts", "dist/index.d.ts"); } catch { /* optional */ }
    for (const f of rds("dist/cli/").filter((n: string) => /^(chunk|workspace|files)-/.test(n))) {
      try { copyFileSync(`dist/cli/${f}`, `dist/${f}`); } catch { /* ignore */ }
    }
    for (const dir of ["dist", "dist/cli"]) {
      try {
        for (const f of rds(dir).filter((n: string) => n.endsWith(".map"))) {
          rds; // eslint-disable-line
          const { rmSync } = await import("node:fs");
          rmSync(`${dir}/${f}`, { force: true });
        }
      } catch { /* ignore */ }
    }
    chmodSync("dist/index.js", 0o755);
    console.log("[tsup] Synced dist/index.js ← dist/cli/index.js");
  },
});
