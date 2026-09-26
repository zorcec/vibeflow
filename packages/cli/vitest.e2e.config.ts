import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";

// Mirror tsup.cli.config.ts: the e2e harness boots the MCP server
// in-process from src/, so src/version.ts needs the same build-time
// define the shipped bundle gets — otherwise serverInfo.version would
// advertise the "0.0.0" raw-TS fallback.
const pkg = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf-8"),
) as { version: string };

export default defineConfig({
  define: {
    __VIBEFLOW_CLI_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000, // match testTimeout — server-boot hooks flake under fork-pool load
    pool: "forks",
    poolOptions: {
      forks: {
        minForks: 4,
        maxForks: 8,
      },
    },
  },
});
