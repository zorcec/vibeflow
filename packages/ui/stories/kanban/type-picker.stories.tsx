import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within, userEvent } from "storybook/test";
import { TypePicker } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/** Type selector used by the create form and the details tab. */
const meta: Meta<typeof TypePicker> = {
  title: "Design System/Kanban/TypePicker",
  component: TypePicker,
  decorators: [themeDecorator],
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { value: "task", onChange: () => {} },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    // A button-based picker with an aria-label, not a native <select>.
    expect(within(canvasElement).getByLabelText(/^Task type:/)).toBeVisible();
  },
};

export const Disabled: Story = {
  args: { value: "task", onChange: () => {}, disabled: true },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const trigger = within(canvasElement).getByLabelText(/^Task type:/);
    // The component gates opening in its click handler rather than with the
    // `disabled` attribute, so assert the OUTCOME: clicking opens nothing.
    await userEvent.click(trigger);
    expect(canvasElement.querySelector('[role="listbox"]')).toBeNull();
  },
};
