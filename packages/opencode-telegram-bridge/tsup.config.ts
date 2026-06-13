import { defineConfig } from "tsup";

export default defineConfig([
  // Library build (no shebang)
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    target: "node22",
    outDir: "dist",
    clean: true,
    sourcemap: false,
    dts: true,
    esbuildOptions(options) {
      options.conditions = ["node", "import", "module"];
    },
  },
  // CLI build (with shebang)
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    target: "node22",
    outDir: "dist",
    clean: false,
    sourcemap: false,
    dts: false,
    banner: {
      js: "#!/usr/bin/env node",
    },
    esbuildOptions(options) {
      options.conditions = ["node", "import", "module"];
    },
    onSuccess: async () => {
      const { chmodSync } = await import("node:fs");
      chmodSync("dist/cli.js", 0o755);
      console.log("[tsup] Build complete");
    },
  },
]);
