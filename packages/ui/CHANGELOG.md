# @vibeflow-tools/ui

## 0.3.6

### Patch Changes

- 0bcf80c: The child-row status badge now fades out while the row is hovered or keyboard-focused — the same state that reveals the copy-id tab — so the revealed tab is not competing with the badge. The badge stays in the DOM (and in the accessibility tree) with its status text and tooltip; only its opacity changes, so no layout shifts.
- 2a5197a: Reveal the child-row copy tab only on row hover.

  The copy tab on a nested child row used to be permanently visible and always
  reserved its ~30px at the row's right edge, because its edge style is inline
  and inline beats the stylesheet: `.card-copy-id { opacity: 0 }` never applied
  and the absolute-positioning rule never took effect. The reveal rule
  `.child-link-row:hover .card-copy-id--child` could not match either — the tab
  is a SIBLING of `.child-link-row`, not a descendant.

  The tab is now collapsed to zero width, invisible and inert at rest, and the
  one reveal mechanism is the row's own hover/focus state (ChildRow's
  `wrapActive` → `CopyIdButton revealed`). Hovering anywhere on the row, or
  tabbing into the tab, restores exactly the approved full-height segment.
  Opacity + width are used, never display/visibility, so the tab stays in the
  a11y tree and in the tab order. The two dead stylesheet rules were deleted.

- 0bcf80c: The detail panel's ID tile now carries an always-visible copy-id button next to the task id — quiet at rest, with a lit well and stronger glyph on hover, and the usual copied confirmation on click.
- ad5d9b4: Replace lossy-JPEG-everything image ingest with the measured image matrix

  Uploads and pastes no longer transcode every image to lossy JPEG. A shared,
  dependency-injected transform module (`@vibeflow-tools/ui/kanban`, browser-safe
  core + one `@jsquash` wasm path for every runtime, pure JS/wasm only — no
  native dependencies) implements the policy: PNG/BMP/TIFF of any size become
  lossless WebP, images wider than 1920px are resized to width 1920 with WebP
  q80, narrow JPEGs are kept with only their metadata stripped (byte-level
  APP/COM drop, no re-encode), and GIF/SVG pass through untouched. Stored files
  always carry their true extension (`.webp`/`.jpg`/`.png`), and JPEG input
  never takes the lossless-WebP branch. The wasm binaries load lazily from the
  CLI server on first transform, so the overlay and board bundles stay small;
  where no codec is reachable the original bytes are kept with a matching
  extension instead of failing.

  - Images stop being squeezed into lossy JPEG: screenshots, uploads and pastes
    transcode to lossless WebP (bit-exact), and anything wider than 1920px is
    downscaled to 1920 at q80 — smaller files for storage and for agent image
    tokens. Pure wasm, no native dependencies: it works on every machine out of
    the box.

- 0b0010d: Add a copy-task-id button to kanban task cards

  A minimalistic icon in the card's top-right corner copies the task id to the
  clipboard, so the detail panel no longer has to be opened just to read it. The
  button is hidden until the card is hovered (or reached by keyboard focus), keeps
  the card's click behaviour out of the way via stopPropagation, and swaps to a
  check mark for 1.2s as copy feedback. Falls back to `execCommand("copy")` when
  `navigator.clipboard` is unavailable (plain-http LAN access to the CLI board).
  Exposed to tests as `[data-role="copy-id"]`.

  Refined for visibility: on card hover the pill lights up with the same hover
  background as the tree-toggle chip (22×22, radius 6) so it reads as an active
  affordance rather than a ghost icon, and `[data-copied]` turns it green while
  the check mark shows.

  Extended to child task rows on the board (inline card-zone tree and
  children popover): hovering a child row reveals the same copy-id pill — same
  icon, same click-to-copy with check feedback — parked at the row's right
  edge. The detail-panel rows are unchanged. The card-level hover reveal is
  scoped so hovering a card no longer lights up its children's pills.

  - Copy a task's id straight from the board: a hover-revealed pill on the card — and now on child rows too — copies the id to your clipboard with a green check as feedback, so the detail panel never has to be opened just to read it.

