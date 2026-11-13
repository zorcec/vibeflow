import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
// Not re-exported from the package root yet, so the story imports the module
// directly (stories are not subject to the app-side deep-import rule).
import { CopyIdButton } from "../../src/kanban/components/CopyIdButton";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/** Copy-id affordance, hidden until the row is hovered unless revealed. */
const meta: Meta<typeof CopyIdButton> = {
  title: "Design System/Kanban/CopyIdButton",
  component: CopyIdButton,
  decorators: [themeDecorator],
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { taskId: "abc123def456" },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const button = canvasElement.querySelector("button");
    expect(button).not.toBeNull();
    expect(button).toHaveAttribute("aria-label", "Copy task id");
  },
};

export const Revealed: Story = {
  // `revealed` only means anything in edge mode: the flag collapses/restores
  // the full-height tab, and without `edge` there is no tab to collapse.
  args: { taskId: "abc123def456", edge: true, revealed: true },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const button = canvasElement.querySelector("button") as HTMLElement;
    // `revealed` drives opacity/width rather than display, so assert the
    // mechanism: the story canvas has no kanban.css, so layout-based
    // visibility would be measuring the missing stylesheet, not the prop.
    expect(button.style.opacity).toBe("1");
  },
};

export const Collapsed: Story = {
  args: { taskId: "abc123def456", edge: true, revealed: false },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const button = canvasElement.querySelector("button") as HTMLElement;
    // Zero-width and transparent at rest — the row must reserve no gutter.
    expect(button.style.opacity).toBe("0");
    expect(button.style.width).toBe("0px");
  },
};
