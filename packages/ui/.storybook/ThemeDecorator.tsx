import type { Decorator } from "@storybook/react-vite";
import { withThemeByDataAttribute } from "@storybook/addon-themes";
import {
    THEME_REGISTRY,
    DEFAULT_THEME,
    getThemeDefinition,
} from "../src/kanban/theme-registry";

/**
 * Six-theme decorator (P5.1) — the single harness every primitive's stories
 * use. Driven by THEMES from the theme registry, so adding a theme is one
 * registry entry + one token block and the Storybook toolbar follows with no
 * edit here. Switches `data-theme` on `<html>`, matching the runtime board.
 */
const themes: Record<string, string> = Object.fromEntries(
    THEME_REGISTRY.map((entry) => [entry.name, entry.id]),
);

export const themeDecorator: Decorator = withThemeByDataAttribute({
    themes,
    defaultTheme: getThemeDefinition(DEFAULT_THEME).name,
    parentSelector: "html",
    attributeName: "data-theme",
});
