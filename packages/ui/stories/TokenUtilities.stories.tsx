import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { expectNoA11yViolations } from "./a11y";
import { themeDecorator } from "../.storybook/ThemeDecorator";

/**
 * Token-utility proof (design-system P5.x): this element is styled ONLY
 * with token utilities from primitives/theme.css (`bg-bg` + `text-text` —
 * no inline styles, no kanban.css classes). The play test asserts the
 * computed colours resolve to the theme's token values in two themes, so
 * a missing Tailwind entrance (uncompiled utilities → transparent /
 * inherited colour) fails loudly instead of rendering a lying story.
 */
function TokenSwatch() {
    return (
        <div data-testid="token-swatch" className="bg-bg text-text">
            Token swatch
        </div>
    );
}

const meta: Meta<typeof TokenSwatch> = {
    title: "Design System/Foundations/TokenUtilities",
    component: TokenSwatch,
    decorators: [themeDecorator],
};

export default meta;
type Story = StoryObj<typeof meta>;

// --t-bg / --t-text resolve through --p-bg / --p-text per theme:
// dark:  #020c1b / #e2e8f0 · light: #f8fafc / #0f172a.
export const TokenColours: Story = {
    play: async ({ canvasElement }) => {
        await expectNoA11yViolations(canvasElement);
        const canvas = within(canvasElement);
        const swatch = canvas.getByTestId("token-swatch");
        const root = document.documentElement;
        await expect(swatch).toBeVisible();

        root.setAttribute("data-theme", "dark");
        expect(getComputedStyle(swatch).backgroundColor).toBe(
            "rgb(2, 12, 27)",
        );
        expect(getComputedStyle(swatch).color).toBe("rgb(226, 232, 240)");

        root.setAttribute("data-theme", "light");
        expect(getComputedStyle(swatch).backgroundColor).toBe(
            "rgb(248, 250, 252)",
        );
        expect(getComputedStyle(swatch).color).toBe("rgb(15, 23, 42)");

        root.setAttribute("data-theme", "dark");
    },
};
