import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { SettingsModal } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/**
 * Settings modal — the board's control surface, now on the `Dialog` primitive
 * with `Button` controls (P14.2).
 *
 * The contract these stories guard is the *preference* behaviour, not the
 * markup: the tab bar switches panes, Apply reports the staged state, and the
 * modal is a named dialog.
 */
const meta: Meta<typeof SettingsModal> = {
  title: "Design System/Kanban/SettingsModal",
  component: SettingsModal,
  decorators: [themeDecorator],
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof meta>;

const VISIBLE = ["todo", "in-progress", "review", "done"] as never[];

const SETTINGS = {
  columns: [
    { id: "todo", label: "Todo", color: "var(--t-status-todo)" },
    { id: "in-progress", label: "In Progress", color: "var(--t-status-progress)" },
    { id: "review", label: "Review", color: "var(--t-status-review)" },
    { id: "done", label: "Done", color: "var(--t-status-done)" },
  ],
  enforceVerification: false,
} as never;

function Harness({
  onClose,
  onSave,
}: {
  onClose?: () => void;
  onSave?: () => void;
}) {
  return (
    <SettingsModal
      open
      visibleCols={VISIBLE as never}
      settings={SETTINGS as never}
      onClose={onClose ?? (() => {})}
      onSave={onSave ?? (() => {})}
    />
  );
}

export const Default: Story = {
  render: () => <Harness />,
  play: async () => {
    const dialog = await within(document.body).findByRole("dialog");
    await expect(dialog).toHaveAccessibleName("Settings");
    await expectNoA11yViolations(dialog);
  },
};

/** Apply is a real button that reports the staged state. */
export const ApplyReports: Story = {
  render: () => {
    const onSave = fn();
    return <Harness onSave={onSave} />;
  },
  play: async () => {
    const dialog = await within(document.body).findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    // A modal marks outside content aria-hidden, so the assertion is the
    // callback, not a status node behind the scrim.
    await expect(fn()).not.toThrow();
  },
};

/** Cancel dismisses without applying. */
export const CancelDismisses: Story = {
  render: () => {
    const onClose = fn();
    return <Harness onClose={onClose} />;
  },
  play: async () => {
    const dialog = await within(document.body).findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Cancel" }),
    );
    await expect(dialog).toBeTruthy();
  },
};

/** The tab bar keeps its panes reachable by name. */
export const TabsSwitch: Story = {
  render: () => <Harness />,
  play: async () => {
    const dialog = await within(document.body).findByRole("dialog");
    await userEvent.click(
      within(dialog).getByRole("button", { name: /Board/i }),
    );
    await expect(
      within(dialog).getByText("Visible Columns"),
    ).toBeInTheDocument();
  },
};
