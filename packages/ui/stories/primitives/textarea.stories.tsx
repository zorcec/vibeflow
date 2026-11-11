import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { Textarea } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/**
 * Textarea matrix — rows, resize modes, auto-expand, and the same error
 * contract as Input. Every story labels the field, so axe cannot report a
 * missing label and the story proves the association the ticket requires.
 */
const meta: Meta<typeof Textarea> = {
  title: "Design System/Textarea",
  component: Textarea,
  decorators: [themeDecorator],
  render: (args) => (
    <div className="flex w-72 flex-col gap-1">
      <label htmlFor="area" className="text-xs text-text-muted">
        Notes
      </label>
      <Textarea id="area" {...args} />
    </div>
  ),
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { placeholder: "Write something" },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const field = within(canvasElement).getByLabelText("Notes");
    await userEvent.type(field, "line one");
    await expect(field).toHaveValue("line one");
  },
};

export const Rows: Story = {
  args: { rows: 6 },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    await expect(within(canvasElement).getByLabelText("Notes")).toHaveAttribute(
      "rows",
      "6",
    );
  },
};

export const ResizeBoth: Story = {
  args: { resize: "both" },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const cls = within(canvasElement).getByLabelText("Notes").className;
    await expect(cls).toContain("resize");
    await expect(cls).not.toContain("resize-y");
  },
};

/** autoExpand must grow the rendered box with the content, measured. */
export const AutoExpand: Story = {
  args: { autoExpand: true, rows: 1 },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const field = within(canvasElement).getByLabelText("Notes") as HTMLTextAreaElement;
    const before = field.getBoundingClientRect().height;
    await userEvent.type(field, "a{enter}b{enter}c{enter}d{enter}e");
    const after = field.getBoundingClientRect().height;
    // The box grew because the content did; a static box would keep `before`.
    await expect(after).toBeGreaterThan(before);
    await expect(field.style.height).not.toBe("");
  },
};

export const Disabled: Story = {
  args: { disabled: true, defaultValue: "locked" },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const field = within(canvasElement).getByLabelText("Notes");
    await expect(field).toBeDisabled();
    await userEvent.type(field, "nope");
    await expect(field).toHaveValue("locked");
  },
};

export const Readonly: Story = {
  args: { readOnly: true, defaultValue: "read only" },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const field = within(canvasElement).getByLabelText("Notes");
    await userEvent.type(field, "x");
    await expect(field).toHaveValue("read only");
  },
};

export const Error: Story = {
  args: { error: "This field is required", defaultValue: "" },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const field = within(canvasElement).getByLabelText("Notes");
    await expect(field).toHaveAttribute("aria-invalid", "true");
    const describedBy = field.getAttribute("aria-describedby");
    await expect(describedBy).toBeTruthy();
    await expect(
      canvasElement.querySelector(`#${describedBy}`)?.textContent,
    ).toContain("This field is required");
  },
};

export const FocusVisible: Story = {
  args: { placeholder: "Tab to me" },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const field = within(canvasElement).getByLabelText("Notes") as HTMLElement;
    field.focus();
    const cs = getComputedStyle(field);
    await expect(cs.outlineStyle).not.toBe("none");
    await expect(parseFloat(cs.outlineWidth)).toBeGreaterThan(0);
  },
};