- 183f177: Kanban column headers show the nested-task hint as the bare count (`↳ 7`) instead of a bordered pill reading `↳ 7 nested`, and the pill's border/padding/background are gone. The explanation is unchanged and still available on hover (title) and to screen readers (aria-label), so nothing is lost beyond the visual weight.
- da40bcc: Remove the "live" connection pill from the kanban board header

  The header no longer shows the green live-status pill next to the project
  name. The board still reconnects automatically in the background; only the
  badge itself is gone, leaving a cleaner header.

- 373f267: Match the settings fullscreen checkbox to the modal's other checkboxes

  The "Open task details fullscreen" checkbox in the kanban settings Board tab
  set only `width`, `height` and `cursor`, so the browser painted it with the
  OS-default accent while every other checkbox in the same modal uses the
  design-token accent (`var(--t-accent)`). It now carries the same token, and it
  moved out of "Visible Columns" into its own "Display" section, because showing
  the details panel fullscreen is a display preference rather than a column
  choice. Behaviour is unchanged: the `panelFullscreen` flag, its toggle and the
  Apply path are exactly as before.

  - The fullscreen settings checkbox now picks up the theme accent instead of the OS default blue, and sits in its own "Display" section under the column list.

- a3cff3b: Redesign the child-row copy affordance as a full-height right-edge segment

  The copy-id control on child rows was a small floating pill parked over the
  row padding. It now renders as a full-height tab attached to the row's right
  edge inside a dedicated actions strip: faint glyph at rest so it reads as
  part of the row, lit well on row hover and on keyboard focus, green
  well while the "copied" check shows. The Unlink control joins it as a second
  full-height segment, still hover/focus-revealed. The row root and the
  actions strip are siblings inside a `.child-row-wrap`, so no interactive
  element nests inside another — neither native button-in-button nor
  button-inside-`div[role=button]`. Whole-row click, Enter/Space activation,
  row drag/drop, depth dimming, and the child status badge are unchanged.

- 567070c: Fix invalid HTML on the kanban board: child-row buttons nested inside the row button

  `ChildRow` rendered its root as a native `<button>` while carrying two
  interactive children (the copy-id pill and the Unlink button), which React
  flags as `validateDOMNesting: <button> cannot appear as a descendant of
<button>` and which made the row depend on `stopPropagation` shims for
  correct click/focus behaviour. The row root is now a `div` with `role="button"`,
  `tabIndex={0}` and Enter/Space handling, so the inner buttons are legal
  siblings; every behaviour is preserved (row click/keyboard open, expansion
  toggle, hover/keyboard-lit copy-id that copies, link/unlink, status badge,
  row drag) and every kept `stopPropagation` is a genuine bubbling/drag guard.

- 135b18f: Lock the kanban header to the board-configured icon with a regression test

  The shared kanban header renders the board's configured icon when one is
  provided (`projectIcon`) and keeps the Vibeflow brand mark only as the
  fallback for boards without an icon. A new `Header.project-icon` suite pins
  that arbitration — board icon present means the Vibeflow mark is absent and
  vice versa — plus the 32px icon box and the whitespace-counts-as-missing
  rule, so a future change that ignores `projectIcon` fails loudly instead of
  silently repainting every board with the brand mark. No visual change: the
  header renders exactly as before.

