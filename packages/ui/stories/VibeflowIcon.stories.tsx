import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { expectNoA11yViolations } from "./a11y";
import { VibeflowIcon } from "../src/VibeflowIcon";
import { themeDecorator } from "../.storybook/ThemeDecorator";

const meta: Meta<typeof VibeflowIcon> = {
    title: "Design System/VibeflowIcon",
    component: VibeflowIcon,
    decorators: [themeDecorator],
    argTypes: {
        size: { control: { type: "number", min: 16, max: 96 } },
    },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
    args: { size: 32 },
    play: async ({ canvasElement }) => {
        await expectNoA11yViolations(canvasElement);
        const canvas = within(canvasElement);
        const icon = canvas.getByRole("img", { name: "Vibeflow" });
        await expect(icon).toBeVisible();
    },
};

export const Large: Story = {
    args: { size: 64 },
    play: async ({ canvasElement }) => {
        await expectNoA11yViolations(canvasElement);
        const canvas = within(canvasElement);
        const icon = canvas.getByRole("img", { name: "Vibeflow" });
        await expect(icon).toBeVisible();
        await expect(icon).toHaveAttribute("width", "64");
    },
};
