import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin";

const dirname =
    typeof __dirname !== "undefined"
        ? __dirname
        : path.dirname(fileURLToPath(import.meta.url));

// Interaction tests run as Vitest browser tests (headless chromium) via the
// Storybook vitest addon: each *.stories.tsx play function becomes a test.
export default defineConfig({
  // Pre-bundle axe: the first run after a cold install otherwise trips Vite's
  // dependency-optimisation round trip and reports phantom failures (measured
  // 2026-11-11: 5 "failures" that were gone on the next run).
  optimizeDeps: { include: ["axe-core"] },
    plugins: [
        storybookTest({
            configDir: path.join(dirname, ".storybook"),
        }),
    ],
    test: {
        name: "stories",
        browser: {
            enabled: true,
            headless: true,
            provider: "playwright",
            instances: [{ browser: "chromium" }],
        },
        setupFiles: [".storybook/vitest.setup.ts"],
    },
});
