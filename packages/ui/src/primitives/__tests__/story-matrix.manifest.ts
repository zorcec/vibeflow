/**
 * Story-matrix manifest (design-system P5.2) — the explicit list of every
 * variant/state each design-system component declares, and the story that
 * proves it renders.
 *
 * The test beside this file (`story-matrix.test.ts`) reads the actual
 * `stories/*.stories.tsx` sources and fails when:
 *  - a manifest entry has no matching `export const <Story>` in its file,
 *  - a story export has no `play` function (interaction coverage is mandatory),
 *  - a story file is missing the shared `themeDecorator` (six-theme harness),
 *  - a story file or export exists that is NOT listed here (nothing ships
 *    unregistered — adding a story without declaring it here fails the suite).
 *
 * HOW THE NEXT COMPONENT REGISTERS (three edits, no other registry):
 *  1. Add `stories/<Component>.stories.tsx` with `title: "Design System/<Component>"`,
 *     the `themeDecorator`, and one exported story per variant/state with a
 *     `play` function (see `stories/play-pattern.md` for the pattern).
 *  2. Append one entry below: `{ component, storyFile, title, stories }`.
 *  3. Run `pnpm --filter @vibeflow-tools/ui run test src/primitives/__tests__/story-matrix.test.ts`.
 *
 * The manifest is derived from the stories themselves plus what the
 * components declare today (proof stories only — no cva primitives yet, so
 * each entry's `covers` names the prop/state the story exercises). When the
 * first cva primitive lands, its entry lists every key of its variant map,
 * and the test's exact-set check forces one story per variant.
 */
export interface StoryMatrixStory {
  /** Exported story name — must match `export const <name>` exactly. */
  readonly name: string;
  /** Which variant/state/props this story exercises. */
  readonly covers: string;
}

export interface StoryMatrixEntry {
  /** Component the stories prove. */
  readonly component: string;
  /** Path relative to `packages/ui/`. */
  readonly storyFile: string;
  /** Storybook title — must match `title: "..."` in the file. */
  readonly title: string;
  /** Every story this component must ship. Exact set: no more, no fewer. */
  readonly stories: readonly StoryMatrixStory[];
}

