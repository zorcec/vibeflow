import type { Preview } from "@storybook/react-vite";
import "./preview.css";
import "../src/kanban/themes.css";
import "../src/kanban/kanban.css";
import { themeDecorator } from "./ThemeDecorator";

// preview.css is the Tailwind v4 entrance: it imports tailwindcss FIRST,
// then primitives/theme.css (that file's consumer contract), so the
// token utilities (bg-bg, text-text, shadow-card, …) compile in stories.
// Compiled by @tailwindcss/vite via viteFinal in main.ts.
const preview: Preview = {
    decorators: [themeDecorator],
    tags: ["autodocs"],
    parameters: {
        /**
         * Automatic accessibility checks (audit A2).
         *
         * `@storybook/addon-a11y` was registered but only *reported*: a story
         * with an axe violation rendered fine and the suite stayed green, so
         * the panel was decoration. `test: "error"` turns every violation into
         * a failing story in `test:stories`, which means the six-theme sweep is
         * no longer the only thing standing between a regression and main.
         *
         * Kept at "error" deliberately: warnings are ignored, and an a11y
         * warning that nobody acts on is worse than a red test.
         */
        a11y: {
            test: "error",
        },
    },
};

export default preview;
