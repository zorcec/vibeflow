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
    component: "ChatPanel",
    storyFile: "stories/ChatPanel.stories.tsx",
    title: "Design System/ChatPanel",
    stories: [
      { name: "Ready", covers: 'status="ready" with messages + send interaction' },
      { name: "Streaming", covers: 'streamingText set (streaming state)' },
    ],
  },
  {
    component: "KanbanCard",
    storyFile: "stories/TaskCard.stories.tsx",
    title: "Design System/TaskCard",
    stories: [
      { name: "Skeleton", covers: "task title render + card-click interaction" },
    ],
  },
  {
    component: "TokenSwatch",
    storyFile: "stories/TokenUtilities.stories.tsx",
    title: "Design System/TokenUtilities",
    stories: [
      { name: "TokenColours", covers: "bg-bg/text-text token utilities resolve per theme" },
    ],
  },
  {
    component: "VibeflowIcon",
    storyFile: "stories/VibeflowIcon.stories.tsx",
    title: "Design System/VibeflowIcon",
    stories: [
      { name: "Default", covers: "size=32 default render" },
      { name: "Large", covers: "size=64 large render" },
    ],
  },
];
