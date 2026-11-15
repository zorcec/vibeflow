# Design-system gates

What runs when, and why it is split. Two lanes, no remote CI (ADR-0004 here,
ADR-0007 in the private repo): the local hooks and one explicit command **are**
the gate.

## Fast lane — `git push` (`.husky/pre-push`)

Affected-only: `scripts/affected-suites.mjs` maps the pushed paths to suites and
the hook runs just those.

| suite | runs | measured |
| --- | --- | --- |
| `ui` | `check:bundle-budget` → `pnpm --filter @vibeflow-tools/ui run test` → `test:stories` | ~20 s (16 s unit + 4 s stories + <1 s budget) |
| `unit` | `vitest run` (root) | ~45 s |
| `playwright` | browser suite | ~26 s |
| `integration` | integration suite | ~1 s |
| `e2e` | end-to-end suite | varies |

The six-theme axe sweep and the story-matrix discovery test live **inside** the
unit suite (`a11y-themes.test.tsx`, `story-matrix.test.ts`), so the fast lane
already catches an unregistered story or an unlabelled control.

## Slow lane — `pnpm gate:ui`

`scripts/gate-ui.mjs`, fails fast, prints a per-step table:

1. **bundle budget** — `packages/cli/scripts/check-bundle-budget.mjs`
2. **ui unit suite** — incl. story matrix + six-theme axe
3. **ui stories** — chromium, because jsdom cannot drive focus/portals
4. **ui coverage** — design-system surface thresholds, 100% variant branches
5. **storybook build** — the static docs surface is a shipping artefact
6. **overlay pixel guard** — token isolation + hostile-host CSS, needs the
   prebuilt bundle

Everything at once is minutes, not seconds — that is why it is one explicit
command and not part of a push.

## Bundle budget

`packages/cli/bundle-budget.json` records the built board/overlay artefacts and
the shadow-root utility subset. `check-bundle-budget.mjs` prints

```
artifact                          current    budget     delta  status
dist/client/kanban.css              73693     75717     -2024  ok
```

and exits non-zero on growth. The allowance is **2%** (see the file's
`$comment`): the v4 pipeline emits stable CSS, JS grows with the primitives
because Base UI brings its own runtime, and anything beyond 2% deserves a
reviewer's eyes. Raising a number is allowed — doing it silently is not: the
budget lives in the diff, so growth is always a visible line in a commit.

The shadow-root subset is budgeted separately because it is the one place a
second styling system could quietly grow: it ships inside every overlay page.
P7.2 measured 4,910 B for the first subset; the constants now carry the
primitives added since (Select, Tabs, Input, Dialog, Popover, Tooltip).

## What is deliberately NOT here

- **Story-level visual regression** — runs once at the end of the rebuild
  (`FINAL`), not mid-flight: a baseline captured while the branch is still
  moving pins a half-finished state.
- **Mutation tests** — on request only (owner policy).
- **A remote pipeline** — there is none by decision.
