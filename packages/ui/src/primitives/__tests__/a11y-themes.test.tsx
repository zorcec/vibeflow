// @vitest-environment jsdom
/**
 * Six-theme axe sweep over the COMPONENTS the stories use (design-system P5.2)
 * — zero axe violations in ALL themes.
 *
 * Scope correction (2026-11-11): this file imports components directly and
 * mirrors their args, so it proves the components are accessible per theme; it
 * does NOT render the stories, and therefore cannot catch a story that adds
 * broken markup (measured: an `<img>` without alt injected into a story left
 * this sweep green). Story-level accessibility is guarded by
 * `expectNoA11yViolations` inside each story's `play` (see `stories/a11y.ts`).
 *
 * Honest original claim, for the record:
 * zero axe violations for every story, in ALL themes. The theme list is driven by THEMES from the theme
 * registry (never hardcoded here), so adding a theme automatically extends
 * the sweep. Each entry mirrors its story's args; the manifest test beside
 * this file guarantees the story list stays in sync.
 */
import React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render as rtlRender, cleanup } from "@testing-library/react";
import "@testing-library/jest-dom";
import axe from "axe-core";
import { THEMES } from "../../kanban/theme-registry";
import { ChatPanel } from "../../ChatPanel";
import { KanbanCard } from "../../KanbanCard";
import type { KanbanColumn, KanbanHandlers, KanbanTask } from "../../types";
import { VibeflowIcon } from "../../VibeflowIcon";
import { Button, Badge, Input, Textarea } from "../../index";

afterEach(cleanup);

const noop = vi.fn();

function chatReady(): React.ReactElement {
  return (
    <ChatPanel
      messages={[
        { id: "m1", role: "user", text: "What themes exist?" },
        {
          id: "m2",
          role: "assistant",
          text: "Six: dark, light, high contrast, rose pine dawn, dracula, gruvbox.",
        },
      ]}
      streamingText=""
      approvals={[]}
      status="ready"
      onSend={noop}
      onApprove={noop}
      onDeny={noop}
      onAbort={noop}
      onClose={noop}
    />
  );
}

function chatStreaming(): React.ReactElement {
  return (
    <ChatPanel
      messages={[{ id: "m1", role: "user", text: "What themes exist?" }]}
      streamingText="Switching to dracula…"
      approvals={[]}
      status="ready"
      onSend={noop}
      onApprove={noop}
      onDeny={noop}
      onAbort={noop}
      onClose={noop}
    />
  );
}

const task: KanbanTask = {
  id: "task-1",
  title: "Wire the six-theme decorator",
  description: "Proof story for the KanbanCard skeleton.",
  status: "in_progress",
  type: "feature",
  priority: "High",
  commentCount: 3,
  fileCount: 1,
};

const col: KanbanColumn = {
  id: "doing",
  label: "In Progress",
  color: "#2563eb",
};

const handlers: KanbanHandlers = {
  onCreate: noop,
  onUpdate: noop,
  onDelete: noop,
  onCardClick: noop,
};

function taskCard(): React.ReactElement {
  return <KanbanCard task={task} col={col} handlers={handlers} />;
}

function tokenSwatch(): React.ReactElement {
  return (
    <div data-testid="token-swatch" className="bg-bg text-text">
      Token swatch
    </div>
  );
}

/** Every story in the matrix, rendered with the same args as its story. */
const SWEEP: readonly { story: string; renderStory: () => React.ReactElement }[] = [
  { story: "ChatPanel/Ready", renderStory: chatReady },
  { story: "ChatPanel/Streaming", renderStory: chatStreaming },
  { story: "TaskCard/Skeleton", renderStory: taskCard },
  { story: "TokenUtilities/TokenColours", renderStory: tokenSwatch },
  { story: "VibeflowIcon/Default", renderStory: () => <VibeflowIcon size={32} /> },
  { story: "VibeflowIcon/Large", renderStory: () => <VibeflowIcon size={64} /> },
  { story: "Button/PrimaryMd", renderStory: () => <Button variant="primary" size="md" onClick={noop}>Save</Button> },
  { story: "Button/SecondaryMd", renderStory: () => <Button variant="secondary" size="md" onClick={noop}>Save</Button> },
  { story: "Button/GhostMd", renderStory: () => <Button variant="ghost" size="md" onClick={noop}>Save</Button> },
  { story: "Button/DangerMd", renderStory: () => <Button variant="danger" size="md" onClick={noop}>Save</Button> },
  { story: "Button/Loading", renderStory: () => <Button variant="primary" size="md" loading onClick={noop}>Save</Button> },
  { story: "Badge/DefaultMd", renderStory: () => <Badge variant="default" size="md">Todo</Badge> },
  { story: "Badge/DangerMd", renderStory: () => <Badge variant="danger" size="md">Blocked</Badge> },
  { story: "Badge/StatusTones", renderStory: () => <Badge tone="status-todo">todo</Badge> },
  { story: "Badge/WithDot", renderStory: () => <Badge variant="secondary" dot>Live</Badge> },
  { story: "Input/Default", renderStory: () => <Input aria-label="Field" /> },
  { story: "Input/Error", renderStory: () => <Input aria-label="Field" error="Required" /> },
  { story: "Input/Disabled", renderStory: () => <Input aria-label="Field" disabled /> },
  { story: "Textarea/Default", renderStory: () => <Textarea aria-label="Notes" /> },
  { story: "Textarea/Error", renderStory: () => <Textarea aria-label="Notes" error="Required" /> },
];

describe("a11y six-theme sweep", () => {
  it("covers every registered theme — the sweep grows with the registry", () => {
    expect(THEMES.length).toBe(6);
  });

  for (const { story, renderStory } of SWEEP) {
    describe(story, () => {
      for (const theme of THEMES) {
        it(`has zero axe violations in theme "${theme}"`, async () => {
          document.documentElement.setAttribute("data-theme", theme);
          const { container } = rtlRender(renderStory());
          // Page-level rules are owned by Storybook's host page (<html lang>,
          // <title>), not by the component under sweep — the matrix's
          // themeDecorator stories render into that page. Scoping them out
          // here keeps component violations (roles, names, contrast where
          // computable) at zero without letting components excuse page setup.
          const results = await axe.run(container, {
            rules: {
              "document-title": { enabled: false },
              "html-has-lang": { enabled: false },
            },
          });
          const summary = results.violations.map(
            (v) => `${v.id} (${v.impact}): ${v.nodes.length} node(s)`,
          );
          expect(summary, `axe violations in ${story} @ ${theme}`).toEqual([]);
          cleanup();
          document.documentElement.removeAttribute("data-theme");
        });
      }
    });
  }
});
