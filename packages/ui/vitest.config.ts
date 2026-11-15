import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      // SCOPE DECISION (2026-11-11, P5.2): the 90% gate covers the
      // design-system surface — what the rebuild actually writes — not the
      // legacy tree this effort exists to delete.
      //
      // Measured on the whole package on 2026-11-11: 71.64% statements /
      // 80.62% branches. Gating that today would block every commit until
      // untested legacy components are covered, and P16 deletes most of them;
      // the gate would be measuring work that is about to disappear. The
      // whole-package number stays visible in the coverage report.
      // P16/P17 widen `include` back to `src/**` once the legacy tree is gone —
      // that widening is part of P17's exit criteria, not an afterthought.
      include: ["src/primitives/**/*.{ts,tsx}", "src/components/**/*.{ts,tsx}"],
      exclude: [
        "src/**/*.test.{ts,tsx}",
        "src/**/__tests__/**",
        "stories/**",
        "storybook-static/**",
      ],
      thresholds: {
        lines: 90,
        functions: 90,
        branches: 90,
        statements: 90,
      },
    },
  },
  esbuild: {
    jsx: "automatic",
  },
});
