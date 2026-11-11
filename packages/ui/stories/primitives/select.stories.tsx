import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, waitFor, within } from "storybook/test";
import { useState } from "react";
import { Select } from "../../src";
import type { SelectOption } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/**
 * Select matrix — empty, seeded, disabled, long list, and the KEYBOARD model.
 *
 * The keyboard assertions live here rather than in the unit suite because they
 * need a real input pipeline: jsdom does not implement the arrow-key/focus
 * mechanics Base UI's listbox relies on (measured).
 */
const meta: Meta<typeof Select> = {
  title: "Design System/Select",
  component: Select,
  decorators: [themeDecorator],
};

export default meta;
type Story = StoryObj<typeof meta>;

const OPTIONS: SelectOption[] = [
  { value: "todo", label: "Todo" },
  { value: "in-progress", label: "In progress" },
  { value: "review", label: "Review" },
  { value: "done", label: "Done" },
];

const LONG: SelectOption[] = Array.from({ length: 40 }, (_, i) => ({
  value: `opt-${i}`,
  label: `Option ${i + 1}`,
}));

function Harness({
  options = OPTIONS,
  disabled = false,
  initial = null,
}: {
  options?: SelectOption[];
  disabled?: boolean;
  initial?: string | null;
}) {
  const [value, setValue] = useState<string | null>(initial);
  return (
    <div className="flex w-64 flex-col gap-1">
      <label htmlFor="status-select" className="text-xs text-text-muted">
        Status
      </label>
      <Select
        id="status-select"
        value={value}
        onValueChange={setValue}
        options={options}
        disabled={disabled}
      />
      <span data-role="current">{value ?? "none"}</span>
    </div>
  );
}

export const Default: Story = {
  render: () => <Harness />,
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("combobox");
    await expect(trigger).toHaveAccessibleName("Status");
    await userEvent.click(trigger);
    const listbox = await within(document.body).findByRole("listbox");
    await expect(listbox).toBeVisible();
    await expect(within(document.body).getAllByRole("option")).toHaveLength(4);
  },
};

export const Seeded: Story = {
  render: () => <Harness initial="review" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("combobox")).toHaveTextContent("Review");
    await expect(canvas.getByText("review")).toBeInTheDocument();
  },
};

/** The keyboard model, asserted in a real browser. */
export const Keyboard: Story = {
  render: () => <Harness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("combobox");
    trigger.focus();

    // ArrowDown opens the listbox.
    await userEvent.keyboard("{ArrowDown}");
    await within(document.body).findByRole("listbox");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");

    // Opening reset the highlight to the selected option (none → first), so
    // Enter now commits "todo" — the same order the unit test pins.
    await userEvent.keyboard("{Enter}");
    await waitFor(() =>
      expect(canvas.getByText("todo")).toBeInTheDocument(),
    );
  },
};

/** Escape closes without selecting — the value must not move. */
export const EscapeKeepsValue: Story = {
  render: () => <Harness initial="review" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const trigger = canvas.getByRole("combobox");
    await userEvent.click(trigger);
    await within(document.body).findByRole("listbox");
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(within(document.body).queryByRole("listbox")).toBeNull(),
    );
    await expect(canvas.getByText("review")).toBeInTheDocument();
  },
};

export const Disabled: Story = {
  render: () => <Harness disabled />,
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const trigger = within(canvasElement).getByRole("combobox");
    await expect(trigger).toHaveAttribute("data-disabled");
    await userEvent.click(trigger);
    await expect(within(document.body).queryByRole("listbox")).toBeNull();
  },
};

export const EmptyOptions: Story = {
  render: () => <Harness options={[]} />,
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole("combobox");
    await userEvent.click(trigger);
    await within(document.body).findByRole("listbox");
    await expect(within(document.body).queryAllByRole("option")).toHaveLength(0);
  },
};

export const LongList: Story = {
  render: () => <Harness options={LONG} />,
  play: async ({ canvasElement }) => {
    const trigger = within(canvasElement).getByRole("combobox");
    await userEvent.click(trigger);
    const listbox = await within(document.body).findByRole("listbox");
    await expect(within(document.body).getAllByRole("option")).toHaveLength(40);
    await expectNoA11yViolations(listbox as HTMLElement);
  },
};
