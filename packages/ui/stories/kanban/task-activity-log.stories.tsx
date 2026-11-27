import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { expectNoA11yViolations } from "../a11y";
import { TaskActivityLog } from "../../src";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/**
 * The per-task activity log (ticket ylgq1p5o): the board's notification feed
 * narrowed with `?taskId=` (ticket p3tkodry), rendered as a record of what
 * happened to one task.
 *
 * Every story says something the ticket's honesty rule depends on:
 * - `Recent` — each row carries its age, and the header stamps the READ, so a
 *   list that stops refreshing can never pose as live;
 * - `Empty` — "no activity yet" only after a successful read;
 * - `Stale` — a failed refresh keeps the saved rows and turns the header into
 *   "couldn't refresh — read N s ago";
 * - `Evicted` — the feed says events older than its window are gone, and the
 *   log repeats it instead of implying a complete history.
 *
 * The feed route is stubbed in `beforeEach`, BEFORE the component mounts: the
 * log reads once on mount, and a stub installed inside `play` would arrive
 * after the read it was meant to answer.
 */
const meta: Meta<typeof TaskActivityLog> = {
  title: "Design System/Kanban/TaskActivityLog",
  component: TaskActivityLog,
  decorators: [themeDecorator],
  parameters: { layout: "padded" },
};

export default meta;
type Story = StoryObj<typeof meta>;

let restoreFetch: (() => void) | null = null;

/** Stub the board's feed until the originating story restores it. */
function stubFeed(body: unknown): void {
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

function stubFailedFeed(): void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("{}", { status: 500 })) as typeof fetch;
  restoreFetch = () => {
    globalThis.fetch = original;
    restoreFetch = null;
  };
}

interface FeedBody {
  notifications: Array<Record<string, unknown>>;
  nextTs: string;
  earliestTs: null;
  gap: boolean;
  truncated: boolean;
  count: number;
}

function feed(
  notifications: Array<{
    id: string;
    ts: string;
    type: string;
    actor: string;
    agent?: string;
    changed?: string[];
    to?: Record<string, unknown>;
  }>,
  gap = false,
): FeedBody {
  return {
    notifications: notifications.map((n) => ({ ...n, taskId: "task-a" })),
    nextTs: new Date().toISOString(),
    earliestTs: null,
    gap,
    truncated: false,
    count: notifications.length,
  };
}

const TASK_ID = "task-a";
const ENDPOINT = "/api/notifications";

export const Recent: Story = {
  args: { endpoint: ENDPOINT, taskId: TASK_ID },
  beforeEach: async () => {
    const now = Date.now();
    stubFeed(
      feed([
        {
          id: "evt_1",
          ts: new Date(now - 40 * 60_000).toISOString(),
          type: "task.claim",
          actor: "agent",
          agent: "pi-1187",
        },
        {
          id: "evt_2",
          ts: new Date(now - 12 * 60_000).toISOString(),
          type: "task.update",
          actor: "agent",
          agent: "pi-1187",
          changed: ["status"],
          to: { status: "in-progress" },
        },
        {
          id: "evt_3",
          ts: new Date(now - 90_000).toISOString(),
          type: "verify",
          actor: "agent",
        },
      ]),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("claimed");
    // The agent identity is the label; the verb names what happened.
    expect(canvas.getAllByText("pi-1187").length).toBeGreaterThan(0);
    expect(canvas.getByText("updated status · → in-progress")).toBeInTheDocument();
    expect(canvas.getByText(/^1 min ago$/)).toBeInTheDocument();
    // The read is stamped — the list can never look fresher than it is.
    expect(canvas.getByText(/^read \d+ s ago$/)).toBeInTheDocument();
    await expectNoA11yViolations(canvasElement);
    restoreFetch?.();
  },
};

export const Empty: Story = {
  args: { endpoint: ENDPOINT, taskId: TASK_ID },
  beforeEach: async () => {
    stubFeed(feed([]));
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("No activity for this task yet.");
    expect(canvas.queryByText("Reading activity…")).toBeNull();
    await expectNoA11yViolations(canvasElement);
    restoreFetch?.();
  },
};

export const Stale: Story = {
  args: { endpoint: ENDPOINT, taskId: TASK_ID, pollIntervalMs: 60_000 },
  beforeEach: async () => {
    stubFailedFeed();
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("Couldn’t read the activity log.");
    // A failed FIRST read is not "no activity" — never a false empty.
    expect(canvas.queryByText("No activity for this task yet.")).toBeNull();
    expect(canvas.getByText(/^couldn't refresh — read \d+ s ago$/)).toBeInTheDocument();
    await expectNoA11yViolations(canvasElement);
    restoreFetch?.();
  },
};

export const Evicted: Story = {
  args: { endpoint: ENDPOINT, taskId: TASK_ID },
  beforeEach: async () => {
    stubFeed(
      feed(
        [
          {
            id: "evt_9",
            ts: new Date(Date.now() - 5 * 60_000).toISOString(),
            type: "task.comment",
            actor: "zorcec",
          },
        ],
        true,
      ),
    );
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await canvas.findByText("commented");
    expect(
      canvas.getByText("Older activity may have been evicted from the feed."),
    ).toBeInTheDocument();
    await expectNoA11yViolations(canvasElement);
    restoreFetch?.();
  },
};
