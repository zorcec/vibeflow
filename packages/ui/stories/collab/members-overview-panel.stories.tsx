import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within, userEvent } from "storybook/test";
import { MembersOverviewPanel } from "../../src";
import { member } from "../fixtures";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/** Workspace members, including the tri-state verified column. */
const meta: Meta<typeof MembersOverviewPanel> = {
  title: "Design System/Collab/MembersOverviewPanel",
  component: MembersOverviewPanel,
  decorators: [themeDecorator],
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    workspaceName: "Acme",
    onClose: () => {},
    members: [
      member({ userId: "u1", displayName: "Ana Novak", emailVerified: true }),
      member({ userId: "u2", displayName: "Bo Hansen", emailVerified: false }),
      member({ userId: "u3", displayName: "Cy Older", emailVerified: undefined }),
    ] as never,
  },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    expect(canvasElement).toHaveTextContent("Ana Novak");
    expect(canvasElement).toHaveTextContent("Members");
  },
};

export const Empty: Story = {
  args: { workspaceName: "Acme", onClose: () => {}, members: [] },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    // An empty roster must say so rather than render a bare panel.
    expect(canvasElement).toHaveTextContent("Members");
  },
};
