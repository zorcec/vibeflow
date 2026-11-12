import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { DetailPanel } from "../../src";
import type { Task } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/**
 * Detail panel shell — the tab bar, the title field and the close control,
 * rebuilt on `Button`/`Input` (P14.3).
 *
 * The shell's contract is navigation: three tabs, each reachable by name, and
 * a title field that is a real labelled textbox.
 */
const meta: Meta<typeof DetailPanel> = {
  title: "Design System/Kanban/DetailPanel",
  component: DetailPanel,
  decorators: [themeDecorator],
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof meta>;

const TASK = {
  id: "detail-1",
  title: "Fix the attention bell",
  description: "Bell must open the activity tab.",
  status: "in-progress",
  type: "bug",
  priority: "high",
} as unknown as Task;

/** Minimal in-memory KanbanApi: the shell only reads the task it is given. */
const api = {
  getTasks: async () => ({ tasks: [TASK] }),
  createTask: async () => ({ success: true }),
  updateTask: async () => ({ success: true }),
  deleteTask: async () => {},
  detachTask: async () => {},
  getComments: async () => ({ comments: [] }),
  addComment: async () => {},
  updateComment: async () => {},
  deleteComment: async () => {},
  getFiles: async () => ({ files: [] }),
  uploadFile: async () => {},
  deleteFile: async () => {},
  getProject: async () => ({ name: "Vibeflow" }),
  getSettings: async () => ({}),
  saveSettings: async () => {},
} as never;

function Harness({ onClose }: { onClose?: () => void }) {
  return (
    <DetailPanel
      open
      task={TASK}
      allTasks={[TASK]}
      tab="details"
      baseUrl=""
      api={api}
      onClose={onClose ?? (() => {})}
      onCreate={async () => undefined}
      onDelete={() => {}}
      onPatch={() => {}}
      onOpenTask={() => {}}
    />
  );
}

export const Default: Story = {
  render: () => <Harness />,
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("button", { name: "Details" })).toBeVisible();
    await expect(canvas.getByRole("button", { name: /Activity/ })).toBeVisible();
    await expect(canvas.getByRole("button", { name: /Files/ })).toBeVisible();
  },
};

/** The tabs are navigation: switching reports a different visible pane. */
export const TabSwitching: Story = {
  render: () => <Harness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: /Activity/ }));
    const active = canvasElement.querySelector("#dp-tab-activity");
    await expect(active?.className?.split(/\s+/).includes("active")).toBe(true);
  },
};

/** The title field stays a labelled textbox the caller can focus. */
export const TitleField: Story = {
  render: () => <Harness />,
  play: async ({ canvasElement }) => {
    const title = canvasElement.querySelector<HTMLInputElement>("#dp-title");
    await expect(title).not.toBeNull();
    await expect(title).toHaveValue("Fix the attention bell");
  },
};
