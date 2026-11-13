import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { TagInput } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/** Tag editor: existing tags plus a suggestion list. */
const meta: Meta<typeof TagInput> = {
  title: "Design System/Shared/TagInput",
  component: TagInput,
  decorators: [themeDecorator],
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { tags: ["frontend"], allTags: ["frontend", "a11y", "backend"], onChange: () => {} },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const field = canvasElement.querySelector("input") as HTMLInputElement;
    expect(field).toBeVisible();
    expect(canvasElement).toHaveTextContent("frontend");
  },
};

export const Disabled: Story = {
  args: { tags: ["frontend"], allTags: [], onChange: () => {}, disabled: true },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    // A disabled editor renders no input at all (the field only exists when it
    // can be typed into), so the tags stay visible and read-only.
    expect(canvasElement.querySelector("input")).toBeNull();
    expect(canvasElement).toHaveTextContent("frontend");
  },
};
