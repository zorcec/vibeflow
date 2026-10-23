import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"],
    // Hermetic HOME (ticket cc18a82d) — globalSetup, NOT setupFiles:
    // threads-pool workers freeze os.homedir() at spawn, so the redirect
    // must happen in the main process before workers exist. See the file.
    globalSetup: ["./tests/setup/global-hermetic-home.ts"],
    setupFiles: ["./tests/setup/disable-telemetry.ts"],
    pool: "threads",
    poolOptions: { threads: { maxThreads: 8, minThreads: 2 } },
    testTimeout: 20000,
    hookTimeout: 30000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: [
        "src/client/overlay-bundle.gen.ts",
        "src/client/overlay-css.gen.ts",
        "src/client/kanban-bundle.gen.ts",
        "src/server/**",
      ],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
