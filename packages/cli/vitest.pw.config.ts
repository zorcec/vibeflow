import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/playwright/**/*.test.ts"],
    setupFiles: [
      "./tests/setup/disable-telemetry.ts",
      // Hermetic HOME (bug 072d6a8a): in-process boards must not merge the
      // operator's real ~/.vibeflow/settings.json (e.g. panelWidth) into
      // temp projects — it changes board geometry (kanban reflow test).
      // The setup keeps installed Playwright browsers visible (see file).
      "./tests/e2e/setup/hermetic-home.ts",
    ],
    testTimeout: 15_000,
    hookTimeout: 30_000,
    // Run test files in parallel — each file uses unique ports so there are no conflicts.
    // Capped at 4 concurrent files: each file boots its own kanban server +
    // headless chromium (~0.9GB per file measured), so 8-wide peaks at ~7.7GB
    // aggregate RSS and thrashes a shared dev box. 4-wide halves the peak
    // (~3.9GB) for ~1.7x wall time. Re-measure with /tmp/mem-sample.mjs if
    // the file count or per-file footprint changes materially.
    pool: "forks",
    poolOptions: { forks: { minForks: 2, maxForks: 4 } },
  },
});
