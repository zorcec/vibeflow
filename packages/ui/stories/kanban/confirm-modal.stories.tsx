import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within, userEvent } from "storybook/test";
import { ConfirmModal } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/** Destructive confirmation. The loading and error states are the ones that
 *  decide whether a user can retry, so both are reviewed explicitly. */
const meta: Meta<typeof ConfirmModal> = {
  title: "Design System/Kanban/ConfirmModal",
  component: ConfirmModal,
  decorators: [themeDecorator],
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof meta>;

const base = { open: true, message: "Delete this task?", onConfirm: () => {}, onCancel: () => {} };

export const Default: Story = {
  args: base,
  play: async ({ canvasElement }) => {
        // The modal portals to document.body, so the story canvas is EMPTY —
    // scoping here (not to canvasElement) is what makes the axe check see the
    // thing under review. Measured: asserting on the canvas passed while the
    // dialog was unrendered.
    await expectNoA11yViolations(document.body);
    expect(document.body).toHaveTextContent("Delete this task?");
  },
};

export const Loading: Story = {
  args: { ...base, loading: true },
  play: async ({ canvasElement }) => {
        // The modal portals to document.body, so the story canvas is EMPTY —
    // scoping here (not to canvasElement) is what makes the axe check see the
    // thing under review. Measured: asserting on the canvas passed while the
    // dialog was unrendered.
    await expectNoA11yViolations(document.body);
    // A pending delete must not offer a second confirm click.
    const confirm = within(document.body)
      .getAllByRole("button")
      .find((b) => /deleting/i.test(b.textContent ?? ""));
    expect(confirm).toBeTruthy();
    expect(confirm).toBeDisabled();
  },
};

export const WithError: Story = {
  args: { ...base, error: "The server refused the delete." },
  play: async ({ canvasElement }) => {
        // The modal portals to document.body, so the story canvas is EMPTY —
    // scoping here (not to canvasElement) is what makes the axe check see the
    // thing under review. Measured: asserting on the canvas passed while the
    // dialog was unrendered.
    await expectNoA11yViolations(document.body);
    expect(document.body).toHaveTextContent("The server refused the delete.");
  },
};
