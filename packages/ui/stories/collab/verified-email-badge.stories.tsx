import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { VerifiedEmailBadge } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/**
 * Tri-state verified flag (ticket h4vehyus). `null` is a real state — rows
 * whose query did not select the flag must stay unbadged, not look unverified.
 */
const meta: Meta<typeof VerifiedEmailBadge> = {
  title: "Design System/Collab/VerifiedEmailBadge",
  component: VerifiedEmailBadge,
  decorators: [themeDecorator],
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Verified: Story = {
  args: { verified: true, label: "ana@example.test" },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    expect(canvasElement.querySelector('[data-testid="member-verified"]')).not.toBeNull();
  },
};

export const Unverified: Story = {
  args: { verified: false, label: "ana@example.test" },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    expect(canvasElement.querySelector('[data-testid="member-unverified"]')).not.toBeNull();
  },
};

export const Unknown: Story = {
  args: { verified: null },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    // Unselected must render nothing: a badge here would assert "unverified".
    expect(canvasElement.textContent?.trim()).toBe("");
  },
};
