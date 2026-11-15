import type { StorybookConfig } from "@storybook/react-vite";
import tailwindcss from "@tailwindcss/vite";

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
    // Compiles .storybook/preview.css (the Tailwind v4 entrance) in both
    // `storybook build` and the vitest story run, which serves stories
    // through the same Storybook vite pipeline.
    viteFinal: async (config) => {
        config.plugins = [...(config.plugins ?? []), tailwindcss()];
        return config;
    },
};

export default config;
