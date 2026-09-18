# @vibeflow-tools/ui

## 0.3.2

### Patch Changes

- 2ffc278: Draw one status mark per kanban card. The card's leading slot was assembled inline in two places and the copies disagreed: the single-row card (the done lane and the compact view) chose one glyph, while the multi-row card appended a loader, a verify glyph and an unread dot. An in-progress card that was also verified painted up to three marks, and its title started 27px further right than the card below it; a verified review card showed the verdict plus the unread dot. Both layouts now draw the slot through one shared component that picks a single mark by a documented precedence — verify verdict, in-flight activity, done affordance, unread dot, lane dot — inside a fixed-width box, so every card in a lane starts its title at the same x. A verify verdict is also now shown only in the review and done lanes, on cards and on child rows; backlog / todo / in-progress keep their plain status glyph, which means the in-progress + verified pair (a loader beside a check) no longer renders anywhere. The verdict tooltips now state the correctness verdict — "Verified — implemented correctly" / "Failed verification — not implemented correctly" — instead of "Verification failed".
- 1c4374c: Show all three verify states on kanban cards. The only verify marker used to be a `✓ VERIFIED` chip gated on the `done` column, but verify runs before `review`, so a verified task sitting in review — the normal end state — showed nothing, and a FAILED verify looked exactly like one that never ran. A verify verdict now rides the leading icon slot on every card and child row: a check for passed, an alert for failed, and nothing when there is no verdict. It sits beside the in-progress loader instead of replacing it, so an in-progress task that is also verified reads correctly, and it names itself (`title`/`aria-label`: "Verified" / "Verification failed") so the state never relies on colour alone. The `done` chip is replaced by this glyph so a card never carries two markers for one fact.

  The persisted `verified` flag is now genuinely tri-state. Reading a task preserves an absent flag as `undefined` instead of collapsing it to `false`, and claiming a task (status → in-progress) clears the flag rather than writing `false`; `false` therefore uniquely means "the last verify failed" and `undefined` means "never verified". On a failed verify the CLI now ends with an explicit next step — "fix the issues above, then re-run: `vibeflow verify <task-id>`" — instead of stopping at the error.

- 26473be: The verification badge is no longer shown on Research tasks. The verdict gate was scoped to the review and done lanes but never looked at the task's type, so a Research task that carried a `verified` value rendered the amber "failed verification" glyph — a verdict about a UI change that Research tasks never make (they produce a findings report, not code). The gate is now one predicate, read by the cards and the child rows alike, that requires a verdict lane AND a type that can be verified: Research is excluded, and the stored values are left untouched (only their display stops). Every other type the store carries still shows its verdict — Enhancement, Feature and Chore, and the tasks with no type at all, which resolve to the generic Task everywhere else in the board.

  The leading status slot is no longer reserved in a lane that draws no mark. The slot's width was reserved unconditionally so that titles could not shift between cards of the same lane (the "3 marks / title moves 27px" fix), which left an empty 11px gutter before the title of any card with no mark — and an empty 12px one in the single-row (done and compact) layout, whose lane-dot fallback had a colour but no box and so rendered 0px wide. The reservation is now decided once per lane: a lane that draws at least one mark keeps reserving for all of its cards, so their titles stay aligned; a lane that draws none reserves nothing and its titles sit flush. The row layout's lane dot now has a real 7px box.

- be485d2: Cancel in the kanban Settings modal now undoes a theme changed on the Theme tab instead of leaving it applied. Selecting a theme applies a live preview only; Apply commits it, while Cancel, the X, Escape and the backdrop rewind both the applied theme and the stored preference to the value the modal opened with. The shared `SettingsModal` stays appearance-agnostic: its `appearance` slot may now be a render function that receives a per-open lifecycle handle, which is how the CLI's theme switcher takes part in Apply and Cancel. Choosing "System" reverts to whatever was stored before, including clearing the key again.
- 8d3fd54: Move the kanban theme picker into its own Settings tab and strip it back to a compact swatch grid. The shared `SettingsModal` now renders the `appearance` slot in a dedicated tab named by the surface (`appearanceTab`) instead of appending it to the bottom of the Board tab, so the modal stays appearance-agnostic and other consumers keep their two tabs. Each choice is now one chip — the registry preview swatch plus the theme name — with the per-option descriptions reduced to a native tooltip and the group hint moved to screen-reader-only text; keyboard navigation, focus visibility, radio semantics and the selected state (a check on the active chip) are unchanged.

## 0.3.1

### Patch Changes

- Kanban and overlay annotate task now has Advanced collapsible area where label and priority can be set

## 0.3.0

### Minor Changes

- 5489c28: Split FilesList into user attachments and system-captured files groups. System files (baselines, screenshots) are collapsed by default with a "Captured by Vibeflow" label.
- 1753223: Add collapsed Advanced section in add-task overlay for tags and priority

## 0.2.0

### Minor Changes

- 148cd3c: Kanban: new Compact view mode (Board | Compact | List). Compact shows one-line rows across all lanes — no tags, no comment/file counts. Done lane fits cards to screen height with "+N more" indicator. Overlay: add-task dialog now has an Advanced section with tag chips and priority selector.
- c57b423: Verify gate: optional enforcement in Settings > Enforcement. When ON, agents must run `vibeflow verify` before setting status to review. Auto-skips for non-UI tasks. `--skip-verify` flag available as bypass.

### Patch Changes

- dbff0c7: fix(ui): align VibeflowIcon bar geometry with brand mark (centered bars, uniform width)

## 0.1.3

### Patch Changes

- cad1cea: feat(kanban): limit done lane to10 items with hidden count indicator

  The done lane now shows a maximum of10 task cards. When there are more than10 done tasks, a dashed-border indicator card appears showing how many tasks are hidden and suggesting to use search to find them. No scrollbar in done lane (overflow-y: hidden).

## 0.1.2

### Patch Changes

- c917033: Increase kanban multi-select long-press timeout to 750ms with drag cancellation

## 0.1.1

### Patch Changes

- df7ecd6: Fix agent picker dropdown closing the detail panel. The outside-click handler on DetailPanel now correctly ignores clicks on the portaled agent picker dropdown, matching the existing behavior for model picker dropdowns and modal backdrops.
- defc6cf: Fix multi-select drag & drop to preserve relative order of selected tasks. Previously, all selected tasks were appended to the column bottom. Now they are inserted at the drop position with correct sort keys computed from the final arrangement. Added e2e Playwright test verifying the behavior.
