import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { KanbanListView } from "../../src";
import type { Task } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/**
 * List view — one row per task across all statuses (P15.2).
 *
 * Rows are standalone roots by owner decision, so the row hooks and the
 * collapse/add controls are the contract these stories pin.
 */
const meta: Meta<typeof KanbanListView> = {
  title: "Design System/Kanban/ListView",
  component: KanbanListView,
  decorators: [themeDecorator],
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof meta>;

function task(id: string, title: string, status: Task["status"]): Task {
  return { id, title, status, type: "task", links: [] } as Task;
}

const TASKS = [
  task("l1", "Wire the list rows", "todo"),
  task("l2", "Port the primitives", "in-progress"),
  task("l3", "Review the diff", "review"),
  task("l4", "Ship it", "done"),
];

const base = {
  tasks: TASKS,
  searchQuery: "",
  onOpenPanel: () => {},
  onAddTask: () => {},
  onDrop: () => {},
};

export const Default: Story = {
  args: base,
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Wire the list rows")).toBeInTheDocument();
    await expect(canvas.getByText("Ship it")).toBeInTheDocument();
  },
};

/** Mobile rows expose a status control — the native select is deliberate. */
export const Mobile: Story = {
  args: { ...base, mobile: true, onChangeStatus: () => {} },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const select = canvasElement.querySelector("select");
    expect(select).not.toBeNull();
    await expect(select).toHaveAttribute("aria-label");
    // The select must carry tokens, never the UA default box (regression
    // sgj3bggkhovwphrnq5gdmi26).
    const style = select!.getAttribute("style") ?? "";
    expect(style).toContain("var(--t-input)");
    expect(style).not.toContain("239, 239, 239");
  },
};

/** A status group collapses and expands through its toggle button. */
export const CollapseGroup: Story = {
  args: base,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const toggle = canvas.getByRole("button", { name: /Collapse todo/i });
    await userEvent.click(toggle);
    await expect(
      canvas.getByRole("button", { name: /Expand todo/i }),
    ).toBeInTheDocument();
  },
};

export const Empty: Story = {
  args: { ...base, tasks: [] },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    expect(canvasElement.querySelector('[data-role="task-card"]')).toBeNull();
  },
};
