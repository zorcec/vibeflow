import type { Preview } from "@storybook/react-vite";
import "../src/kanban/themes.css";
import "../src/kanban/kanban.css";
import { themeDecorator } from "./ThemeDecorator";

// NOTE: primitives/theme.css is intentionally NOT imported here. It carries
// `@theme inline` (Tailwind v4) and its consumer contract requires a Tailwind
// compilation entrance, which this local-only Storybook does not run. The
// proof stories below do not need Tailwind utilities.
const preview: Preview = {
    decorators: [themeDecorator],
    tags: ["autodocs"],
};

export default preview;
