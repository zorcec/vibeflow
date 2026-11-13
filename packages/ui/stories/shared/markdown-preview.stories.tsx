import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { MarkdownPreview } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/** Rendered markdown, including the task-reference lookup. */
const meta: Meta<typeof MarkdownPreview> = {
  title: "Design System/Shared/MarkdownPreview",
  component: MarkdownPreview,
  decorators: [themeDecorator],
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { markdown: "# Heading\n\nSome **bold** and `code`.\n\n- one\n- two" },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    expect(canvasElement.querySelector("h1")).not.toBeNull();
    expect(canvasElement.querySelector("strong")).not.toBeNull();
  },
};

export const Empty: Story = {
  args: { markdown: "" },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    // Empty markdown renders the placeholder, not a bare empty box.
    expect(canvasElement).toHaveTextContent("No description yet");
  },
};

export const WithTaskReference: Story = {
  args: {
    markdown: "Blocked by abc12345",
    // `taskLookup` returns hover-card data, not a string.
    taskLookup: (id: string) =>
      id === "abc12345" ? { title: "The blocking task", status: "todo" } : undefined,
  },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    expect(canvasElement).toHaveTextContent("abc12345");
  },
};
