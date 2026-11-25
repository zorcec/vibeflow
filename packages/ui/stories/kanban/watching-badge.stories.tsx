import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { expectNoA11yViolations } from "../a11y";
import { WatchingBadge } from "../../src";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/**
 * The "Watching" badge (ticket cgor65lm): who follows this board's feed, and
 * on click, the live followers with what each last delivered (ticket ifhh7q2).
 *
 * Read-only by design — registration belongs to the follower process
 * (`vibeflow notifications --follow`), never to a browser tab. The component is
 * transport-agnostic (`endpoint` + `headers`), which is how the local board and
 * the hosted board share one badge.
 *
 * `TwoAgents` keeps the counts-only body an OLDER board answers (no
 * `subscribers` list): the popover must still render its per-user rows.
 * `WithActivity` proves the activity line, including the idle wording the UI
 * derives from a live heartbeat with a stale delivery.
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

/** The popover lists followers with their last delivered event, not counts. */
export const WithActivity: Story = {
  args: { endpoint: "/api/notifications/subscribers" },
  beforeEach: async () => {
    const now = Date.now();
    stubRoster({
      total: 2,
      byUser: [
        { user: "zorcec", agents: 1 },
        { user: "local", agents: 1 },
      ],
      byAgent: [
        { agent: "claude", count: 1 },
        { agent: "pi", count: 1 },
      ],
      subscribers: [
        {
          subscriberId: "sub_story_1",
          user: "zorcec",
          agent: "claude",
          registeredAt: now - 60_000,
          lastSeenAt: now - 2_000,
          activity: {
            type: "task.claim",
            taskId: "ifhh7q2jukxhqcrs5kfo6mb8",
            at: now - 12_000,
          },
        },
        {
          subscriberId: "sub_story_2",
          user: "local",
          agent: "pi",
          registeredAt: now - 600_000,
          lastSeenAt: now - 5_000,
          activity: {
            type: "task.comment",
            taskId: "ifhh7q2jukxhqcrs5kfo6mb8",
            at: now - 6 * 60_000,
          },
        },
      ],
    });
  },
  play: async ({ canvasElement }) => {
    try {
      await expectNoA11yViolations(canvasElement);
      const canvas = within(canvasElement);
      await userEvent.click(
        canvas.getByRole("button", { name: "Watching 2 agents" }),
      );
      const popover = await canvas.findByRole("dialog", {
        name: "Agents following this board",
      });
      expect(popover.textContent ?? "").toContain("task.claim");
      expect(popover.textContent ?? "").toContain("ifhh7q2");
      expect(popover.textContent ?? "").toContain("idle, watching");
    } finally {
      restoreFetch?.();
    }
  },
};
