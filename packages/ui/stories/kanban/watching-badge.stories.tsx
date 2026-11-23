import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect } from "storybook/test";
import { expectNoA11yViolations } from "../a11y";
import { WatchingBadge } from "../../src";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/**
 * The "Watching" badge (ticket cgor65lm): how many agents follow this board's
 * feed, and on click, how many per user.
 *
 * Read-only by design — registration belongs to the follower process
 * (`vibeflow notifications --follow`), never to a browser tab. The component is
 * transport-agnostic (`endpoint` + `headers`), which is how the local board and
 * the hosted board share one badge.
 *
 * The roster route is stubbed in `beforeEach`, BEFORE the component mounts:
 * the badge reads once on mount and renders nothing until that read succeeds
 * (a board without the route must never paint a wrong 0), so a stub installed
 * inside `play` would arrive after the very read it was meant to answer.
 */
const meta: Meta<typeof WatchingBadge> = {
  title: "Design System/Kanban/WatchingBadge",
  component: WatchingBadge,
  decorators: [themeDecorator],
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof meta>;

let restoreFetch: (() => void) | null = null;

/** Stub the board's roster route until the originating story restores it. */
function stubRoster(body: unknown): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = original;
    restoreFetch = null;
  };
}

export const TwoAgents: Story = {
  args: { endpoint: "/api/notifications/subscribers" },
  beforeEach: async () => {
    stubRoster({
      total: 2,
      byUser: [{ user: "zorcec", agents: 2 }],
      byAgent: [
        { agent: "claude", count: 1 },
        { agent: "pi", count: 1 },
      ],
    });
  },
  play: async ({ canvasElement }) => {
    try {
      await expectNoA11yViolations(canvasElement);
      expect(canvasElement.textContent ?? "").toContain("2");
    } finally {
      restoreFetch?.();
    }
  },
};

export const NoneYet: Story = {
  args: { endpoint: "/api/notifications/subscribers" },
  beforeEach: async () => {
    stubRoster({ total: 0, byUser: [], byAgent: [] });
  },
  play: async ({ canvasElement }) => {
    try {
      await expectNoA11yViolations(canvasElement);
      // Nothing to watch: no count is painted (never a wrong one).
      const text = canvasElement.textContent ?? "";
      expect(text.includes("0") || text.trim() === "").toBe(true);
    } finally {
      restoreFetch?.();
    }
  },
};
