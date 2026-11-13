import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { KanbanTaskCard } from "../src";
import type { Task, TaskStatus } from "../src";
import { expectNoA11yViolations } from "./a11y";
import { themeDecorator } from "../.storybook/ThemeDecorator";

/**
 * The kanban card. This story used to render the legacy `KanbanCard`, which
 * P16 retired; it now renders the shared `KanbanTaskCard` — the component the
 * CLI board, the overlay and the hosted dashboard board all use. Keeping the
 * story (rather than deleting it with the old component) keeps this surface
 * covered in all six themes.
 */
const task: Task = {
  id: "task-1",
  title: "Wire the six-theme decorator",
  description: "Proof story for the TaskCard skeleton.",
  status: "in-progress" as TaskStatus,
  type: "Task",
  priority: "High",
  commentCount: 3,
  fileCount: 1,
  links: [],
};

const col = {
  id: "in-progress" as TaskStatus,
  label: "In Progress",
  color: "var(--t-status-progress)",
  accent: "var(--t-status-progress)",
};

const meta: Meta<typeof KanbanTaskCard> = {
  title: "Design System/TaskCard",
  component: KanbanTaskCard,
  decorators: [themeDecorator],
  args: {
    task,
    col,
    allTasks: [task],
    onOpen: fn(),
    onOpenTask: fn(),
    onDragStart: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Skeleton: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText(task.title)).toBeVisible();
    await userEvent.click(canvas.getByText(task.title));
    await expect(args.onOpen).toHaveBeenCalled();
    await expectNoA11yViolations(canvasElement);
  },
};
