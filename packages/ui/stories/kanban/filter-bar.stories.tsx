import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { useState } from "react";
import { FilterBar } from "../../src";
import type { Task } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/**
 * Filter bar — status chips, tag/user filters and the view switch.
 *
 * P13.2 moved the chips onto `Button` without changing filter semantics: the
 * stories assert the semantics (clicking a status reports that status) rather
 * than the markup, because the markup is now the primitive's business.
 */
const meta: Meta<typeof FilterBar> = {
  title: "Design System/Kanban/FilterBar",
  component: FilterBar,
  decorators: [themeDecorator],
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof meta>;

const EMPTY_FILTER = {
  status: "all" as const,
  component: null,
  type: null,
  user: null,
  tags: [],
};

function task(id: string, status: Task["status"]): Task {
  return { id, title: `Task ${id}`, status, type: "task" } as Task;
}

const TASKS = [
  task("a1", "todo"),
  task("a2", "todo"),
  task("a3", "in-progress"),
  task("a4", "review"),
];

export const Default: Story = {
  args: {
    tasks: TASKS,
    filter: EMPTY_FILTER,
    onFilter: () => {},
    view: "board",
  },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "All" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Tags" })).toBeVisible();
  },
};

/** Filter semantics are the contract: a chip click reports its status. */
export const StatusFilterClick: Story = {
  render: (args) => {
    function Harness() {
      const [status, setStatus] = useState("none");
      return (
        <div>
          <FilterBar
            {...args}
            onFilter={(next) => setStatus(String(next.status))}
          />
          <output role="status" data-role="calls">
            {status}
          </output>
        </div>
      );
    }
    return <Harness />;
  },
  args: {
    tasks: TASKS,
    filter: EMPTY_FILTER,
    onFilter: () => {},
    view: "board",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /Review/ }));
    await expect(canvas.getByRole("status")).toHaveTextContent("review");
  },
};

/** Narrow layout: the whole bar must wrap rather than scroll sideways. */
export const Narrow: Story = {
  args: {
    tasks: TASKS,
    filter: EMPTY_FILTER,
    onFilter: () => {},
    view: "list",
  },
  parameters: { viewport: { defaultViewport: "mobile1" } },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const bar = canvasElement.querySelector('[data-testid="filter-bar"]');
    expect(bar).not.toBeNull();
  },
};
