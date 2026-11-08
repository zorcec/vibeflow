import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"],
    // Hermetic HOME (ticket cc18a82d) — globalSetup, NOT setupFiles:
    // threads-pool workers freeze os.homedir() at spawn, so the redirect
    // must happen in the main process before workers exist. See the file.
    globalSetup: ["./tests/setup/global-hermetic-home.ts"],
    setupFiles: ["./tests/setup/disable-telemetry.ts"],
    // Flaky-bucket reporter (child f3b5058e): alongside default output,
    // failures in `@flaky`-marked specs print as FLAKY (not failing the
    // gate) and append to the flake log. Reporting only — never alters
    // results or exit codes.
    reporters: ["default", "./tests/helpers/flaky-bucket.ts"],
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
        // Browser bundles are not unit-coverable, so they are excluded
        // from the node unit-coverage gate (same precedent as src/server/**,
        // which is covered by e2e instead). Rationale: everything under
        // src/client/** ships to the browser — the kanban board, the
        // overlay (see tsup.config.ts + scripts/gen-*-bundle.mjs entries) —
        // and executes only under DOM/browser APIs. It is exercised by the
        // Playwright suite (`test:browser`, 226 tests); the one-line
        // `export ... from "@vibeflow-tools/ui"` re-export shims are owned
        // and tested by the packages/ui suite (~800 tests), and a test that
        // merely imports a shim would be import-only smoke, not coverage.
        // Counting browser sources in the node unit run pins them at ~0-40%
        // no matter how thorough the unit suite is. tests/unit/client/**
        // still RUNS as regression guards; it just does not count here.
        "src/client/**",
      ],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