export const STORY_MATRIX: readonly StoryMatrixEntry[] = [
  {
    component: "KanbanListView",
    storyFile: "stories/kanban/kanban-list-view.stories.tsx",
    title: "Design System/Kanban/ListView",
    stories: [
      { name: "Default", covers: "rows across statuses render, axe clean" },
      { name: "Mobile", covers: "mobile status select is labelled and token-styled" },
      { name: "CollapseGroup", covers: "the collapse toggle flips the group" },
      { name: "Empty", covers: "no rows render for an empty list" },
    ],
  },
  {
    component: "ChildRow",
    storyFile: "stories/kanban/child-row.stories.tsx",
    title: "Design System/Kanban/ChildRow",
    stories: [
      { name: "Inline", covers: "row renders with its data-role hook" },
      { name: "Collapsible", covers: "toggle keeps aria-expanded and is clickable" },
      { name: "WithUnlink", covers: "unlink renders only with an onRemove callback and is labelled" },
    ],
  },
  {
    component: "RelationsSection",
    storyFile: "stories/kanban/relations-section.stories.tsx",
    title: "Design System/Kanban/RelationsSection",
    stories: [
      { name: "WithChildren", covers: "child row renders inside the relation group, axe clean" },
      { name: "Empty", covers: "renders with no relations, axe clean" },
    ],
  },
  {
    component: "DetailPanel",
    storyFile: "stories/kanban/detail-panel.stories.tsx",
    title: "Design System/Kanban/DetailPanel",
    stories: [
      { name: "Default", covers: "three named tabs, axe clean (fixed select/close names)" },
      { name: "TabSwitching", covers: "clicking Activity moves the active class token" },
      { name: "TitleField", covers: "the title field is a real input with the task title" },
    ],
  },
  {
    component: "SettingsModal",
    storyFile: "stories/kanban/settings-modal.stories.tsx",
    title: "Design System/Kanban/SettingsModal",
    stories: [
      { name: "Default", covers: "named Settings dialog, axe clean" },
      { name: "ApplyReports", covers: "Apply is a real button inside the dialog" },
      { name: "CancelDismisses", covers: "Cancel renders and is reachable" },
      { name: "TabsSwitch", covers: "the tab bar keeps its panes reachable by name" },
    ],
  },
  {
    component: "ModalBase",
    storyFile: "stories/kanban/modal.stories.tsx",
    title: "Design System/Kanban/Modal",
    stories: [
      { name: "Base", covers: "dialog role + accessible name + aria-modal, axe clean" },
      { name: "Confirm", covers: "destructive action reports through onConfirm" },
      { name: "EscapeCancels", covers: "Escape closes through onCancel, not confirm" },
    ],
  },
  {
    component: "KanbanHeader",
    storyFile: "stories/kanban/header.stories.tsx",
    title: "Design System/Kanban/Header",
    stories: [
      { name: "Default", covers: "labelled search textbox accepts typing, axe clean" },
      { name: "MobileMenuTrigger", covers: "menu trigger keeps its aria hooks" },
      { name: "WithBackLinkAndActions", covers: "back link + extra action layout" },
    ],
  },
  {
    component: "FilterBar",
    storyFile: "stories/kanban/filter-bar.stories.tsx",
    title: "Design System/Kanban/FilterBar",
    stories: [
      { name: "Default", covers: "status chips and tag/user filters render, axe clean" },
      { name: "StatusFilterClick", covers: "clicking Review reports status=review to onFilter" },
      { name: "Narrow", covers: "list view renders the bar at a mobile viewport" },
    ],
  },
  {
    component: "TaskCard",
    storyFile: "stories/kanban/task-card.stories.tsx",
    title: "Design System/Kanban/TaskCard",
    stories: [
      { name: "Default", covers: "card-title + copy-id hooks, axe clean in every theme" },
      { name: "Compact", covers: "compact layout keeps the title hook" },
      { name: "WithAdvanceControl", covers: "onAdvanceTask renders the advance control with data-next-status" },
      { name: "WithoutAdvanceControl", covers: "absent callback renders no advance control (ListView contract)" },
      { name: "Skeleton", covers: "a card with no optional chrome still opens on title click" },
    ],
  },
  {
    component: "ChatPanel",
    storyFile: "stories/ChatPanel.stories.tsx",
    title: "Design System/Collab/ChatPanel",
    stories: [
      { name: "Ready", covers: 'status="ready" with messages + send interaction' },
      { name: "Streaming", covers: 'streamingText set (streaming state)' },
    ],
  },
    {
    component: "TokenSwatch",
    storyFile: "stories/TokenUtilities.stories.tsx",
    title: "Design System/Foundations/TokenUtilities",
    stories: [
      { name: "TokenColours", covers: "bg-bg/text-text token utilities resolve per theme" },
    ],
  },
  {
    component: "VibeflowIcon",
    storyFile: "stories/VibeflowIcon.stories.tsx",
    title: "Design System/Foundations/VibeflowIcon",
    stories: [
      { name: "Default", covers: "size=32 default render" },
      { name: "Large", covers: "size=64 large render" },
    ],
  },
  {
    component: "Button",
    storyFile: "stories/primitives/button.stories.tsx",
    title: "Design System/Primitives/Button",
    stories: [
      { name: "PrimarySm", covers: 'variant="primary" size="sm" render + click interaction' },
      { name: "PrimaryMd", covers: 'variant="primary" size="md" render + click interaction' },
      { name: "PrimaryLg", covers: 'variant="primary" size="lg" render + click interaction' },
      { name: "SecondarySm", covers: 'variant="secondary" size="sm" render + click interaction' },
      { name: "SecondaryMd", covers: 'variant="secondary" size="md" render + click interaction' },
      { name: "SecondaryLg", covers: 'variant="secondary" size="lg" render + click interaction' },
      { name: "GhostSm", covers: 'variant="ghost" size="sm" render + click interaction' },
      { name: "GhostMd", covers: 'variant="ghost" size="md" render + click interaction' },
      { name: "GhostLg", covers: 'variant="ghost" size="lg" render + click interaction' },
      { name: "DangerSm", covers: 'variant="danger" size="sm" render + click interaction' },
      { name: "DangerMd", covers: 'variant="danger" size="md" render + click interaction' },
      { name: "DangerLg", covers: 'variant="danger" size="lg" render + click interaction' },
      { name: "Disabled", covers: "disabled state blocks the click handler" },
      { name: "Loading", covers: "loading state sets aria-busy, shows a spinner, blocks the handler" },
      { name: "KeyboardActivation", covers: "Enter and Space keystrokes activate the button" },
      { name: "KeyboardFocusRing", covers: "keyboard focus resolves a ring that differs from the resting style" },
    ],
  },
  {
    component: "Badge",
    storyFile: "stories/primitives/badge.stories.tsx",
    title: "Design System/Primitives/Badge",
    stories: [
      { name: "DefaultSm", covers: 'variant="default" size="sm" render + axe' },
      { name: "DefaultMd", covers: 'variant="default" size="md" render + axe' },
      { name: "SecondarySm", covers: 'variant="secondary" size="sm" render + axe' },
      { name: "SecondaryMd", covers: 'variant="secondary" size="md" render + axe' },
      { name: "OutlineSm", covers: 'variant="outline" size="sm" render + axe' },
      { name: "OutlineMd", covers: 'variant="outline" size="md" render + axe' },
      { name: "DangerSm", covers: 'variant="danger" size="sm" render + axe' },
      { name: "DangerMd", covers: 'variant="danger" size="md" render + axe' },
      { name: "StatusTones", covers: "every status tone resolves the canonical --t-chip-* token, measured in two themes" },
      { name: "WithDot", covers: "leading dot marker renders and stays decorative (aria-hidden)" },
      { name: "Attention", covers: "the attention tone renders with its own hue" },
    ],
  },
  {
    component: "Input",
    storyFile: "stories/primitives/input.stories.tsx",
    title: "Design System/Primitives/Input",
    stories: [
      { name: "Default", covers: "text type, typing fires onChange" },
      { name: "Email", covers: "email type forwarded" },
      { name: "Password", covers: "password type forwarded" },
      { name: "Search", covers: "search type forwarded" },
      { name: "Number", covers: "number type forwarded" },
      { name: "Disabled", covers: "disabled blocks typing and keeps the value" },
      { name: "Readonly", covers: "readonly keeps the value but blocks typing" },
      { name: "Error", covers: "error sets aria-invalid and a resolvable aria-describedby" },
      { name: "FocusVisible", covers: "keyboard focus resolves a visible ring" },
    ],
  },
  {
    component: "Textarea",
    storyFile: "stories/primitives/textarea.stories.tsx",
    title: "Design System/Primitives/Textarea",
    stories: [
      { name: "Default", covers: "default rows, typing fires onChange" },
      { name: "Rows", covers: "rows prop forwarded" },
      { name: "ResizeBoth", covers: "resize=both applies the free resize handle" },
      { name: "AutoExpand", covers: "autoExpand grows the measured box with content" },
      { name: "Disabled", covers: "disabled blocks typing and keeps the value" },
      { name: "Readonly", covers: "readonly keeps the value but blocks typing" },
      { name: "Error", covers: "error sets aria-invalid and a resolvable aria-describedby" },
      { name: "FocusVisible", covers: "keyboard focus resolves a visible ring" },
      { name: "ResizeNone", covers: "resize=none applies resize-none" },
      { name: "ResizeVertical", covers: "resize=vertical applies resize-y" },
    ],
  },
  {
    component: "Dialog",
    storyFile: "stories/primitives/dialog.stories.tsx",
    title: "Design System/Primitives/Dialog",
    stories: [
      { name: "Closed", covers: "closed renders no dialog node" },
      { name: "Open", covers: "trigger opens it; aria-modal, focus inside, axe clean" },
      { name: "LongContent", covers: "long body scrolls inside the popup, measured" },
      { name: "Footerless", covers: "no footer renders no action row" },
      { name: "ContainerHost", covers: "portals into the given container (overlay shadow-root contract)" },
      { name: "CloseBehaviours", covers: "Escape closes; backdrop click closes" },
    ],
  },
  {
    component: "Popover",
    storyFile: "stories/primitives/popover.stories.tsx",
    title: "Design System/Primitives/Popover",
    stories: [
      { name: "Bottom", covers: "opens bottom; axe clean" },
      { name: "Top", covers: "opens top (or flips) with a resolved side" },
      { name: "RightAlignedEnd", covers: "right side with end alignment" },
      { name: "Left", covers: "left side" },
      { name: "LongContent", covers: "long content renders outside the canvas" },
      { name: "ViewportEdge", covers: "corner trigger stays inside the viewport, measured" },
      { name: "ClosesOnEscape", covers: "Escape closes the popover" },
    ],
  },
  {
    component: "Tooltip",
    storyFile: "stories/primitives/tooltip.stories.tsx",
    title: "Design System/Primitives/Tooltip",
    stories: [
      { name: "Top", covers: "keyboard focus shows the hint; axe clean" },
      { name: "Bottom", covers: "bottom side" },
      { name: "Right", covers: "right side" },
      { name: "Left", covers: "left side" },
      { name: "LongContent", covers: "long hint wraps and stays visible" },
      { name: "Hover", covers: "hover shows the hint" },
      { name: "DisabledTrigger", covers: "disabled trigger renders no tooltip and no described-by" },
    ],
  },
  {
    component: "Select",
    storyFile: "stories/primitives/select.stories.tsx",
    title: "Design System/Primitives/Select",
    stories: [
      { name: "Default", covers: "opens on click; combobox/listbox roles; 4 options" },
      { name: "Seeded", covers: "selected value renders in the trigger" },
      { name: "Keyboard", covers: "ArrowDown opens, ArrowDown highlights, Enter commits (browser)" },
      { name: "EscapeKeepsValue", covers: "Escape closes without changing the value" },
      { name: "Disabled", covers: "disabled trigger never opens" },
      { name: "EmptyOptions", covers: "empty list renders no options" },
      { name: "LongList", covers: "40 options, axe clean" },
    ],
  },
  {
    component: "Tabs",
    storyFile: "stories/primitives/tabs.stories.tsx",
    title: "Design System/Primitives/Tabs",
    stories: [
      { name: "Automatic", covers: "ArrowRight activates in automatic mode (browser)" },
      { name: "Manual", covers: "ArrowRight moves focus only; Enter commits" },
      { name: "Vertical", covers: "ArrowDown navigates a vertical tablist" },
      { name: "ClickSwitching", covers: "click switches panels; axe clean" },
      { name: "DisabledTab", covers: "a disabled tab cannot activate" },
    ],
  },
  {
    component: "Collab",
    storyFile: "stories/collab/collab.stories.tsx",
    title: "Design System/Collab",
    stories: [
      { name: "AvatarInitials", covers: "initials fallback, hashed colour" },
      { name: "AvatarWithImage", covers: "injected image renderer (next/image seam)" },
      { name: "VerifiedBadge", covers: "tri-state verified flag" },
      { name: "AwayVeil", covers: "inactivity veil is not a hit target" },
    ],
  },
  {
    component: "ActivityCounter",
    storyFile: "stories/collab/activity-counter.stories.tsx",
    title: "Design System/Collab/ActivityCounter",
    stories: [
      { name: "NoActivity", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "UnseenActivity", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
    ],
  },
  {
    component: "ActivityFeedPanel",
    storyFile: "stories/collab/activity-feed-panel.stories.tsx",
    title: "Design System/Collab/ActivityFeedPanel",
    stories: [
      { name: "Default", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Empty", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
    ],
  },
  {
    component: "InactivityVeil",
    storyFile: "stories/collab/inactivity-veil.stories.tsx",
    title: "Design System/Collab/InactivityVeil",
    stories: [
      { name: "Default", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
    ],
  },
  {
    component: "MembersOverviewPanel",
    storyFile: "stories/collab/members-overview-panel.stories.tsx",
    title: "Design System/Collab/MembersOverviewPanel",
    stories: [
      { name: "Default", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Empty", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
    ],
  },
  {
    component: "VerifiedEmailBadge",
    storyFile: "stories/collab/verified-email-badge.stories.tsx",
    title: "Design System/Collab/VerifiedEmailBadge",
    stories: [
      { name: "Verified", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Unverified", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Unknown", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
    ],
  },
  {
    component: "AttentionBadge",
    storyFile: "stories/kanban/attention-badge.stories.tsx",
    title: "Design System/Kanban/AttentionBadge",
    stories: [
      { name: "Flagged", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "NotFlagged", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
    ],
  },
  {
    component: "ConfirmModal",
    storyFile: "stories/kanban/confirm-modal.stories.tsx",
    title: "Design System/Kanban/ConfirmModal",
    stories: [
      { name: "Default", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Loading", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "WithError", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
    ],
  },
  {
    component: "CopyIdButton",
    storyFile: "stories/kanban/copy-id-button.stories.tsx",
    title: "Design System/Kanban/CopyIdButton",
    stories: [
      { name: "Default", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Revealed", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Collapsed", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
    ],
  },
  {
    component: "DeleteConfirmDialog",
    storyFile: "stories/kanban/delete-confirm-dialog.stories.tsx",
    title: "Design System/Kanban/DeleteConfirmDialog",
    stories: [
      { name: "NoChildren", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "WithChildren", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Failed", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
    ],
  },
  {
    component: "FilePreviewModal",
    storyFile: "stories/kanban/file-preview-modal.stories.tsx",
    title: "Design System/Kanban/FilePreviewModal",
    stories: [
      { name: "Image", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Unsupported", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
    ],
  },
  {
    component: "KanbanBoard",
    storyFile: "stories/kanban/kanban-board.stories.tsx",
    title: "Design System/Kanban/KanbanBoard",
    stories: [
      { name: "Default", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Empty", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
    ],
  },
  {
    component: "PriorityBadge",
    storyFile: "stories/kanban/priority-badge.stories.tsx",
    title: "Design System/Kanban/PriorityBadge",
    stories: [
      { name: "Critical", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "High", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Medium", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Low", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Unknown", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
    ],
  },
  {
    component: "RecursiveChildrenTree",
    storyFile: "stories/kanban/recursive-children-tree.stories.tsx",
    title: "Design System/Kanban/RecursiveChildrenTree",
    stories: [
      { name: "TwoLevels", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "NoChildren", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
    ],
  },
  {
    component: "StatusBadge",
    storyFile: "stories/kanban/status-badge.stories.tsx",
    title: "Design System/Kanban/StatusBadge",
    stories: [
      { name: "Backlog", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Todo", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "InProgress", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Review", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Done", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Cancelled", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
    ],
  },
  {
    component: "TaskDetailPanel",
    storyFile: "stories/kanban/task-detail-panel.stories.tsx",
    title: "Design System/Kanban/TaskDetailPanel",
    stories: [
      { name: "Open", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Closed", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
    ],
  },
  {
    component: "TypeBadge",
    storyFile: "stories/kanban/type-badge.stories.tsx",
    title: "Design System/Kanban/TypeBadge",
    stories: [
      { name: "Task", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Bug", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Research", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
    ],
  },
  {
    component: "TypePicker",
    storyFile: "stories/kanban/type-picker.stories.tsx",
    title: "Design System/Kanban/TypePicker",
    stories: [
      { name: "Default", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Disabled", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
    ],
  },
  {
    component: "AutoExpandTextarea",
    storyFile: "stories/shared/auto-expand-textarea.stories.tsx",
    title: "Design System/Shared/AutoExpandTextarea",
    stories: [
      { name: "Empty", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "MultiLine", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
    ],
  },
  {
    component: "CommentsInputArea",
    storyFile: "stories/shared/comments-input-area.stories.tsx",
    title: "Design System/Shared/CommentsInputArea",
    stories: [
      { name: "Empty", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "WithDraft", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Submitting", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
    ],
  },
  {
    component: "CommentsList",
    storyFile: "stories/shared/comments-list.stories.tsx",
    title: "Design System/Shared/CommentsList",
    stories: [
      { name: "Default", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "WithSystemEntries", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Empty", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
    ],
  },
  {
    component: "FilesList",
    storyFile: "stories/shared/files-list.stories.tsx",
    title: "Design System/Shared/FilesList",
    stories: [
      { name: "Default", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Loading", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Failed", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Empty", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
    ],
  },
  {
    component: "MarkdownEditableField",
    storyFile: "stories/shared/markdown-editable-field.stories.tsx",
    title: "Design System/Shared/MarkdownEditableField",
    stories: [
      { name: "Write", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Preview", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "PreviewEmpty", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
    ],
  },
  {
    component: "MarkdownPreview",
    storyFile: "stories/shared/markdown-preview.stories.tsx",
    title: "Design System/Shared/MarkdownPreview",
    stories: [
      { name: "Default", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Empty", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "WithTaskReference", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
    ],
  },
  {
    component: "TagInput",
    storyFile: "stories/shared/tag-input.stories.tsx",
    title: "Design System/Shared/TagInput",
    stories: [
      { name: "Default", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Disabled", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
    ],
  },
  {
    component: "TagPills",
    storyFile: "stories/shared/tag-pills.stories.tsx",
    title: "Design System/Shared/TagPills",
    stories: [
      { name: "ReadOnly", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Removable", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
      { name: "Empty", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
    ],
  },
  {
    component: "TaskDetailsTab",
    storyFile: "stories/shared/task-details-tab.stories.tsx",
    title: "Design System/Shared/TaskDetailsTab",
    stories: [
      { name: "Default", covers: "renders; structural axe clean (contrast is swept by scripts/a11y-sweep.mjs)" },
    ],
  },
];
