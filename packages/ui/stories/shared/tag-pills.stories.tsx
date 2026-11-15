import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { TagPills } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/** Tag pills — read-only chips, with and without a remove affordance. */
const meta: Meta<typeof TagPills> = {
  title: "Design System/Shared/TagPills",
  component: TagPills,
  decorators: [themeDecorator],
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const ReadOnly: Story = {
  args: { tags: ["frontend", "a11y", "urgent"] },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    expect(canvasElement).toHaveTextContent("frontend");
    expect(canvasElement).toHaveTextContent("a11y");
  },
};

export const Removable: Story = {
  args: { tags: ["frontend", "a11y"], onRemove: () => {} },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    // One remove control per tag, and it must carry a name an AT can read.
    const removes = Array.from(canvasElement.querySelectorAll("button"));
    expect(removes.length).toBe(2);
    const named = removes.map((b) => b.getAttribute("aria-label") ?? b.textContent ?? "");
    expect(named.join(" ").toLowerCase()).toContain("frontend");
  },
};

export const Empty: Story = {
  args: { tags: [] },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    expect(canvasElement.textContent?.trim()).toBe("");
  },
};
