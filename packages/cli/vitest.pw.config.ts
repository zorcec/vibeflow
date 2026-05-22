import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/playwright/**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 30_000,
    // Run test files in parallel — each file uses unique ports so there are no conflicts.
    pool: "forks",
    poolOptions: { forks: { minForks: 4, maxForks: 8 } },
  },
});
