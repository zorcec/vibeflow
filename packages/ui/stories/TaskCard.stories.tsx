import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { KanbanCard } from "../src/KanbanCard";
import type { KanbanColumn, KanbanHandlers, KanbanTask } from "../src/types";
import { expectNoA11yViolations } from "./a11y";
import { themeDecorator } from "../.storybook/ThemeDecorator";

const task: KanbanTask = {
    id: "task-1",
    title: "Wire the six-theme decorator",
    description: "Proof story for the KanbanCard skeleton.",
    status: "in_progress",
    type: "feature",
    priority: "High",
    commentCount: 3,
    fileCount: 1,
};

const col: KanbanColumn = {
    id: "doing",
    label: "In Progress",
    color: "#2563eb",
};

const meta: Meta<typeof KanbanCard> = {
    title: "Design System/TaskCard",
    component: KanbanCard,
    decorators: [themeDecorator],
    args: {
        task,
        col,
        handlers: {
            onCreate: fn(),
            onUpdate: fn(),
            onDelete: fn(),
            onCardClick: fn(),
        } satisfies KanbanHandlers,
    },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Skeleton: Story = {
    play: async ({ canvasElement, args }) => {
        const canvas = within(canvasElement);
        await expect(canvas.getByText(task.title)).toBeVisible();
        await userEvent.click(canvas.getByText(task.title));
        await expect(args.handlers.onCardClick).toHaveBeenCalledWith(task);
    },
};
