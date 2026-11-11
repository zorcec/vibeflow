import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { ChatPanel } from "../src/ChatPanel";
import { expectNoA11yViolations } from "./a11y";
import { themeDecorator } from "../.storybook/ThemeDecorator";

const meta: Meta<typeof ChatPanel> = {
    title: "Design System/ChatPanel",
    component: ChatPanel,
    decorators: [themeDecorator],
    args: {
        messages: [
            { id: "m1", role: "user", text: "What themes exist?" },
            {
                id: "m2",
                role: "assistant",
                text: "Six: dark, light, high contrast, rose pine dawn, dracula, gruvbox.",
            },
        ],
        streamingText: "",
        approvals: [],
        status: "ready",
        onSend: fn(),
        onApprove: fn(),
        onDeny: fn(),
        onAbort: fn(),
        onClose: fn(),
    },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Ready: Story = {
    play: async ({ canvasElement, args }) => {
        const canvas = within(canvasElement);
        await expect(
            canvas.getByTestId("chat-panel"),
        ).toBeVisible();
        await expect(
            canvas.getByText("Six: dark, light, high contrast, rose pine dawn, dracula, gruvbox."),
        ).toBeVisible();
        await userEvent.type(
            canvas.getByTestId("chat-input"),
            "try dracula",
        );
        await userEvent.click(canvas.getByTestId("chat-send"));
        await expect(args.onSend).toHaveBeenCalledWith("try dracula", []);
    },
};

export const Streaming: Story = {
    args: {
        streamingText: "Switching to dracula…",
    },
    play: async ({ canvasElement }) => {
        await expectNoA11yViolations(canvasElement);
        const canvas = within(canvasElement);
        await expect(
            canvas.getByTestId("chat-streaming"),
        ).toHaveTextContent("Switching to dracula…");
    },
};
