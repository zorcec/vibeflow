import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { KanbanTaskCard } from "../../src";
import type { Task, Column } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/**
 * TaskCard on the design-system primitives (P13.1) — the board card whose
 * buttons (advance chevron, footer actions, compact indicators) render
 * through Button and whose assignee/tag pills render through Badge, with
 * the data-* / drag contract byte-identical to the hand-rolled markup.
 *
 * Each story runs story-level axe first (structure, labels, roles), then
 * drives one user-visible behaviour and asserts it — the pattern from
 * stories/primitives/button.stories.tsx. Per-theme colour coverage stays
 * with the component sweep; the six-theme harness is the shared
 * `themeDecorator`.
 */
const task: Task = {
  id: "task-p131",
  title: "Rebuild TaskCard on the design-system primitives",
  description:
    "Buttons and badges render through Button/Badge; data-* and drag contracts stay byte-identical.",
  status: "in-progress",
  type: "Feature",
  priority: "High",
  commentCount: 3,
  fileCount: 1,
  tags: ["design-system", "kanban"],
  assigneeName: "Tomislav Zorčec",
};

const col: Column = {
  id: "in-progress",
  label: "In Progress",
  color: "#60a5fa",
  accent: "#60a5fa",
};

const meta: Meta<typeof KanbanTaskCard> = {
  title: "Kanban/TaskCard",
  component: KanbanTaskCard,
  decorators: [themeDecorator],
  args: {
    task,
    col,
    allTasks: [task],
    onOpen: fn(),
    onDragStart: fn(),
    onAdvanceTask: fn(),
    onToggleExpanded: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement, args }) => {
    await expectNoA11yViolations(canvasElement);
    const canvas = within(canvasElement);
    const title = canvas.getByText(task.title);
    await expect(title).toBeVisible();
    // The card face opens the detail panel — the single open path every
    // inner control must stopPropagation against.
    await userEvent.click(title);
    await expect(args.onOpen).toHaveBeenCalledWith(task);
  },
};

export const Compact: Story = {
  args: { compact: true },
  play: async ({ canvasElement, args }) => {
    await expectNoA11yViolations(canvasElement);
    const canvas = within(canvasElement);
    await expect(
      canvas.querySelector('article.task-card[data-compact="true"]'),
    ).not.toBeNull();
    // Nonzero counts inline with the title (0a2fa3d6).
    await expect(
      canvas.querySelector('[data-role="compact-comment-count"]'),
    ).toHaveTextContent("3");
    await expect(
      canvas.querySelector('[data-role="compact-file-count"]'),
    ).toHaveTextContent("1");
    // No copy pill in compact view — its 22px box would steal title width.
    await expect(
      canvas.queryByRole("button", { name: "Copy task id" }),
    ).toBeNull();
    // The comment indicator opens the comments tab, not the details tab.
    await userEvent.click(
      canvas.querySelector('[data-role="compact-comment-count"]')!,
    );
    await expect(args.onOpen).toHaveBeenCalledWith(task, "comments");
  },
};

export const AdvanceControl: Story = {
  play: async ({ canvasElement, args }) => {
    await expectNoA11yViolations(canvasElement);
    const canvas = within(canvasElement);
    const btn = canvas.getByRole("button", { name: "Move to Review" });
    await expect(btn).toHaveAttribute("data-role", "advance-task");
    await expect(btn).toHaveAttribute("data-next-status", "review");
    await expect(btn).toHaveAttribute("draggable", "false");
    btn.focus();
    await expect(btn).toHaveFocus();
    // Clicking advances through the board's status path and NEVER opens
    // the card — stopPropagation is the contract.
    await userEvent.click(btn);
    await expect(args.onAdvanceTask).toHaveBeenCalledWith(task.id, "review");
    await expect(args.onOpen).not.toHaveBeenCalled();
  },
};

const child: Task = {
  id: "child-p131",
  title: "Port the stylesheet-text tests",
  status: "todo",
  links: [{ type: "parent", taskId: task.id }],
};

export const ChildrenToggle: Story = {
  args: { allTasks: [task, child] },
  play: async ({ canvasElement, args }) => {
    await expectNoA11yViolations(canvasElement);
    const canvas = within(canvasElement);
    const chip = canvas.querySelector('[data-role="children-toggle"]');
    await expect(chip).not.toBeNull();
    await expect(chip).toHaveAttribute("aria-expanded", "false");
    // The chip toggles the persisted expansion and reports it — it must
    // not open the card.
    await userEvent.click(chip!);
    await expect(chip).toHaveAttribute("aria-expanded", "true");
    await expect(args.onToggleExpanded).toHaveBeenCalledWith(task.id, true);
    await expect(args.onOpen).not.toHaveBeenCalled();
  },
};
