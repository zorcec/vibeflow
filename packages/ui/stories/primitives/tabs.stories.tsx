import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { useState } from "react";
import { Tabs } from "../../src";
import type { TabDefinition } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/**
 * Tabs matrix — horizontal, vertical, both activation modes, disabled tab.
 *
 * The arrow-key model runs here: jsdom cannot drive Base UI's focus movement
 * (documented in `tabs.test.tsx`), so the browser is the honest place to assert
 * it, including the automatic-vs-manual distinction this component adds.
 */
const meta: Meta<typeof Tabs> = {
  title: "Design System/Primitives/Tabs",
  component: Tabs,
  decorators: [themeDecorator],
};

export default meta;
type Story = StoryObj<typeof meta>;

const TABS: TabDefinition[] = [
  { id: "details", label: "Details", panel: <p>Details panel</p> },
  { id: "activity", label: "Activity", panel: <p>Activity panel</p> },
  { id: "files", label: "Files", panel: <p>Files panel</p> },
];

function Harness({
  tabs = TABS,
  orientation = "horizontal",
  activationMode = "automatic",
  initial = "details",
}: {
  tabs?: TabDefinition[];
  orientation?: "horizontal" | "vertical";
  activationMode?: "automatic" | "manual";
  initial?: string;
}) {
  const [value, setValue] = useState(initial);
  return (
    <div className="w-96">
      <Tabs
        value={value}
        onValueChange={setValue}
        tabs={tabs}
        orientation={orientation}
        activationMode={activationMode}
        aria-label="Sections"
      />
      <span data-role="current">{value}</span>
    </div>
  );
}

export const Automatic: Story = {
  render: () => <Harness />,
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("tablist")).toHaveAccessibleName("Sections");
    await expect(canvas.getAllByRole("tab")).toHaveLength(3);
    // Automatic: arrowing right activates the next tab immediately.
    canvas.getByRole("tab", { name: "Details" }).focus();
    await userEvent.keyboard("{ArrowRight}");
    await expect(canvas.getByText("activity")).toBeInTheDocument();
    await expect(canvas.getByText("Activity panel")).toBeInTheDocument();
  },
};

/** Manual: arrows move focus only; Enter commits. */
export const Manual: Story = {
  render: () => <Harness activationMode="manual" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const details = canvas.getByRole("tab", { name: "Details" });
    details.focus();
    await userEvent.keyboard("{ArrowRight}");
    // Focus moved but the panel did NOT change.
    await expect(canvas.getByText("details")).toBeInTheDocument();
    await expect(canvas.queryByText("Activity panel")).toBeNull();
    await userEvent.keyboard("{Enter}");
    await expect(canvas.getByText("activity")).toBeInTheDocument();
  },
};

export const Vertical: Story = {
  render: () => <Harness orientation="vertical" />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("tablist")).toHaveAttribute(
      "aria-orientation",
      "vertical",
    );
    canvas.getByRole("tab", { name: "Details" }).focus();
    await userEvent.keyboard("{ArrowDown}");
    await expect(canvas.getByText("activity")).toBeInTheDocument();
  },
};

export const ClickSwitching: Story = {
  render: () => <Harness />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("tab", { name: "Files" }));
    await expect(canvas.getByText("files")).toBeInTheDocument();
    await expect(canvas.getByText("Files panel")).toBeInTheDocument();
    await expectNoA11yViolations(canvasElement);
  },
};

export const DisabledTab: Story = {
  render: () => (
    <Harness
      tabs={[
        ...TABS,
        { id: "locked", label: "Locked", panel: <p>Locked</p>, disabled: true },
      ]}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const locked = canvas.getByRole("tab", { name: "Locked" });
    await expect(locked).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(locked);
    await expect(canvas.getByText("details")).toBeInTheDocument();
  },
};
