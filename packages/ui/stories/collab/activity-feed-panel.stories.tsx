import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within, userEvent } from "storybook/test";
import { ActivityFeedPanel } from "../../src";
import { task } from "../fixtures";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/** The activity drawer: grouped by actor, newest first. */
const meta: Meta<typeof ActivityFeedPanel> = {
  title: "Design System/Collab/ActivityFeedPanel",
  component: ActivityFeedPanel,
  decorators: [themeDecorator],
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    tasks: [task()],
    currentUser: "ana",
    onClose: () => {},
    activityLog: [
      {
        id: "a1",
        taskId: "task-1",
        taskTitle: "A representative task",
        user: "bo",
        time: new Date(Date.now() - 60_000).toISOString(),
        action: "commented",
        detail: "Looks good",
      },
    ],
  },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    expect(canvasElement).toHaveTextContent("Activity");
    expect(canvasElement.textContent).toMatch(/bo/i);
  },
};

export const Empty: Story = {
  args: { tasks: [], currentUser: "ana", onClose: () => {} },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    expect(canvasElement.textContent?.trim().length).toBeGreaterThan(0);
  },
};
