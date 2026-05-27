import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
    pool: "threads",
    poolOptions: { threads: { maxThreads: 8, minThreads: 2 } },
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/client/overlay-bundle.gen.ts", "src/client/overlay-css.gen.ts", "src/client/kanban-bundle.gen.ts", "src/server/**"],
      thresholds: { lines: 80, functions: 80, branches: 75, statements: 80 },
    },
  },
});
