import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { AttentionBadge } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/**
 * The "needs attention" bell (ticket c3f1a9). Two states only: flagged and
 * not. Both are reviewed because the unflagged state renders NOTHING, and a
 * story that silently renders nothing looks identical to a broken one.
 */
const meta: Meta<typeof AttentionBadge> = {
  title: "Design System/Kanban/AttentionBadge",
  component: AttentionBadge,
  decorators: [themeDecorator],
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Flagged: Story = {
  args: { flagged: true },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const bell = canvasElement.querySelector('[data-attention-state="flagged"]');
    expect(bell).not.toBeNull();
    expect(bell).toHaveAttribute("aria-label", "Needs attention");
  },
};

export const NotFlagged: Story = {
  args: { flagged: false },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    // Renders nothing at all — an unflagged task shows no bell.
    expect(canvasElement.querySelector('[data-attention-state="flagged"]')).toBeNull();
    expect(canvasElement.textContent?.trim()).toBe("");
  },
};
