import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { StatusBadge } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/** Status badge — every column label, so a rename shows up in review. */
const meta: Meta<typeof StatusBadge> = {
  title: "Design System/Kanban/StatusBadge",
  component: StatusBadge,
  decorators: [themeDecorator],
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof meta>;

const play = (label: string) => async ({ canvasElement }: { canvasElement: HTMLElement }) => {
  await expectNoA11yViolations(canvasElement);
  expect(canvasElement.textContent?.toLowerCase()).toContain(label);
};

export const Backlog: Story = { args: { status: "backlog" }, play: play("backlog") };
export const Todo: Story = { args: { status: "todo" }, play: play("todo") };
// `in_progress`, not `in-progress`: the underscore is the stored key, and a
// hyphen silently fell back to Todo.
export const InProgress: Story = { args: { status: "in_progress" }, play: play("progress") };
export const Review: Story = { args: { status: "review" }, play: play("review") };
export const Done: Story = { args: { status: "done" }, play: play("done") };
export const Cancelled: Story = { args: { status: "cancelled" }, play: play("cancelled") };
