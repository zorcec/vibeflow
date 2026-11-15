import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { TaskDetailPanel } from "../../src";
import { task, ALL_STATUSES, STATUS_CONFIGS } from "../fixtures";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/** The detail drawer. Reviewed open and closed, because "closed" renders
 *  nothing and a broken open path would still pass a closed-only story. */
const meta: Meta<typeof TaskDetailPanel> = {
  title: "Design System/Kanban/TaskDetailPanel",
  component: TaskDetailPanel,
  decorators: [themeDecorator],
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof meta>;

const handlers = new Proxy(
  {},
  { get: () => () => {} },
) as Record<string, () => void>;

export const Open: Story = {
  args: { task: task(), open: true, statuses: STATUS_CONFIGS, handlers } as never,
  play: async ({ canvasElement }) => {
        // The modal portals to document.body, so the story canvas is EMPTY —
    // scoping here (not to canvasElement) is what makes the axe check see the
    // thing under review. Measured: asserting on the canvas passed while the
    // dialog was unrendered.
    const panel = document.body.querySelector('[data-role="task-detail-panel"]');
    expect(panel).not.toBeNull();
    await expectNoA11yViolations(document.body);
    // The title is an editable input, not text: assert what the panel actually
    // renders as text — the status ladder, the id and the description.
    expect(panel).toHaveTextContent("task-1");
    expect(panel).toHaveTextContent("Description");
    expect(panel).toHaveTextContent("In Progress");
  },
};

export const Closed: Story = {
  args: { task: task(), open: false, statuses: STATUS_CONFIGS, handlers } as never,
  play: async ({ canvasElement }) => {
        // The modal portals to document.body, so the story canvas is EMPTY —
    // scoping here (not to canvasElement) is what makes the axe check see the
    // thing under review. Measured: asserting on the canvas passed while the
    // dialog was unrendered.
    const panel = document.body.querySelector('[data-role="task-detail-panel"]') as HTMLElement;
    // The panel stays mounted (it slides in), so "closed" must be asserted on
    // the a11y contract: hidden from AT and out of the tab order. Before the
    // fix it was still reachable by keyboard.
    expect(panel).not.toBeNull();
    expect(panel).toHaveAttribute("aria-hidden", "true");
    expect(getComputedStyle(panel).visibility).toBe("hidden");
  },
};
