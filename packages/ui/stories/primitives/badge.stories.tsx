import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { Badge, BADGE_TONES } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/**
 * Badge matrix — every variant × size, the full tone set, and the dot marker.
 *
 * The tone stories do more than render: they measure the resolved colour
 * against the token in TWO themes, because "it renders" is not evidence that a
 * token utility actually reached the element (a missing utility renders a
 * perfectly fine unstyled badge).
 */
const meta: Meta<typeof Badge> = {
  title: "Design System/Badge",
  component: Badge,
  decorators: [themeDecorator],
  args: { children: "Badge" },
};

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Each variant must apply its OWN token utility, and each size its own step —
 * asserted on the class list, because an absent attribute defaulting to the
 * expected value would make the check a tautology.
 */
const VARIANT_UTILITY: Record<string, RegExp> = {
  default: /\bbg-bg-raised\b/,
  secondary: /\bbg-hover\b/,
  outline: /\bbg-transparent\b/,
  danger: /\bbg-danger-soft\b/,
};
const SIZE_UTILITY: Record<string, RegExp> = {
  sm: /\btext-xs\b/,
  md: /\btext-sm\b/,
};

function matrixPlay(variant: string, size: string) {
  return async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await expectNoA11yViolations(canvasElement);
    const canvas = within(canvasElement);
    const badge = canvas.getByText("Badge");
    expect(badge).toBeVisible();
    expect(badge.className, `variant ${variant} utility`).toMatch(
      VARIANT_UTILITY[variant],
    );
    expect(badge.className, `size ${size} utility`).toMatch(SIZE_UTILITY[size]);
    expect(badge.className).not.toMatch(/\[[^\]]+\]/);
  };
}

export const DefaultSm: Story = {
  args: { variant: "default", size: "sm" },
  play: matrixPlay("default", "sm"),
};
export const DefaultMd: Story = {
  args: { variant: "default", size: "md" },
  play: matrixPlay("default", "md"),
};
export const SecondarySm: Story = {
  args: { variant: "secondary", size: "sm" },
  play: matrixPlay("secondary", "sm"),
};
export const SecondaryMd: Story = {
  args: { variant: "secondary", size: "md" },
  play: matrixPlay("secondary", "md"),
};
export const OutlineSm: Story = {
  args: { variant: "outline", size: "sm" },
  play: matrixPlay("outline", "sm"),
};
export const OutlineMd: Story = {
  args: { variant: "outline", size: "md" },
  play: matrixPlay("outline", "md"),
};
export const DangerSm: Story = {
  args: { variant: "danger", size: "sm" },
  play: matrixPlay("danger", "sm"),
};
export const DangerMd: Story = {
  args: { variant: "danger", size: "md" },
  play: matrixPlay("danger", "md"),
};

/** theme → hex, so a computed `rgb(...)` can be compared with a token value. */
function toRgb(value: string): string {
  const v = value.trim();
  const hex = /^#([0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
  }
  return v;
}

export const StatusTones: Story = {
  render: () => (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      {BADGE_TONES.map((tone) => (
        <Badge key={tone} tone={tone}>
          {tone}
        </Badge>
      ))}
    </div>
  ),
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await expectNoA11yViolations(canvasElement);
    const canvas = within(canvasElement);
    const root = document.documentElement;

    // Measured in two themes: the token VALUE changes, and the badge must
    // follow it. A badge whose utility never reached it keeps one colour in
    // both themes and fails here.
    const seen = new Map<string, string>();
    for (const theme of ["dark", "light"]) {
      root.setAttribute("data-theme", theme);
      const probe = canvas.getByText("status-todo");
      const computed = getComputedStyle(probe).color;
      const token = toRgb(
        getComputedStyle(root).getPropertyValue("--t-chip-amber-300"),
      );
      expect(computed, `${theme}: status-todo must wear --t-chip-amber-300`).toBe(token);
      seen.set(theme, computed);
    }
    // dark and light resolve the same chip token to different values; if they
    // were equal, the theme switch never happened and the loop proved nothing.
    expect(seen.get("dark")).not.toBe(seen.get("light"));
  },
};

export const WithDot: Story = {
  args: { variant: "secondary", size: "md", dot: true, children: "Live" },
  play: async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    await expectNoA11yViolations(canvasElement);
    const dot = canvasElement.querySelector('[data-role="badge-dot"]');
    expect(dot).not.toBeNull();
    expect(dot?.getAttribute("aria-hidden")).toBe("true");
  },
};
