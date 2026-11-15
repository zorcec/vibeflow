import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within, userEvent } from "storybook/test";
import { ActivityCounter } from "../../src";
import { task } from "../fixtures";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/** The unseen-activity badge. The badge only exists when the count is > 0,
 *  which is exactly the state a screenshot can silently miss. */
const meta: Meta<typeof ActivityCounter> = {
  title: "Design System/Collab/ActivityCounter",
  component: ActivityCounter,
  decorators: [themeDecorator],
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const NoActivity: Story = {
  args: { tasks: [task()], currentUser: "ana", onClick: () => {} },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    expect(canvasElement.querySelector('[data-role="activity-unseen"]')).toBeNull();
  },
};

export const UnseenActivity: Story = {
  args: {
    tasks: [task()],
    currentUser: "ana",
    lastCheckAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    activityLog: [
      {
        id: "a1",
        taskId: "task-1",
        taskTitle: "A representative task",
        user: "bo",
        time: new Date(Date.now() - 60_000).toISOString(),
        action: "commented",
      },
    ],
    onClick: () => {},
  },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const badge = canvasElement.querySelector('[data-role="activity-unseen"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe("1");
  },
};
