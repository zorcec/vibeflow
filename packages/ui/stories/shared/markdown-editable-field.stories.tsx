import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { MarkdownEditableField } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/** Description field: write mode and preview mode. */
const meta: Meta<typeof MarkdownEditableField> = {
  title: "Design System/Shared/MarkdownEditableField",
  component: MarkdownEditableField,
  decorators: [themeDecorator],
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof meta>;

const base = {
  value: "Some **markdown**",
  onChange: () => {},
  showPreview: false,
  setShowPreview: () => {},
  placeholder: "Describe the task",
};

export const Write: Story = {
  args: base as never,
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    expect(canvasElement.querySelector("textarea")).not.toBeNull();
  },
};

export const Preview: Story = {
  args: { ...base, showPreview: true } as never,
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    expect(canvasElement.querySelector("textarea")).toBeNull();
    expect(canvasElement.querySelector("strong")).not.toBeNull();
  },
};

export const PreviewEmpty: Story = {
  args: { ...base, value: "", showPreview: true, previewEmptyText: "Nothing yet" } as never,
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    expect(canvasElement).toHaveTextContent("Nothing yet");
  },
};
