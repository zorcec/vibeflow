import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { TaskDetailsTab } from "../../src";
import { task, ALL_STATUSES, STATUS_CONFIGS } from "../fixtures";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/** The details tab: priority, type, tags and the description editor. */
const meta: Meta<typeof TaskDetailsTab> = {
  title: "Design System/Shared/TaskDetailsTab",
  component: TaskDetailsTab,
  decorators: [themeDecorator],
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof meta>;

const base = {
  task: task(),
  description: task().description,
  setDescription: () => {},
  showDescPreview: false,
  setShowDescPreview: () => {},
  priority: "medium",
  setPriority: () => {},
  onDescriptionBlur: () => {},
  statuses: STATUS_CONFIGS,
};

export const Default: Story = {
  args: base as never,
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    // The title is an editable input; assert the labels that ARE text.
    expect(canvasElement).toHaveTextContent("Description");
    expect(canvasElement).toHaveTextContent("Priority");
  },
};
