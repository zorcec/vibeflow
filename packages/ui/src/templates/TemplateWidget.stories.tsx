import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { TemplateWidget } from "./TemplateWidget";
import { expectNoA11yViolations } from "../../stories/a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/**
 * Quiet renders the default tone; Loud renders the accent tone. Each play
 * runs story-level axe, then clicks the action and asserts the payload.
 */
/* template-note:start
 * This file is the P8 scaffold template — inert here (Storybook only serves
 * `stories/*.stories.tsx`, so it never runs as a story) and excluded from
 * `tsc` (see tsconfig). The scaffold copies it apart from the
 * `TemplateWidget` rename and the three import-path rewrites noted in the
 * scaffold script. This block is stripped from scaffolded copies.
template-note:end */
const meta: Meta<typeof TemplateWidget> = {
  title: "Design System/TemplateWidget",
  component: TemplateWidget,
  decorators: [themeDecorator],
  args: {
    onAction: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Quiet: Story = {
  args: { label: "Quiet widget" },
  play: async ({ canvasElement, args }) => {
    await expectNoA11yViolations(canvasElement);
    const canvas = within(canvasElement);
    const action = canvas.getByTestId("TemplateWidget-action");
    await expect(action).toBeVisible();
    await expect(action).toHaveTextContent("Quiet widget");
    await userEvent.click(action);
    await expect(args.onAction).toHaveBeenCalledWith("Quiet widget");
  },
};

export const Loud: Story = {
  args: { label: "Loud widget", tone: "loud" },
  play: async ({ canvasElement, args }) => {
    await expectNoA11yViolations(canvasElement);
    const canvas = within(canvasElement);
    const action = canvas.getByTestId("TemplateWidget-action");
    await expect(action).toBeVisible();
    await expect(action).toHaveTextContent("Loud widget");
    await userEvent.click(action);
    await expect(args.onAction).toHaveBeenCalledWith("Loud widget");
  },
};
