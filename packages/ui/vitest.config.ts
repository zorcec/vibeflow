import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary", "html"],
      // Package scope only: stories/ live outside src/ (file-deps boundary),
      // storybook-static/ is a git-ignored build artefact, and __tests__/
      // holds the guards themselves (matrix manifest, a11y sweep).
      include: ["src/**/*.{ts,tsx}"],
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
