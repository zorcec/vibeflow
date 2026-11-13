import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { Button } from "../../src";
import type { ButtonProps } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/**
 * Button matrix — every variant × size (Primary/Secondary/Ghost/Danger ×
 * Sm/Md/Lg) plus the Disabled and Loading states. Each play runs
 * story-level axe, then drives one user-visible behaviour and asserts it.
 */
const meta: Meta<typeof Button> = {
  title: "Design System/Primitives/Button",
  component: Button,
  decorators: [themeDecorator],
  args: {
    onClick: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

function labelFor(variant: string, size: string): string {
  return `${variant} ${size}`;
}

function matrixPlay(variant: string, size: string) {
  return async ({
    canvasElement,
    args,
  }: {
    canvasElement: HTMLElement;
    args: ButtonProps;
  }) => {
    await expectNoA11yViolations(canvasElement);
    const canvas = within(canvasElement);
    const action = canvas.getByRole("button");
    await expect(action).toBeVisible();
    await expect(action).toHaveTextContent(labelFor(variant, size));
    await userEvent.click(action);
    await expect(args.onClick).toHaveBeenCalledTimes(1);
  };
}

// NOTE: the story-matrix guard reads each export block as text and requires
// a literal `play:` — so the matrix stories spell out `play:` per export
// instead of sharing one `storyOf(...)` call site.
export const PrimarySm: Story = {
  args: { variant: "primary", size: "sm", children: labelFor("primary", "sm") },
  play: matrixPlay("primary", "sm"),
};
export const PrimaryMd: Story = {
  args: { variant: "primary", size: "md", children: labelFor("primary", "md") },
  play: matrixPlay("primary", "md"),
};
export const PrimaryLg: Story = {
  args: { variant: "primary", size: "lg", children: labelFor("primary", "lg") },
  play: matrixPlay("primary", "lg"),
};
export const SecondarySm: Story = {
  args: { variant: "secondary", size: "sm", children: labelFor("secondary", "sm") },
  play: matrixPlay("secondary", "sm"),
};
export const SecondaryMd: Story = {
  args: { variant: "secondary", size: "md", children: labelFor("secondary", "md") },
  play: matrixPlay("secondary", "md"),
};
export const SecondaryLg: Story = {
  args: { variant: "secondary", size: "lg", children: labelFor("secondary", "lg") },
  play: matrixPlay("secondary", "lg"),
};
export const GhostSm: Story = {
  args: { variant: "ghost", size: "sm", children: labelFor("ghost", "sm") },
  play: matrixPlay("ghost", "sm"),
};
export const GhostMd: Story = {
  args: { variant: "ghost", size: "md", children: labelFor("ghost", "md") },
  play: matrixPlay("ghost", "md"),
};
export const GhostLg: Story = {
  args: { variant: "ghost", size: "lg", children: labelFor("ghost", "lg") },
  play: matrixPlay("ghost", "lg"),
};
export const DangerSm: Story = {
  args: { variant: "danger", size: "sm", children: labelFor("danger", "sm") },
  play: matrixPlay("danger", "sm"),
};
export const DangerMd: Story = {
  args: { variant: "danger", size: "md", children: labelFor("danger", "md") },
  play: matrixPlay("danger", "md"),
};
export const DangerLg: Story = {
  args: { variant: "danger", size: "lg", children: labelFor("danger", "lg") },
  play: matrixPlay("danger", "lg"),
};

export const Disabled: Story = {
  args: { variant: "primary", size: "md", disabled: true, children: "Save" },
  play: async ({ canvasElement, args }) => {
    await expectNoA11yViolations(canvasElement);
    const canvas = within(canvasElement);
    const action = canvas.getByRole("button");
    await expect(action).toBeVisible();
    await expect(action).toBeDisabled();
    await userEvent.click(action);
    await expect(args.onClick).not.toHaveBeenCalled();
  },
};

export const Loading: Story = {
  args: { variant: "primary", size: "md", loading: true, children: "Save" },
  play: async ({ canvasElement, args }) => {
    await expectNoA11yViolations(canvasElement);
    const canvas = within(canvasElement);
    const action = canvas.getByRole("button");
    await expect(action).toBeVisible();
    await expect(action).toHaveAttribute("aria-busy", "true");
    await expect(action).toBeDisabled();
    await expect(canvas.getByTestId("Button-spinner")).toBeVisible();
    await userEvent.click(action);
    await expect(args.onClick).not.toHaveBeenCalled();
  },
};

export const KeyboardActivation: Story = {
  args: { variant: "primary", size: "md", children: "Save" },
  play: async ({ canvasElement, args }) => {
    await expectNoA11yViolations(canvasElement);
    const canvas = within(canvasElement);
    const action = canvas.getByRole("button");
    await expect(action).toBeVisible();
    action.focus();
    await userEvent.keyboard("{Enter}");
    await expect(args.onClick).toHaveBeenCalledTimes(1);
    await userEvent.keyboard(" ");
    await expect(args.onClick).toHaveBeenCalledTimes(2);
  },
};

export const KeyboardFocusRing: Story = {
  args: { variant: "primary", size: "md", children: "Save" },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const canvas = within(canvasElement);
    const action = canvas.getByRole("button") as HTMLElement;
    const resting = getComputedStyle(action).outlineWidth;
    await userEvent.tab();
    await expect(action).toHaveFocus();
    const focused = getComputedStyle(action).outlineWidth;
    // Keyboard focus must resolve the token-driven ring — a style the
    // resting button does not have.
    await expect(focused).not.toBe(resting);
  },
};
