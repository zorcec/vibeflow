import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { InactivityVeil } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/**
 * The inactivity veil covers the board when the session goes quiet. It is
 * purely presentational: no props, no data, no timer.
 */
const meta: Meta<typeof InactivityVeil> = {
  title: "Design System/Collab/InactivityVeil",
  component: InactivityVeil,
  decorators: [themeDecorator],
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    expect(canvasElement.textContent).toContain("been away");
  },
};
