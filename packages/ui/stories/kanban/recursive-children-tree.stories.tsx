import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { RecursiveChildrenTree } from "../../src";
import { task, comment, fileEntry, ALL_STATUSES } from "../fixtures";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/** Parent → children → grandchildren, the tree the detail panel expands. */
const meta: Meta<typeof RecursiveChildrenTree> = {
  title: "Design System/Kanban/RecursiveChildrenTree",
  component: RecursiveChildrenTree,
  decorators: [themeDecorator],
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof meta>;

const parent = task({ id: "p", title: "Parent" });
// Children are found by the child's `parent` LINK, not a parentId field.
const child = task({ id: "c", title: "Child", links: [{ taskId: "p", type: "parent" }] } as never);
const grandchild = task({ id: "g", title: "Grandchild", links: [{ taskId: "c", type: "parent" }] } as never);

export const TwoLevels: Story = {
  args: { parentId: "p", allTasks: [parent, child, grandchild], variant: "inline" } as never,
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    expect(canvasElement).toHaveTextContent("Child");
    expect(canvasElement).toHaveTextContent("Grandchild");
  },
};

export const NoChildren: Story = {
  args: { parentId: "p", allTasks: [parent], variant: "inline" } as never,
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    expect(canvasElement.textContent?.trim()).toBe("");
  },
};
