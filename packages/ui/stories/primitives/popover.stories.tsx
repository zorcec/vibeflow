import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { useState } from "react";
import { Popover, Button } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/**
 * Popover matrix — every side, long content, the container contract, and the
 * dismissal paths. The viewport-edge story proves Base UI flips instead of
 * spilling outside the viewport.
 */
const meta: Meta<typeof Popover> = {
  title: "Design System/Popover",
  component: Popover,
  decorators: [themeDecorator],
};

export default meta;
type Story = StoryObj<typeof meta>;

function Harness({
  side = "bottom",
  align = "center",
  long = false,
  corner = false,
}: {
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  long?: boolean;
  corner?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div style={corner ? { position: "fixed", right: 8, bottom: 8 } : undefined}>
      <Popover
        open={open}
        onOpenChange={setOpen}
        side={side}
        align={align}
        trigger={
          <button type="button" className="rounded border border-border px-3 py-1">
            Open popover
          </button>
        }
      >
        {long ? (
          <div>
            {Array.from({ length: 30 }, (_, i) => (
              <p key={i}>Line {i + 1} of popover content</p>
            ))}
          </div>
        ) : (
          <p>Popover content</p>
        )}
      </Popover>
    </div>
  );
}

async function openPopover(canvasElement: HTMLElement) {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByRole("button", { name: "Open popover" }));
  // The popup is portalled to document.body, so it is not inside the canvas.
  return within(document.body).findByText(/Popover content|Line 1 of popover content/);
}

export const Bottom: Story = {
  render: () => <Harness side="bottom" />,
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    await expect(await openPopover(canvasElement)).toBeVisible();
    // Scope axe to the floating content: the popup is portalled to body, and
    // auditing body would flag Storybook's own chrome (`region`).
    await expectNoA11yViolations(
      (document.querySelector('[data-role="popover-popup"], [data-role="tooltip-popup"]') as HTMLElement) ?? canvasElement,
    );
  },
};

export const Top: Story = {
  render: () => <Harness side="top" />,
  play: async ({ canvasElement }) => {
    await expect(await openPopover(canvasElement)).toBeVisible();
    const side = document
      .querySelector('[data-role="popover-popup"]')
      ?.parentElement?.getAttribute("data-side");
    // Base UI may flip; assert only that a resolved side is reported.
    await expect(side === "top" || side === "bottom").toBe(true);
  },
};

export const RightAlignedEnd: Story = {
  render: () => <Harness side="right" align="end" />,
  play: async ({ canvasElement }) => {
    await expect(await openPopover(canvasElement)).toBeVisible();
  },
};

export const Left: Story = {
  render: () => <Harness side="left" />,
  play: async ({ canvasElement }) => {
    await expect(await openPopover(canvasElement)).toBeVisible();
  },
};

export const LongContent: Story = {
  render: () => <Harness long />,
  play: async ({ canvasElement }) => {
    await expect(await openPopover(canvasElement)).toBeVisible();
    // Scope axe to the floating content: the popup is portalled to body, and
    // auditing body would flag Storybook's own chrome (`region`).
    await expectNoA11yViolations(
      (document.querySelector('[data-role="popover-popup"], [data-role="tooltip-popup"]') as HTMLElement) ?? canvasElement,
    );
  },
};

/** A trigger pinned to the corner: the popup must stay inside the viewport. */
export const ViewportEdge: Story = {
  render: () => <Harness side="bottom" align="end" corner />,
  play: async ({ canvasElement }) => {
    await expect(await openPopover(canvasElement)).toBeVisible();
    const popup = document.querySelector('[data-role="popover-popup"]') as HTMLElement;
    const rect = popup.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    // Collision handling is the point: no spill outside the viewport.
    await expect(rect.left).toBeGreaterThanOrEqual(-1);
    await expect(rect.top).toBeGreaterThanOrEqual(-1);
    await expect(rect.right).toBeLessThanOrEqual(vw + 1);
    await expect(rect.bottom).toBeLessThanOrEqual(vh + 1);
  },
};

export const ClosesOnEscape: Story = {
  render: () => <Harness />,
  play: async ({ canvasElement }) => {
    await expect(await openPopover(canvasElement)).toBeVisible();
    const { fireEvent } = await import("storybook/test");
    fireEvent.keyDown(document, { key: "Escape" });
    // Closing is not instantaneous (exit animation + unmount); wait for the
    // node to leave instead of racing it.
    await waitFor(() =>
      expect(within(document.body).queryByText("Popover content")).toBeNull(),
    );
  },
};
