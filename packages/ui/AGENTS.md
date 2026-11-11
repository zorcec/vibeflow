# UI package — design-system conventions (P8)

How to add a component. The scaffold (`scripts/scaffold-component.mjs`)
does all of this for you — `node packages/ui/scripts/scaffold-component.mjs <Name>`
— read below only to understand *why* it does what it does, or when hand-editing.

## Compose on `cn` / `cva`

- Import both from the primitives folder index, never a deep file path:
  `import { cn, cva } from "../primitives"` (inside `src/`),
  never `../primitives/cn`. Outside the package, import the package entry
  (`@vibeflow-tools/ui`) or a declared subpath (`./primitives`) — never a
  `…/src/…` file path.
- Visual states go in a `cva` variant map with `defaultVariants`; resolve with
  `widgetStyles({ tone })` and merge caller overrides last:
  `cn(widgetStyles({ tone }), className)`.
- Every key of the variant map needs a story (the story-matrix test enforces
  the exact set) and a unit-test render (the scoped coverage gate enforces it).

## Tokens only, no raw values

- Colours, surfaces, shadows come from the token→utility map in
  `src/primitives/theme.css` (`@theme inline` over `--t-*`): `bg-bg`,
  `text-text`, `border-border`, `bg-accent-soft`, `shadow-card`, …
- Never raw hex / rgba in markup or styles (`#fcd34d`, `rgba(…)`, inline
  `style={{ color: … }}`) — the six-theme sweep cannot see through them and
  the next theme silently breaks the component. (Legacy `StatusBadge`-style
  inline styles predate this rule; do not copy them.)
- No arbitrary Tailwind values (`w-[137px]`, `text-[13px]`, `bg-[#fff]`).
  If no token utility fits, the token is missing — add it to `theme.css`
  (and the per-theme blocks in `src/kanban/themes.css`), don't route around it.

## Stories: one per variant/state, with `play` + axe

- Location `stories/<Name>.stories.tsx`, `title: "Design System/<Name>"`,
  `decorators: [themeDecorator]` (the six-theme harness), callbacks as
  `storybook/test` `fn()` spies. Full pattern: `stories/play-pattern.md`.
- Every exported story has a `play` that (1) calls
  `await expectNoA11yViolations(canvasElement)` from `stories/a11y.ts`
  (story-level axe — the component sweep cannot see story-added markup),
  (2) scopes queries to `within(canvasElement)`, never `document`/`screen`,
  (3) drives one user-visible behaviour with `userEvent` and asserts its
  effect (spy payload, text change). No `waitForTimeout`, no arbitrary sleeps.
- Register the file in `src/primitives/__tests__/story-matrix.manifest.ts`
  (one entry: component, storyFile, title, every story + what it covers).
  The matrix test fails on unregistered files/stories and on stories without
  `play`. The scaffold writes this entry; hand-added stories must add it too.
- Recommended follow-up (not gated): mirror the new story's render in the
  six-theme component sweep (`a11y-themes.test.tsx`), per `play-pattern.md`.

## Tests

- Unit test at `src/components/__tests__/<Name>.test.tsx`: render every
  variant, assert the resolved token classes, fire the callbacks and assert
  payloads. This is what keeps the scoped 90% coverage gate green
  (coverage `include` is `src/primitives/**` + `src/components/**`).
- The `test:stories` suite runs every story's `play` in headless chromium —
  a story that passes in jsdom but breaks in a real browser fails there.

## Template — `src/templates/` (not shipped, cannot rot)

- `TemplateWidget.{tsx,stories.tsx}` + `__tests__/TemplateWidget.test.tsx`
  is the smallest correct component: typed props, `cva` tones, `cn` merge,
  token-only classes, two stories with axe + interaction plays, unit test.
- It is real code, not a sketch: `tsc --noEmit` typechecks the component
  and the unit test, and the unit suite runs the test, so drift breaks the
  build instead of rotting silently. The template *story* is the one
  exception: it imports `stories/a11y` + `.storybook/ThemeDecorator`, which
  live outside the tsconfig `rootDir` (`./src`), so it is excluded there
  and guarded instead by `__tests__/story-template.test.ts`, which asserts
  every marker the scaffold and the matrix gate depend on (title,
  decorator, Quiet+Loud with axe plays, the import lines the scaffold
  rewrites). Change the template story's imports and that test tells you
  to update the scaffold's rewrite table.
- **Coverage:** excluded by construction — the coverage `include` covers only
  `src/primitives/**` and `src/components/**`, so `src/templates/**` is
  outside the gate (stating this per the P8 contract instead of covering a
  file that never ships). Excluded from the shipped entry the same way:
  `src/index.ts` never re-exports it.
- The scaffold copies these files with `TemplateWidget` → `<Name>` (plus the
  three import-path rewrites documented at the top of the script). Fix the
  template, not the copies — every future component inherits the fix.

## Scaffold — `scripts/scaffold-component.mjs`

`node packages/ui/scripts/scaffold-component.mjs <Name>` writes four things:
component (`src/components/<Name>.tsx`), story (`stories/<Name>.stories.tsx`),
unit test (`src/components/__tests__/<Name>.test.tsx`), and the manifest entry —
so the story-matrix guard is satisfied on the first commit, no hand edits.
It refuses (non-zero exit, clear message) to overwrite an existing component
and refuses names that aren't PascalCase (`/^[A-Z][A-Za-z0-9]*$/`).
