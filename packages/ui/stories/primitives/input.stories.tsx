import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { Input } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/**
 * Input matrix — every type, both interactive states and the error contract.
 *
 * Every story renders a real `<label htmlFor>`: without it axe reports the
 * input as unlabelled, and an unlabelled input is the failure real users hit
 * far more often than a wrong border colour.
 */
const meta: Meta<typeof Input> = {
  title: "Design System/Input",
  component: Input,
  decorators: [themeDecorator],
  render: (args) => (
    <div className="flex w-72 flex-col gap-1">
      <label htmlFor="field" className="text-xs text-text-muted">
        Field
      </label>
      <Input id="field" {...args} />
    </div>
  ),
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { placeholder: "Type here" },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const canvas = within(canvasElement);
    const field = canvas.getByLabelText("Field");
    await userEvent.type(field, "hello");
    await expect(field).toHaveValue("hello");
  },
};

export const Email: Story = {
  args: { type: "email", placeholder: "you@example.com" },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const field = within(canvasElement).getByLabelText("Field");
    await expect(field).toHaveAttribute("type", "email");
  },
};

export const Password: Story = {
  args: { type: "password", defaultValue: "secret" },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    await expect(within(canvasElement).getByLabelText("Field")).toHaveAttribute(
      "type",
      "password",
    );
  },
};

export const Search: Story = {
  args: { type: "search", placeholder: "Search" },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    await expect(within(canvasElement).getByLabelText("Field")).toHaveAttribute(
      "type",
      "search",
    );
  },
};

export const Number: Story = {
  args: { type: "number", defaultValue: 3 },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    await expect(within(canvasElement).getByLabelText("Field")).toHaveAttribute(
      "type",
      "number",
    );
  },
};

export const Disabled: Story = {
  args: { disabled: true, defaultValue: "locked" },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const field = within(canvasElement).getByLabelText("Field");
    await expect(field).toBeDisabled();
    await userEvent.type(field, "nope");
    // A disabled field must stay exactly as it was.
    await expect(field).toHaveValue("locked");
  },
};

export const Readonly: Story = {
  args: { readOnly: true, defaultValue: "read only" },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const field = within(canvasElement).getByLabelText("Field");
    await userEvent.type(field, "x");
    await expect(field).toHaveValue("read only");
  },
};

export const Error: Story = {
  args: { error: "Enter a valid address", defaultValue: "nope" },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const field = within(canvasElement).getByLabelText("Field");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    const describedBy = field.getAttribute("aria-describedby");
    await expect(describedBy).toBeTruthy();
    // The ids must resolve inside the rendered story, not merely be present.
    await expect(
      canvasElement.querySelector(`#${describedBy}`)?.textContent,
    ).toContain("Enter a valid address");
  },
};

/** Keyboard focus must produce a visible ring — asserted, not assumed. */
export const FocusVisible: Story = {
  args: { placeholder: "Tab to me" },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const field = within(canvasElement).getByLabelText("Field") as HTMLElement;
    field.focus();
    const cs = getComputedStyle(field);
    await expect(cs.outlineStyle).not.toBe("none");
    await expect(parseFloat(cs.outlineWidth)).toBeGreaterThan(0);
  },
};
