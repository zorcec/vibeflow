import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { TypeBadge } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/** Type chip — one story per declared type. */
const meta: Meta<typeof TypeBadge> = {
  title: "Design System/Kanban/TypeBadge",
  component: TypeBadge,
  decorators: [themeDecorator],
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof meta>;

const play = (label: string) => async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  await expectNoA11yViolations(canvasElement);
  expect(canvasElement.textContent?.toLowerCase()).toContain(label);
};

// Capitalised keys, like PriorityBadge.
export const Task: Story = { args: { type: "Task" }, play: play("task") };
export const Bug: Story = { args: { type: "Bug" }, play: play("bug") };
export const Research: Story = { args: { type: "Research" }, play: play("research") };