- 4604d6a: Board column headers now state the honest per-status breakdown, and nested child rows carry their own status

  A column used to show only its standalone card count (`Review · 5`) while
  `tasks --status review` counted every task bearing the status (15), because
  children render solely inside their parent's card. The header now reads
  `Review · 5 (+10 nested)` whenever tasks with that status render nested
  inside parent cards elsewhere, computed from the board's existing task data
  (total-by-status minus standalone-by-status, no second fetch); columns with
  no nested tasks render exactly as before. The nested figure is reachable via
  a hover title on the header count spelling out the breakdown. Board card
  child rows additionally show the child's own status badge, so a child in
  review nested under an in-progress parent reads as review. The nesting rule,
  drag/reparent behaviour, and done-lane fit logic are unchanged.

- 2f8d106: Show only the root-card count in kanban column headers

  Column headers render the count of root/standalone cards actually shown in
  that column (e.g. `Review · 2`). The old `(+N nested)` suffix is gone from
  the visible header text. Nothing is hidden: columns with nested tasks show
  a subtle `↳ N nested` hint chip beside the count, and both the count and
  the chip carry a hover title (`N tasks have status X: R shown as cards, M
nested inside parent cards in other columns`) plus an aria-label, so the
  numbers still reconcile against every task carrying the status. Child
  status badges inside parent cards are unchanged.

- b5ebf08: Remove the fullscreen checkbox from the kanban settings modal

  The "Open task details fullscreen" checkbox (`#settings-panel-fullscreen`)
  is gone from the settings Board tab, along with its local state and Apply
  wiring. The `panelFullscreen` preference itself stays alive: the detail
  panel's own maximize/restore control (`#dp-fullscreen-toggle`) still reads
  and writes the same persisted flag, `AppSettings.panelFullscreen` is
  unchanged, and the settings allowlist still accepts it. The modal's save
  payload omits the key, so App.tsx's `{ ...appSettings, ...newSettings }`
  merge preserves a previously saved value instead of clobbering it.

  - Settings no longer shows a fullscreen checkbox; the detail panel's own toggle remains the single control for the flag.

- 3dfdd54: Match the child-row status badge colours to the kanban columns

  The `.status-badge--*` label colours were shifted by one status relative to
  the board: a todo badge wore backlog's gray, an in-progress badge wore todo's
  orange, and a review badge wore in-progress's blue, so a label never matched
  its column (backlog and done happened to be correct). This was a copy/paste
  shift in the badge rules, not a design decision. The three wrong rules now
  carry their canonical hues — todo amber, in-progress blue, review purple —
  mirroring the DetailPanel status buttons, the FilterBar chips, and the list
  view, via the theme-aware chip tokens so dark and light themes recolour
  together. The CLI prints plain uncoloured `[status]` text, so there was
  nothing to match there.

- 341c1b1: Document the web runtime in the shared codec layer's contract: like the CLI browser bundles, the web app now serves the jsquash wasm binaries from its own origin (`/__vibeflow__/codecs`, shipped in the web app public directory), so web/SaaS uploads run the same transform matrix. The loader API is unchanged — `configureWasmBaseUrl` already accepted any base URL.

  - The shared image-codec layer now names both runtimes it serves: the CLI server route and the web app's own origin both feed the same lazy wasm loader, so one transform matrix covers every upload path.

## 0.3.5

### Patch Changes

- f12d24c: description grows 6→24 rows with preview mirroring the same rows, and the details panel can be resized up to 100% of the viewport

  The description edit textarea rests at 6 rows and auto-extends up to 24 rows
  (doubled from 12); the preview box mirrors that row range (min 6 / max 24,
  converted with its own typography) instead of the fixed 80/220px box, so both
  modes show the same number of lines. The panel's manual resize clamp is lifted
  from 860px to the viewport width (min 360px kept; saved widths load clamped to
  the viewport). Panel and field widths never change with content.

- b7e985b: Task details can open fullscreen, persisted as a global preference

  The detail-panel header gains a fullscreen toggle (expand/restore) next to the
  close button, mirrored by an "Open task details fullscreen" checkbox in the
  settings Board tab. The `panelFullscreen` flag persists through the existing
  settings round-trip (CLI settings JSON allowlist; web tRPC blob needs no
  backend change) and applies to every opened task on both surfaces. Fullscreen
  renders as a fixed viewport overlay class so the saved `panelWidth` is
  preserved verbatim for an exact restore; the resize handle hides while
  fullscreen and Escape/X still close the panel.

