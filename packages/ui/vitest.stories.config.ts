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
