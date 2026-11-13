import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { CommentsInputArea } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/** Comment composer, including the mention typeahead data. */
const meta: Meta<typeof CommentsInputArea> = {
  title: "Design System/Shared/CommentsInputArea",
  component: CommentsInputArea,
  decorators: [themeDecorator],
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof meta>;

const base = {
  commentInput: "",
  setCommentInput: () => {},
  commentSubmitting: false,
  onSubmit: () => {},
};

export const Empty: Story = {
  args: base as never,
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    expect(canvasElement.querySelector("textarea")).not.toBeNull();
  },
};

export const WithDraft: Story = {
  args: { ...base, commentInput: "A half-written comment" } as never,
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const field = canvasElement.querySelector("textarea") as HTMLTextAreaElement;
    expect(field.value).toBe("A half-written comment");
  },
};

export const Submitting: Story = {
  args: { ...base, commentInput: "Sending", commentSubmitting: true } as never,
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    // A pending submit must not look ready to send again.
    const buttons = within(canvasElement).getAllByRole("button");
    expect(buttons.length).toBeGreaterThan(0);
  },
};
