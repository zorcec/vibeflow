import type { StorybookConfig } from "@storybook/react-vite";

// Local-only harness (owner decision #11): no publish, no Docker, no deploy.
// Stories live in packages/ui/stories/ (outside src/) so the file-deps check
// that compares src/ against consumers never sees them.
const config: StorybookConfig = {
    stories: ["../stories/**/*.stories.@(ts|tsx)"],
    addons: [
        "@storybook/addon-docs",
        "@storybook/addon-a11y",
        "@storybook/addon-themes",
        "@storybook/addon-vitest",
    ],
    framework: {
        name: "@storybook/react-vite",
        options: {},
    },
};

export default config;
