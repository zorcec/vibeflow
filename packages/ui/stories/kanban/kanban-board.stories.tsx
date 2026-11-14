import React from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { KanbanBoard } from "../../src";
import { task, ALL_STATUSES } from "../fixtures";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/**
 * The whole board. This story was blocked for a while: `KanbanBoard` renders
 * `Tooltip`, which needs Base UI's `FloatingDelayGroup` provider. The story
 * supplies it rather than faking the tooltip — a board without its real
 * provider would be a story that cannot fail the way production does.
 */
import { Tooltip as BaseTooltip } from "@base-ui-components/react/tooltip";

const meta: Meta<typeof KanbanBoard> = {
  title: "Design System/Kanban/KanbanBoard",
  component: KanbanBoard,
  decorators: [
    (Story) => (
      <BaseTooltip.Provider delay={0}>
        <Story />
      </BaseTooltip.Provider>
    ),
    themeDecorator,
  ],
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof meta>;

const tasks = [
  task({ id: "t1", title: "Backlog item", status: "backlog", sortKey: "a" } as never),
  task({ id: "t2", title: "Todo item", status: "todo", sortKey: "b" } as never),
  task({ id: "t3", title: "Doing item", status: "in-progress", sortKey: "c" } as never),
  task({ id: "t4", title: "Review item", status: "review", sortKey: "d" } as never),
  task({ id: "t5", title: "Done item", status: "done", sortKey: "e" } as never),
];

/**
 * The board is ~1500px wide (five columns) and the visual harness captures a
 * fixed 900x700 viewport, so an unscaled render is clipped mid-column and half
 * the baseline is empty — reviewable in neither case. Scaling the wrapper fits
 * all five columns in the frame; it changes the presentation, not the
 * component.
 */
const fitBoard = (Story: React.ComponentType) => (
  <div style={{ width: 880, height: 660 }}>
    <div
      style={{
        width: 1500,
        height: 1125,
        transform: "scale(0.5867)",
        transformOrigin: "top left",
      }}
    >
      <Story />
    </div>
  </div>
);

export const Default: Story = {
  render: (args) => fitBoard(() => <KanbanBoard {...(args as never)} />),
  args: {
    tasks,
    // The board takes `visibleCols` (which columns to show), not a list of
    // status configs, and it crashed on the omission.
    visibleCols: ALL_STATUSES,
    onOpenPanel: () => {},
    onDrop: () => {},
    onReorder: () => {},
  } as never,
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    expect(canvasElement).toHaveTextContent("Todo item");
    expect(canvasElement).toHaveTextContent("Done item");
  },
};

export const Empty: Story = {
  render: (args) => fitBoard(() => <KanbanBoard {...(args as never)} />),
  args: {
    tasks: [],
    visibleCols: ALL_STATUSES,
    onOpenPanel: () => {},
    onDrop: () => {},
    onReorder: () => {},
  } as never,
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    // Every column still renders with its heading.
    expect(canvasElement.textContent?.length).toBeGreaterThan(0);
  },
};
