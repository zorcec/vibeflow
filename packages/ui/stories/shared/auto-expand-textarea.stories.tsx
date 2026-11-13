import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { AutoExpandTextarea } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/** Textarea that grows with its content instead of showing a scrollbar. */
const meta: Meta<typeof AutoExpandTextarea> = {
  title: "Design System/Shared/AutoExpandTextarea",
  component: AutoExpandTextarea,
  decorators: [themeDecorator],
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  args: { "aria-label": "Comment", value: "", onChange: () => {} },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const field = canvasElement.querySelector("textarea");
    expect(field).not.toBeNull();
    expect(field).toHaveAttribute("aria-label", "Comment");
  },
};

export const MultiLine: Story = {
  args: {
    "aria-label": "Comment",
    value: "line one\nline two\nline three\nline four",
    onChange: () => {},
  },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const field = canvasElement.querySelector("textarea") as HTMLTextAreaElement;
    expect(field.value.split("\n")).toHaveLength(4);
    // Grown, not clipped: the height follows the content.
    expect(field.style.height).not.toBe("");
  },
};
