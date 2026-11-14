import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within, userEvent } from "storybook/test";
import { FilePreviewModal } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/** Attachment preview. The image is a data URI so the story needs no network. */
const meta: Meta<typeof FilePreviewModal> = {
  title: "Design System/Kanban/FilePreviewModal",
  component: FilePreviewModal,
  decorators: [themeDecorator],
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof meta>;

// A 1x1 transparent PNG: real bytes, no network, no fixture server.
const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export const Image: Story = {
  args: { open: true, name: "screenshot.png", url: PIXEL, onClose: () => {} },
  play: async ({ canvasElement }) => {
        // The modal portals to document.body, so the story canvas is EMPTY —
    // scoping here (not to canvasElement) is what makes the axe check see the
    // thing under review. Measured: asserting on the canvas passed while the
    // dialog was unrendered.
    await expectNoA11yViolations(document.body);
    expect(document.body).toHaveTextContent("screenshot.png");
    const img = document.body.querySelector("img") as HTMLImageElement | null;
    expect(img).not.toBeNull();
    // Decode before the shot: a data-URI image is in the DOM the instant it
    // mounts, so a capture can catch it unpainted and the baseline then
    // contradicts the next run (measured: 26-51% of pixels differing between
    // two runs of identical code).
    await img!.decode();
  },
};

export const Unsupported: Story = {
  args: { open: true, name: "notes.txt", url: "data:text/plain,hello", onClose: () => {} },
  play: async ({ canvasElement }) => {
        // The modal portals to document.body, so the story canvas is EMPTY —
    // scoping here (not to canvasElement) is what makes the axe check see the
    // thing under review. Measured: asserting on the canvas passed while the
    // dialog was unrendered.
    await expectNoA11yViolations(document.body);
    // Never a broken <img>: unsupported types offer the download instead.
    expect(document.body.textContent).toContain("notes.txt");
  },
};
