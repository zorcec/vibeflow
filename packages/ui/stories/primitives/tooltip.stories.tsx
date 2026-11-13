import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fireEvent, userEvent, waitFor, within } from "storybook/test";
import { Tooltip, Button } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/**
 * Tooltip matrix — sides, keyboard focus, long content, and the disabled-trigger
 * case (no tooltip at all, because a disabled control cannot be focused).
 */
const meta: Meta<typeof Tooltip> = {
  title: "Design System/Primitives/Tooltip",
  component: Tooltip,
  decorators: [themeDecorator],
};

export default meta;
type Story = StoryObj<typeof meta>;

const trigger = <Button variant="secondary">Hover or tab to me</Button>;

export const Top: Story = {
  args: { content: "Saves the board", side: "top", delay: 0, children: trigger },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const canvas = within(canvasElement);
    (canvas.getByRole("button") as HTMLElement).focus();
    const tip = await within(document.body).findByRole("tooltip");
    await expect(tip).toHaveTextContent("Saves the board");
    // Scope axe to the floating content: the popup is portalled to body, and
    // auditing body would flag Storybook's own chrome (`region`).
    await expectNoA11yViolations(
      (document.querySelector('[data-role="popover-popup"], [data-role="tooltip-popup"]') as HTMLElement) ?? canvasElement,
    );
  },
};

export const Bottom: Story = {
  args: { content: "Saves the board", side: "bottom", delay: 0, children: trigger },
  play: async ({ canvasElement }) => {
    (within(canvasElement).getByRole("button") as HTMLElement).focus();
    await expect(await within(document.body).findByRole("tooltip")).toBeVisible();
  },
};

export const Right: Story = {
  args: { content: "Saves the board", side: "right", delay: 0, children: trigger },
  play: async ({ canvasElement }) => {
    (within(canvasElement).getByRole("button") as HTMLElement).focus();
    await expect(await within(document.body).findByRole("tooltip")).toBeVisible();
  },
};

export const Left: Story = {
  args: { content: "Saves the board", side: "left", delay: 0, children: trigger },
  play: async ({ canvasElement }) => {
    (within(canvasElement).getByRole("button") as HTMLElement).focus();
    await expect(await within(document.body).findByRole("tooltip")).toBeVisible();
  },
};

export const LongContent: Story = {
  args: {
    content:
      "This hint is deliberately long so the popup has to wrap: it explains the whole destructive consequence before the user commits.",
    side: "top",
    delay: 0,
    children: trigger,
  },
  play: async ({ canvasElement }) => {
    (within(canvasElement).getByRole("button") as HTMLElement).focus();
    await expect(await within(document.body).findByRole("tooltip")).toBeVisible();
    // Scope axe to the floating content: the popup is portalled to body, and
    // auditing body would flag Storybook's own chrome (`region`).
    await expectNoA11yViolations(
      (document.querySelector('[data-role="popover-popup"], [data-role="tooltip-popup"]') as HTMLElement) ?? canvasElement,
    );
  },
};

/** Hover shows it too — not only keyboard focus. */
export const Hover: Story = {
  args: { content: "Saves the board", delay: 0, children: trigger },
  play: async ({ canvasElement }) => {
    const button = within(canvasElement).getByRole("button");
    // The primitive owns hover explicitly, so a real pointer move is enough.
    await userEvent.hover(button);
    await waitFor(() =>
      expect(within(document.body).queryByRole("tooltip")).not.toBeNull(),
    );
  },
};

/** A disabled trigger gets NO tooltip — it could never be focused. */
export const DisabledTrigger: Story = {
  args: {
    content: "Cannot use this",
    delay: 0,
    disabled: true,
    children: <Button variant="secondary" disabled>Disabled</Button>,
  },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const button = within(canvasElement).getByRole("button");
    await expect(button).toBeDisabled();
    await expect(button).not.toHaveAttribute("aria-describedby");
    await expect(within(document.body).queryByRole("tooltip")).toBeNull();
  },
};
