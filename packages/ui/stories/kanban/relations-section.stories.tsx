import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { RelationsSection } from "../../src";
import type { Task } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/**
 * Relations section — the grouped children/parents/blocks/related list in the
 * detail panel (P15.1). Its rows are buttons and its headers toggle groups;
 * the stories keep the a11y surface covered.
 */
const meta: Meta<typeof RelationsSection> = {
  title: "Design System/Kanban/RelationsSection",
  component: RelationsSection,
  decorators: [themeDecorator],
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof meta>;

const PARENT = {
  id: "rel-parent",
  title: "Parent task",
  status: "todo",
  type: "task",
  links: [],
} as unknown as Task;

const CHILD = {
  id: "rel-child",
  title: "Child task",
  status: "in-progress",
  type: "task",
  links: [{ type: "parent", taskId: "rel-parent" }],
} as unknown as Task;

export const WithChildren: Story = {
  args: {
    task: PARENT,
    allTasks: [PARENT, CHILD],
    onUpdateLinks: () => {},
    onOpenTask: () => {},
  },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    // The section renders its groups directly (no toggle): the child link on
    // the CHILD task is what puts a row under CHILDREN.
    await expect(canvasElement.textContent).toContain("Child task");
  },
};

export const Empty: Story = {
  args: {
    task: PARENT,
    allTasks: [PARENT],
    onUpdateLinks: () => {},
  },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    expect(canvasElement).toBeTruthy();
  },
};