- 65595cb: fix(ui): stop the DetailPanel title autofocus from stealing focus, and add test hooks

  The detail panel focused its title input from a bare `setTimeout(…, 50)` inside an effect
  keyed on `[open, task?.id, tab]`, so it fired on every task _and_ tab change, unconditionally.
  Two real bugs followed:

  - Open a task and click the Tags input, and 50 ms later focus jumped back to the title —
    mid-click, mid-typing.
  - Worse, whatever was typing then delivered its characters to the title. In the e2e suite
    this silently renamed tasks ("Tag Test Task" → "Tag Test Taskmy-new-tag") roughly one run in
    three, and persisted the rename. The autofocus now skips whenever focus already sits on a
    control inside the panel, so the panel still focuses the title on open but never takes focus
    away from a user.

  Covered by a new regression guard,
  `packages/ui/src/kanban/components/__tests__/DetailPanel.title-focus.test.tsx`.

  Also adds the stable test hooks the parent-links e2e spec was already written against but which
  did not exist: `data-role="task-card"`, `data-role="relation-group-rows"`, `data-role="detail-panel"`,
  `data-role="child-count"`, and `data-child-chip` on the card's child chip. Tag pills gain
  `data-testid="tag-pill"` / `data-tag="<tag>"`, because a text lookup for a tag is ambiguous — the
  same string appears in the pill, on the card, and inside the "task saved" toast.

  `vibeflow status` no longer exits 0 when it cannot reach the backend, and no longer reports
  "Could not reach backend" for the two cases that are not network failures (a revoked token,
  and a request that never had a board selected). A new `--json` flag emits the standard envelope
  for scripts. `status` is now classified as intentionally-unexposed MCP surface, since the flag
  has no MCP counterpart.

- de435d2: comment send button arrow now points up (message flows out of the composer) instead of left, matching modern send-button convention
- a894dde: fix(cli, ui): engine-written files carry an explicit system flag instead of name matching

  `TaskFileRef` / `FileInfo` / `FileEntry` gain an optional `system?: boolean`,
  stamped at write time: `saveFile()` accepts `{ system: true }`, and all
  engine writers pass it (verify evidence via `storeEvidence()` plus the
  page-diff back-fill, and both server baseline routes). User uploads (UI
  upload route, overlay paste, MCP `attachFile()`, `--report-file`) default
  to unflagged. The kanban `FilesList` groups by `f.system === true`, so the
  old `baseline-*.json` regex and the dead `{taskId}.png` matcher are gone,
  and the SYSTEM caption now states the timing accurately (baselines at
  annotation time, verify evidence re-captured on every run).

  Pre-flag boards migrate lazily: the existing `migrateLegacyLinkedRefs` hook
  (which already runs on every `saveFile`/`deleteFile`) backfills `system: true`
  onto the 11 known engine filenames — the single remaining place names are
  matched — and the existing `migrateAllLegacyLinkedRefs` sweep (now also run
  once at server startup) covers untouched tasks. The backfill is idempotent
  and never clears a flag.

- c7b7729: fix(ui): stop rendering a JSX source comment as visible text in the task detail panel

  Two lines of developer commentary sat as the first children of the fragment
  `DetailPanel` returns. Inside JSX, `//` is not a comment — an element's children
  are text — so both lines were painted as literal copy above the panel header.

  The note now sits above the `return` where it belongs, and a regression test
  asserts the panel renders no text node that looks like a source comment.

  The test scans the whole render output rather than `#detail-panel`: the leaked
  text renders as a sibling _before_ the `<aside>`, so a guard scoped to the panel
  passes with the bug still present.

