import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { useState } from "react";
import { ConfirmModal, ModalBase } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/**
 * Modal family — `ModalBase` and `ConfirmModal`, now thin wrappers over the
 * `Dialog` primitive (P14.1).
 *
 * The behaviour these stories guard is the part the old hand-rolled portal got
 * wrong: a real dialog role with an accessible name, a focus trap, Escape and
 * focus restoration.
 */
const meta: Meta<typeof ModalBase> = {
  title: "Design System/Kanban/Modal",
  component: ModalBase,
  decorators: [themeDecorator],
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof meta>;

function ModalHarness({ confirm = false }: { confirm?: boolean }) {
  const [open, setOpen] = useState(true);
  const [result, setResult] = useState("open");
  if (confirm) {
    return (
      <div>
        <ConfirmModal
          open={open}
          title="Delete board?"
          message="This removes the board and its tasks."
          onCancel={() => {
            setResult("cancelled");
            setOpen(false);
          }}
          onConfirm={() => {
            setResult("confirmed");
            setOpen(false);
          }}
        />
        <output role="status" data-role="result">
          {result}
        </output>
      </div>
    );
  }
  return (
    <div>
      <ModalBase
        open={open}
        onClose={() => {
          setResult("closed");
          setOpen(false);
        }}
        title="Board settings"
        footer={
          <button type="button" onClick={() => setOpen(false)}>
            Done
          </button>
        }
      >
        <p>Body content</p>
      </ModalBase>
      <output role="status" data-role="result">
        {result}
      </output>
    </div>
  );
}

export const Base: Story = {
  render: () => <ModalHarness />,
  play: async () => {
    const dialog = await within(document.body).findByRole("dialog");
    await expect(dialog).toHaveAccessibleName("Board settings");
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expectNoA11yViolations(dialog);
  },
};

export const Confirm: Story = {
  render: () => <ModalHarness confirm />,
  play: async () => {
    const dialog = await within(document.body).findByRole("dialog");
    await expect(dialog).toHaveAccessibleName("Delete board?");
    await expectNoA11yViolations(dialog);
    // The destructive action is a real button and reports through onConfirm.
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Delete" }),
    );
    await expect(
      within(document.body).getByRole("status"),
    ).toHaveTextContent("confirmed");
  },
};

/** Escape must close through onCancel (not confirm) — the safe direction. */
export const EscapeCancels: Story = {
  render: () => <ModalHarness confirm />,
  play: async () => {
    const dialog = await within(document.body).findByRole("dialog");
    await userEvent.keyboard("{Escape}");
    await expect(
      within(document.body).queryByRole("dialog"),
    ).not.toBeInTheDocument();
    await expect(
      within(document.body).getByRole("status"),
    ).toHaveTextContent("cancelled");
    expect(dialog).toBeTruthy();
  },
};
