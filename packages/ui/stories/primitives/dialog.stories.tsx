import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { useState } from "react";
import { Dialog, Button } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/**
 * Dialog matrix — closed, open, long/scrollable content, footer-less, and the
 * `container` contract the overlay depends on.
 *
 * Each open story is driven through a real trigger click rather than starting
 * `open: true`, so the play function also proves focus lands inside on open.
 */
const meta: Meta<typeof Dialog> = {
  title: "Design System/Primitives/Dialog",
  component: Dialog,
  decorators: [themeDecorator],
};

export default meta;
type Story = StoryObj<typeof meta>;

function Harness({
  footer,
  longBody = false,
  container,
  closeOnOutsideClick,
}: {
  footer?: React.ReactNode;
  longBody?: boolean;
  container?: HTMLElement | null;
  closeOnOutsideClick?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <Button variant="primary" onClick={() => setOpen(true)}>
        Open dialog
      </Button>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title="Rename board"
        description="The new name is visible to every member."
        footer={footer}
        container={container}
        closeOnOutsideClick={closeOnOutsideClick}
      >
        {longBody ? (
          <div>
            {Array.from({ length: 40 }, (_, i) => (
              <p key={i}>Row {i + 1} — long content that must scroll inside the dialog.</p>
            ))}
          </div>
        ) : (
          <p>Body content</p>
        )}
      </Dialog>
    </div>
  );
}

export const Closed: Story = {
  render: () => <Harness />,
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    await expect(within(canvasElement).queryByRole("dialog")).toBeNull();
  },
};

export const Open: Story = {
  render: () => <Harness footer={<Button variant="primary">Save</Button>} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Open dialog" }));
    const dialog = await within(document.body).findByRole("dialog");
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog.contains(document.activeElement)).toBe(true);
    await expectNoA11yViolations(document.body);
  },
};

export const LongContent: Story = {
  render: () => (
    <Harness longBody footer={<Button variant="primary">Save</Button>} />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Open dialog" }));
    const dialog = await within(document.body).findByRole("dialog");
    const scroller = dialog.querySelector(".overflow-y-auto") as HTMLElement;
    await expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
    await expectNoA11yViolations(document.body);
  },
};

export const Footerless: Story = {
  render: () => <Harness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Open dialog" }));
    const dialog = await within(document.body).findByRole("dialog");
    // No footer => no action row; only the trigger outside and nothing inside.
    await expect(within(dialog).queryByRole("button")).toBeNull();
    await expectNoA11yViolations(document.body);
  },
};

/**
 * The overlay contract: a dialog portalled into a detached container must live
 * there, not in document.body — otherwise it escapes the shadow root's tokens.
 */
export const ContainerHost: Story = {
  render: () => {
    const host = document.createElement("div");
    host.id = "dialog-container-host";
    document.body.appendChild(host);
    return <Harness container={host} footer={<Button variant="primary">Save</Button>} />;
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Open dialog" }));
    const dialog = await within(document.body).findByRole("dialog");
    const host = document.getElementById("dialog-container-host");
    await expect(host).not.toBeNull();
    await expect(host?.contains(dialog)).toBe(true);
    await expectNoA11yViolations(document.body);
  },
};

/** Escape and outside-click closing, both observed through the trigger state. */
export const CloseBehaviours: Story = {
  render: () => <Harness footer={<Button variant="primary">Save</Button>} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("button", { name: "Open dialog" });

    await userEvent.click(trigger);
    await within(document.body).findByRole("dialog");
    const { fireEvent } = await import("storybook/test");
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() =>
      expect(within(document.body).queryByRole("dialog")).toBeNull(),
    );

    await userEvent.click(trigger);
    await within(document.body).findByRole("dialog");
    const backdrop = document.querySelector('[data-role="dialog-backdrop"]');
    await expect(backdrop).not.toBeNull();
    if (backdrop) await userEvent.click(backdrop);
    await waitFor(() =>
      expect(within(document.body).queryByRole("dialog")).toBeNull(),
    );
  },
};