- 8005e09: verification verdict is inlined with the task status in the details panel — quieter, more minimal, same tooltips

  The details panel no longer renders the verdict as a separate labelled
  "VERIFICATION" row above the tabs. The verdict now lives inside the status
  chip cluster as one quiet inline note — glyph plus a single word ("Verified"
  muted, "Verification failed" in the warning tone) — right-aligned at the
  row's right edge (`margin-left:auto` on the row, same flex parent) so the
  header reads as a single unit with the verdict hugging the right. The hover
  tooltip, aria-labels, `data-verify-state`, and the `#dp-verify-row`
  container (span first child) are unchanged.

- da59560: show the verification verdict in the activity feed, the task details, and on hover

  The panel's activity feed now flags the entries that carry a verification
  verdict: a status transition that carries the task's tri-state `verified` flag
  and lands in a verdict lane renders as `activity-verify--pass|--fail`, and the
  `**Cannot verify:**` system comment renders as `activity-verify--cannot` —
  each with a minimal left-border accent and a hover tooltip that says what the
  verdict means. Ordinary comments and verdict-less status changes stay plain
  (the lane gate stays single-sourced in `VerifyIndicator`).

  The detail panel header shows a `Verification` row with the shared
  `VerifyIndicator` glyph and label, and the glyph's hover tooltip now spells
  out who attested what ("the agent attested this task IS / is NOT implemented
  correctly") on the card, the child rows and the details pane. The
  `Cannot verify` marker regex was also corrected to match the string the CLI
  actually writes (`**Cannot verify:**` — colon inside the bold), which the
  feed's special rendering never matched before.

## 0.3.4

### Patch Changes

- 11cc93f: Make "drop after this card" reachable again on the Kanban board.

  While a drag is active every childless card renders the dashed **Drop to add as
  first child** slot inside its `<article>`, and `classifyForDropIntent` measured
  that whole article. The article rect therefore included the slot, which pushed
  the 'after' band off the card and onto the slot itself: the bottom band began
  _below_ the card content, so aiming at the lower part of a hovered card always
  resolved to make-child. Measured on a real board, a card's article spanned
  250–334px with the 'after' band starting at y>302 — while the slot occupied
  305–329. There was no 'drop after' gesture to aim at; the only reachable
  outcomes were "before" (top band) and "make child".

  Classification now runs against the card's **content** rect — the article minus
  the drop slot — so the bands stay on the card: the top band, the centre
  make-child zone and the bottom 'after' band are all reachable, including on
  short cards. A cursor on the slot itself stays centre/make-child, which is what
  the slot is for. A drag with no slot rendered classifies exactly as before, and
  the make-child pill keeps its existing behaviour (only a cursor that has left
  the card pins to centre).

  Fixes the classification only — the slot still occupies layout while a drag is
  active, so cards below the drag source still shift down slightly. Covered by
  `classify-for-drop-intent.test.ts`, a `KanbanBoard.dnd` case that drives a real
  drop with the slot mounted, and a new `dnd-all-surfaces` "Surface 5" browser
  test that drags onto a card's bottom band and asserts a reorder (it linked a
  parent before this fix).

## 0.3.3

### Patch Changes

- Replace the `--verified` / `--verify-failed` / `--unset-verified` attestation flags with a single tri-state `--set-verify pass|fail|cannot` flag plus `--verify-reason` (required for `cannot`). BREAKING: the three old flags and `--skip-verify` are removed — callers must switch to `--set-verify`. Semantics: `pass` attests the task IS implemented correctly (verified=true, green badge, review allowed); `fail` attests it is NOT correct (verified=false, amber badge, review BLOCKED); `cannot` with `--verify-reason "<why>"` clears the verdict to absent (no badge) and records the reason in the task's activity so the detail panel shows it. Omitting a verdict on an annotated task at the review transition now blocks with an error naming all three options (`--set-verify pass|fail|cannot`).

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
