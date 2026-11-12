import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { ChildRow } from "../../src";
import type { Task } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/**
 * Child row — the tree row inside an expanded card and the detail panel
 * (P15.1). The collapse toggle is now a `Button`; the row's drag wiring and
 * `data-role` hooks are untouched.
 */
const meta: Meta<typeof ChildRow> = {
  title: "Design System/Kanban/ChildRow",
  component: ChildRow,
  decorators: [themeDecorator],
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof meta>;

const CHILD = {
  id: "child-1",
  title: "A nested task",
  status: "todo",
  type: "task",
  links: [],
} as unknown as Task;

export const Inline: Story = {
  args: { child: CHILD, variant: "inline" },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const row = canvasElement.querySelector('[data-role="child-link-row"]');
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent("A nested task");
  },
};

/** Collapsible rows expose the toggle with its expanded state. */
export const Collapsible: Story = {
  args: {
    child: CHILD,
    variant: "inline",
    collapsible: true,
    collapsed: false,
    onToggleCollapsed: () => {},
  },
  play: async ({ canvasElement }) => {
    const toggle = canvasElement.querySelector(
      '[data-role="tree-node-toggle"]',
    );
    expect(toggle).not.toBeNull();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(toggle as Element);
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
  },
};

/** Unlink renders only when the host can actually patch the child. */
export const WithUnlink: Story = {
  args: {
    child: CHILD,
    variant: "inline",
    onRemove: () => {},
    removeTitle: "Unlink",
  },
  play: async ({ canvasElement }) => {
    const remove = canvasElement.querySelector(".relation-remove");
    expect(remove).not.toBeNull();
    await expect(remove).toHaveAttribute("aria-label");
  },
};
