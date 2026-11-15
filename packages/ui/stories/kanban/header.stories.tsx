import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { useState } from "react";
import { KanbanHeader } from "../../src";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/**
 * Kanban header — the board's identity, search field and action cluster.
 *
 * P13.2 moved the search field and the action buttons onto the primitives.
 * These stories pin the contract the mobile test can only assert as CSS: that
 * the search box is a real labelled textbox, and that the hidden-until-narrow
 * menu trigger still exposes its aria hooks and opens a menu.
 */
const meta: Meta<typeof KanbanHeader> = {
  title: "Design System/Kanban/Header",
  component: KanbanHeader,
  decorators: [themeDecorator],
  parameters: { layout: "fullscreen" },
};

export default meta;
type Story = StoryObj<typeof meta>;

const base = {
  projectName: "Vibeflow",
  searchQuery: "",
  taskSummary: "12 open · 3 review",
  onSearchChange: () => {},
  onSettings: () => {},
};

export const Default: Story = {
  args: base,
  // The search field is controlled by the host — the story owns the state so
  // typing is observable (a no-op onChange would silently accept keystrokes).
  render: (args) => {
    function Harness() {
      const [q, setQ] = useState("");
      return (
        <KanbanHeader {...args} searchQuery={q} onSearchChange={setQ} />
      );
    }
    return <Harness />;
  },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const canvas = within(canvasElement);
    const search = canvas.getByRole("textbox", { name: "Search tasks" });
    await expect(search).toBeVisible();
    await userEvent.type(search, "attention");
    await expect(search).toHaveValue("attention");
  },
};

/** The menu trigger exists at every width but is only revealed when narrow. */
export const MobileMenuTrigger: Story = {
  args: base,
  play: async ({ canvasElement }) => {
    const trigger = canvasElement.querySelector<HTMLButtonElement>(
      ".kb-mobile-menu-trigger",
    );
    expect(trigger).not.toBeNull();
    await expect(trigger).toHaveAttribute("aria-label", "Open board menu");
    await expect(trigger).toHaveAttribute(
      "aria-controls",
      "kb-header-actions-menu",
    );
    // Hidden on the desktop viewport the story runs at — the narrow block
    // reveals it, which `Header.mobile.test.tsx` asserts from the CSSOM.
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
  },
};

/** A back link plus an extra action: the layout the web app uses. */
export const WithBackLinkAndActions: Story = {
  args: {
    ...base,
    backHref: "/boards",
    backLabel: "All boards",
    extraActions: <button type="button">Overview</button>,
  },
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("link", { name: "All boards" })).toBeVisible();
  },
};
