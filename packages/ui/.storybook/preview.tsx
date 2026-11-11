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
};

export default preview;
