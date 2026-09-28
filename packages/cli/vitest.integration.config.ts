import { defineConfig } from "vitest/config";

// tests/integration/ drives several src modules through one flow
// (annotate → baseline → auth → verify → evidence) inside a temp
// project dir. It is deliberately NOT in vitest.config.ts: the default
// `test` run stays unit-only, because its count and coverage thresholds
// are what the release notes quote. Run it with `test:integration`.
export default defineConfig({
  test: {
    include: ["tests/integration/**/*.test.ts"],
    pool: "threads",
    poolOptions: { threads: { maxThreads: 8, minThreads: 2 } },
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
