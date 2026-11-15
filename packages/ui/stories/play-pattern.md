# Interaction `play` pattern (design-system P5.2)

Every story in `packages/ui/stories/` MUST ship a `play` function. The
story-matrix manifest test (`src/primitives/__tests__/story-matrix.test.ts`)
fails any story without one — an interaction nobody exercised is an
interaction nobody reviewed.

## Pattern

```tsx
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { themeDecorator } from "../.storybook/ThemeDecorator";

const meta: Meta<typeof MyComponent> = {
  title: "Design System/MyComponent",
  component: MyComponent,
  decorators: [themeDecorator], // six-theme harness, always present
  args: {
    onAction: fn(), // callbacks are storybook/test fn() spies, asserted below
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Active: Story = {
  args: { /* the variant/state this story proves */ },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId("my-thing")).toBeVisible();
    await userEvent.click(canvas.getByTestId("my-button"));
    await expect(args.onAction).toHaveBeenCalledWith("expected-payload");
  },
};
```

Rules:

- Assert with `expect` from `storybook/test`, scoped to `within(canvasElement)`
  — never `document` or `screen`.
- Drive at least one user-visible behaviour per story (`userEvent.click/type`)
  and assert its effect (spy called, text changed). Visibility-only stories
  are allowed only when the story's whole point is rendering (e.g. token
  swatches, icon sizes) — see `TokenUtilities` / `VibeflowIcon`.
- No `waitForTimeout`, no arbitrary sleeps — `expect`/`userEvent` already
  retry; a sleep is a flake waiting to happen.
- Use `fn()` spies for every callback the component takes, and assert the
  payload, not just the call.

## Real examples (landed with P5.1, guarded by P5.2)

- `stories/ChatPanel.stories.tsx` — `Ready` types into the input, clicks
  send, and asserts `onSend` received the text; `Streaming` asserts the
  streaming text renders.
- `stories/TaskCard.stories.tsx` — `Skeleton` clicks the card title and
  asserts `handlers.onCardClick` received the task.
- `stories/TokenUtilities.stories.tsx` — `TokenColours` asserts the computed
  `bg-bg`/`text-text` colours resolve per theme (guards the Tailwind entrance).
- `stories/VibeflowIcon.stories.tsx` — `Default`/`Large` assert the icon
  renders with the right size.

The a11y six-theme sweep (`a11y-themes.test.tsx`) mirrors each story's args in
jsdom + axe; when you add a story here, add its render case there too.
