import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { KanbanTaskCard as TaskCard } from "../../src";
import type { Column, Task } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/**
 * TaskCard matrix — the composite P13.1 rebuilt on the primitives.
 *
 * These stories guard what the four ported stylesheet-text tests can no longer
 * see from jsdom: that the card still renders the `data-role` hooks the CLI
 * browser suite binds to, and that it stays axe-clean in every theme.
 */
const meta: Meta<typeof TaskCard> = {
  title: "Design System/Kanban/TaskCard",
  component: TaskCard,
  decorators: [themeDecorator],
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof meta>;

const COL: Column = {
  id: "todo",
  label: "Todo",
  color: "var(--t-status-todo)",
  accent: "var(--t-chip-amber-300)",
};

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: "abc123def456",
    title: "Rebuild the task card on primitives",
    description: "Keep every data-* hook and drag result identical.",
    status: "todo",
    type: "task",
    priority: "medium",
    ...overrides,
  } as Task;
}

const noop = () => {};

function renderCard(props: Record<string, unknown> = {}) {
  const t = task();
  return (
    <div className="w-80">
      <TaskCard
        task={t}
        col={COL}
        allTasks={[t]}
        onOpen={noop}
        onDragStart={noop}
        {...props}
      />
    </div>
  );
}

export const Default: Story = {
  render: () => renderCard(),
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const canvas = within(canvasElement);
    // The title element is the card's identity hook, bound by
    // CardTitle.tooltip.test.tsx and the CLI board assertions.
    const title = canvasElement.querySelector('[data-role="card-title"]');
    expect(title).not.toBeNull();
    expect(title).toHaveTextContent("Rebuild the task card on primitives");
    // The copy-id affordance renders the id inside a button, not as bare text.
    expect(canvasElement.querySelector('[data-role="copy-id"]')).not.toBeNull();
  },
};

export const Compact: Story = {
  render: () => renderCard({ compact: true }),
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    expect(
      canvasElement.querySelector('[data-role="card-title"]'),
    ).not.toBeNull();
  },
};

/** The advance control exists only when the host passes the callback. */
export const WithAdvanceControl: Story = {
  render: () => renderCard({ onAdvanceTask: noop }),
  play: async ({ canvasElement }) => {
    const advance = canvasElement.querySelector('[data-role="advance-task"]');
    expect(advance).not.toBeNull();
    expect(advance).toHaveAttribute("data-next-status");
    await expectNoA11yViolations(canvasElement);
  },
};

/** Without the callback the control must not render (ListView contract). */
export const WithoutAdvanceControl: Story = {
  render: () => renderCard(),
  play: async ({ canvasElement }) => {
    expect(canvasElement.querySelector('[data-role="advance-task"]')).toBeNull();
  },
};

/**
 * Loading state. This lived in a second, top-level `TaskCard` story whose
 * title duplicated "Design System/Kanban/TaskCard" — two entries for one
 * component is exactly the confusion the organisation pass was for.
 */
export const Skeleton: Story = {
  render: () => renderCard({ onOpen: fn() }),
  play: async ({ canvasElement }) => {
    // No optional chrome at all: the title hook the hosted board binds must
    // still be there, and the card must stay accessible.
    await expectNoA11yViolations(canvasElement);
    expect(canvasElement.querySelector('[data-role="card-title"]')).not.toBeNull();
    expect(within(canvasElement).getByText(task().title)).toBeVisible();
  },
};
