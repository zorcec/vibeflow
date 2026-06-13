import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/e2e/**/*.test.ts"],
    pool: "threads",
    poolOptions: { threads: { maxThreads: 4, minThreads: 1 } },
    testTimeout: 30_000,
    hookTimeout: 15_000,
  },
});
