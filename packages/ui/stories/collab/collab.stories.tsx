import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { VerifiedEmailBadge, UserAvatar, InactivityVeil } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/**
 * Collaboration primitives (P17d.1). All three are data-free: they render what
 * they are handed and never fetch, which is the rule for living in the public
 * package. `UserAvatar` takes its photo renderer as a prop so this package
 * never depends on `next/image`.
 */
const meta: Meta<typeof UserAvatar> = {
  title: "Design System/Collab",
  component: UserAvatar,
  decorators: [themeDecorator],
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof meta>;

/** Initials fallback — no image, deterministic colour from the name hash. */
export const AvatarInitials: Story = {
  args: { user: "Ada Lovelace" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("AL")).toBeTruthy();
    await expectNoA11yViolations(canvasElement);
  },
};

/** Photo path through the injected renderer — proves the next/image seam. */
export const AvatarWithImage: Story = {
  args: {
    user: "Grace Hopper",
    imageUrl: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
    size: 32,
    imageComponent: (props: {
      src: string;
      alt: string;
      width: number;
      height: number;
      style?: React.CSSProperties;
      title?: string;
    }) => <img {...props} data-testid="injected-image" />,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const img = canvas.getByTestId("injected-image");
    await expect(img.getAttribute("alt")).toBe("Grace Hopper");
    await expectNoA11yViolations(canvasElement);
  },
};

/** Tri-state verified flag: true renders the check, false the muted marker. */
export const VerifiedBadge: StoryObj<typeof VerifiedEmailBadge> = {
  render: () => (
    <div style={{ display: "flex", gap: 12 }}>
      <VerifiedEmailBadge verified={true} />
      <VerifiedEmailBadge verified={false} />
      <VerifiedEmailBadge verified={null} />
    </div>
  ),
  play: async ({ canvasElement }) => {
    // null renders nothing at all — the MembersOverview contract. The two that
    // do render are the testids the admin rows bind to.
    const verified = canvasElement.querySelectorAll("[data-testid='member-verified']");
    const unverified = canvasElement.querySelectorAll("[data-testid='member-unverified']");
    await expect(verified.length).toBe(1);
    await expect(unverified.length).toBe(1);
    await expectNoA11yViolations(canvasElement);
  },
} as unknown as StoryObj<typeof VerifiedEmailBadge>;

/** The away veil is purely visual: it must never be a hit target. */
export const AwayVeil: StoryObj<typeof InactivityVeil> = {
  render: () => (
    <div style={{ position: "relative", width: 320, height: 180 }}>
      <InactivityVeil />
    </div>
  ),
  play: async ({ canvasElement }) => {
    // It is aria-hidden and purely visual: the assertion that matters is that
    // it cannot be clicked through (the xpm4z3n3 "click twice" regression).
    const veil = canvasElement.querySelector("[aria-hidden='true']") as HTMLElement | null;
    await expect(veil).not.toBeNull();
    await expect(getComputedStyle(veil as HTMLElement).pointerEvents).toBe("none");
  },
} as unknown as StoryObj<typeof InactivityVeil>;
