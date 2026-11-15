import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { PriorityBadge } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/** Priority chip: one story per priority so the colour ladder is reviewable. */
const meta: Meta<typeof PriorityBadge> = {
  title: "Design System/Kanban/PriorityBadge",
  component: PriorityBadge,
  decorators: [themeDecorator],
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof meta>;

const play = (label: string) => async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  await expectNoA11yViolations(canvasElement);
  expect(canvasElement).toHaveTextContent(label);
};

// The stored values are capitalised. A lowercase value renders NOTHING (the
// component returns null for unknown keys), so a story that silently rendered
// a blank canvas would have "passed" review.
export const Critical: Story = { args: { priority: "Critical" }, play: play("Critical") };
export const High: Story = { args: { priority: "High" }, play: play("High") };
export const Medium: Story = { args: { priority: "Medium" }, play: play("Medium") };
export const Low: Story = { args: { priority: "Low" }, play: play("Low") };
export const Unknown: Story = {
  args: { priority: "not-a-priority" },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    expect(canvasElement.textContent?.trim()).toBe("");
  },
};
