import { defineConfig } from "vitest/config";

export default defineConfig({
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
