import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { FilesList } from "../../src";
import { task, comment, fileEntry, ALL_STATUSES } from "../fixtures";
import { expectNoA11yViolations } from "../a11y";
import { themeDecorator } from "../../.storybook/ThemeDecorator";

/** Attachments: loaded, loading, empty, and failed. */
const meta: Meta<typeof FilesList> = {
  title: "Design System/Shared/FilesList",
  component: FilesList,
  decorators: [themeDecorator],
  parameters: { layout: "centered" },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { files: [fileEntry(), fileEntry({ id: "f2", name: "notes.txt" })], baseUrl: "/api/files" } as never,
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    expect(canvasElement).toHaveTextContent("screenshot.png");
    expect(canvasElement).toHaveTextContent("notes.txt");
  },
};

export const Loading: Story = {
  args: { files: [], loading: true, baseUrl: "/api/files" } as never,
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    expect(canvasElement.textContent?.trim().length).toBeGreaterThan(0);
  },
};

export const Failed: Story = {
  args: { files: [], error: "Could not load attachments", baseUrl: "/api/files" } as never,
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    expect(canvasElement).toHaveTextContent("Failed to load.");
  },
};

export const Empty: Story = {
  args: { files: [], baseUrl: "/api/files" } as never,
  play: async ({ canvasElement }) => {
    await expectNoA11yViolations(canvasElement);
    expect(canvasElement.textContent?.trim().length).toBeGreaterThan(0);
  },
};
