import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within, userEvent } from "storybook/test";
import { DeleteConfirmDialog } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/** Delete dialog. `childCount > 0` is a different decision (what happens to
 *  the children), so it gets its own story rather than a prop default. */
const meta: Meta<typeof DeleteConfirmDialog> = {
  title: "Design System/Kanban/DeleteConfirmDialog",
  component: DeleteConfirmDialog,
  decorators: [themeDecorator],
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof meta>;

const base = { open: true, taskTitle: "A task", childCount: 0, onCancel: () => {}, onDelete: () => {} };

export const NoChildren: Story = {
  args: base,
  play: async ({ canvasElement }) => {
        // The modal portals to document.body, so the story canvas is EMPTY —
    // scoping here (not to canvasElement) is what makes the axe check see the
    // thing under review. Measured: asserting on the canvas passed while the
    // dialog was unrendered.
    await expectNoA11yViolations(document.body);
    expect(document.body).toHaveTextContent("A task");
  },
};

export const WithChildren: Story = {
  args: { ...base, childCount: 3 },
  play: async ({ canvasElement }) => {
        // The modal portals to document.body, so the story canvas is EMPTY —
    // scoping here (not to canvasElement) is what makes the axe check see the
    // thing under review. Measured: asserting on the canvas passed while the
    // dialog was unrendered.
    await expectNoA11yViolations(document.body);
    // The child decision must be visible, not implied.
    expect(document.body.textContent).toMatch(/3/);
  },
};

export const Failed: Story = {
  args: { ...base, error: "Delete failed." },
  play: async ({ canvasElement }) => {
        // The modal portals to document.body, so the story canvas is EMPTY —
    // scoping here (not to canvasElement) is what makes the axe check see the
    // thing under review. Measured: asserting on the canvas passed while the
    // dialog was unrendered.
    await expectNoA11yViolations(document.body);
    expect(document.body).toHaveTextContent("Delete failed.");
  },
};
