import { defineConfig } from "vitest/config";

// Variant-branch gate (design-system P5.2): 100% branch coverage over every
// variant definition file. A variant nobody renders is a variant nobody
// looked at: when the first cva primitive lands its variant map here, every
// branch must be exercised by the unit suite or this gate fails.
// Run with: pnpm --filter @vibeflow-tools/ui run coverage:variants
export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text"],
      include: ["src/**/variants.{ts,tsx}"],
      exclude: ["src/**/*.test.{ts,tsx}", "src/**/__tests__/**"],
      thresholds: {
        branches: 100,
      },
    },
  },
  esbuild: {
    jsx: "automatic",
  },
});
