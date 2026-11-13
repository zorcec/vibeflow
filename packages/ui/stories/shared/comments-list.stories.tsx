import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { CommentsList } from "../../src";
import { task, comment, fileEntry, ALL_STATUSES } from "../fixtures";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/** Comment thread: regular, system trace, and soft-deleted entries. */
const meta: Meta<typeof CommentsList> = {
  title: "Design System/Shared/CommentsList",
  component: CommentsList,
  decorators: [themeDecorator],
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    comments: [
      comment({ id: "c1", author: "bo", authorName: "Bo Hansen", text: "First comment" }),
      comment({ id: "c2", author: "ana", authorName: "Ana Novak", text: "Reply", isOwnComment: true }),
    ],
    viewer: "ana",
  } as never,
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    expect(canvasElement).toHaveTextContent("First comment");
    expect(canvasElement).toHaveTextContent("Reply");
  },
};

export const WithSystemEntries: Story = {
  args: {
    comments: [
      comment({ id: "c1", text: "A real comment" }),
      comment({ id: "c2", text: "moved to review", type: "system", author: "system" }),
    ],
    viewer: "ana",
  } as never,
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    expect(canvasElement).toHaveTextContent("moved to review");
  },
};

export const Empty: Story = {
  args: { comments: [], viewer: "ana" } as never,
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    expect(canvasElement.textContent?.trim().length).toBeGreaterThan(0);
  },
};
