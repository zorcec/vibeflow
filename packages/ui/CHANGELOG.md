# @vibeflow-tools/ui

## 0.5.1

### Patch Changes

- d0b8179: Board attribution no longer flips between "agent" and "user" for the same work. One shared rule (`resolveAttribution` + `AgentBadge`, exported from `@vibeflow-tools/ui/kanban`) renders the human behind the row with an agent badge when an agent surface wrote it, and every surface reads it: feed comments, change rows, the card assignee pill, and the details author tile. Agent comments now name the joined human instead of hiding them behind a bare marker; marker-only rows and unknown attribution render honestly with no invented name. Consumed unchanged by both boards (CLI kanban re-exports the same components), so the same record renders the same attribution online and in the CLI.

## 0.5.0

### Minor Changes

- 166d9d8: Task descriptions now have one length limit instead of three, and the limit is
  visible before it is hit.

  `TASK_DESCRIPTION_MAX = 20_000` is exported from `@vibeflow-tools/shared` and used
  by every schema that accepts a description. The overlay API previously capped at
  5,000 while the web form capped at 10,000 and Postgres (`text`) capped at nothing
  — so a description accepted by the form was silently refused by the bookmarklet,
  and anything over 10,000 produced a bare `400 Bad Request` with no field, no
  limit and no explanation.

  `MarkdownEditableField` gained an optional `charLimit`: it sets `maxLength` so an
  over-limit submit is impossible by typing or pasting, and renders a
  `N / limit` counter **only near the cap** (revealed in the last 2,000 characters,
  amber in the last 500). Fields without a cap, such as comments, are unchanged.

### Patch Changes

- 50ad9a1: Dragging a card near the edge of a wrapped board now autoscrolls vertically, so lanes below the fold are reachable mid-drag. Previously the scroll targeted the horizontal axis, which never overflows on wrapped boards, and the drag went nowhere.
- 590ea85: The board delete dialog now blocks Cancel while the delete request is in flight: Cancel is disabled, the confirm button shows progress, and Escape/backdrop are ignored. If the request fails, Cancel re-enables and the error is shown.
- b72c5bc: Board no longer scrolls horizontally: columns shrink to share the viewport down to a 200px readable floor, then wrap/stack instead of forcing a fixed-width strip. No horizontal scrollbar at 1280px or 390px.
- 23703c1: Kanban cards show the ticket's status as a colour dot with the status name on hover. The colour comes from the
  existing canonical status-colour mapping (design tokens, no new values); the name rides in the hover tooltip and
  in the dot's accessible name, and the tooltip is hover-only. No badge chip, no card redesign.
- 047a886: Kanban cards: a truncated card title now reveals its full text on hover in a width-limited, multi-line tooltip
  (max-width 240px, wraps, matching the existing popover tokens). Titles that fit get no tooltip; the tip appears
  only while the title is actually truncated and disappears on mouseleave.
- f88c4a7: Show an animated spinner on confirmation buttons while an action is pending.
- cfbf738: Done column counts come from one query: the Done header reads `Done - N` and the dotted bottom chip reads `showing X of N` from the same total. Shown (X) grows as more pages load while the total (N) stays put. Without the total, the legacy header renders as before.
- 8fa3a4e: Kanban cards show assignee initials instead of the full name, with the full name kept in the hover title. The pill renders for in-progress work only and clears when the item leaves the active lane.
- 17eaf81: Fixed the kanban board crashing with "Maximum update depth exceeded" when badge-overflow fitting failed to settle. The fit now measures a stable width and only re-runs when its inputs change; badge fitting behavior is unchanged.
- 316b4dc: SettingsModal opens on the Enforcement tab and lists it first. The workflow toggles are what the dialog is opened for; the reset effect now returns to the first tab instead of a hardcoded "board", so the strip and the pane cannot disagree.
- 030ced6: The kanban status dot's tooltip is hover-only: the dot is no longer keyboard-focusable, since no browser opens tooltips on keyboard focus and the extra tab stop had no behavior. Nothing is lost for keyboard or screen-reader users — the status name stays in the accessible name.
- 9f7ef07: Tag bulk-remove confirmation is now hard to trigger by accident: Enter no longer confirms from any focused control — only the confirm button (or focus outside buttons) confirms. Closing the dialog (Escape, Cancel, backdrop) is ignored while a removal is pending, so two removals can never be put in flight; the dialog stays on its spinner until the first call settles.
- 265908e: Activity feed names the actual tags added and removed (e.g. "added: bug, ui · removed: p1") instead of a generic "changed tags" row. The diff is recorded at the write path (`diffTaskFields` and the detail panel now carry the added/removed arrays, diffed from the real tag strings so comma-containing tags stay exact); rows recorded before this change derive the same diff from their stored from/to keys, so no old entry renders generic anymore. Field-change entries are in-session only — a board reload starts with no field rows, as before.
- 255fc26: Tags filter: per-tag "Remove" action on hover and keyboard focus with confirmation. The host wires `onRemoveTagFromAll`; without it no action renders.
- a1ac6fe: The board type filter offers exactly three canonical options: Bug, Task, Research. Tasks stored under legacy aliases (Feature and Enhancement) now appear under Task instead of being silently hidden. The CLI kanban board matches on the canonical type too.
- 7db5d1a: New reusable `ChatPanel`: messages, streaming tokens, tool-call cards, approval cards with Approve/Deny, image paste with previews, and degraded states (no assistant, no auth, unavailable, error). Presentational only — hosts drive it via props, so overlay, kanban, and web share one component.
- f3cc6d6: The board search box now propagates on a 150ms trailing debounce instead of re-rendering on every keystroke, while the input echo stays instant.
- e58ff36: Blend the detail-panel type picker into the title field and fix the card badge-overflow tooltip. The task-type picker is now an inline leading segment inside the title input's bounds (one shared border) instead of a detached widget. The badge-overflow chip shows an explicit `+N` count with a chevron instead of a bare `…`, and its tooltip anchors to the chip via the shared popover helper so it stays inside the viewport instead of clipping.
- 7320c92: Fix the detail-panel type picker opening invisibly inside the title field. The picker's menu rendered inside the `.dp-title-field` wrapper, whose `overflow: hidden` (the approved single-field look) clipped the menu to zero visible pixels — clicking the trigger resolved but showed nothing. The menu now portals to `document.body`, positioned with the shared `computePopoverPosition` helper (the same one the child popover and badge tooltip use), so it anchors to the trigger and stays inside the viewport. The wrapper keeps its overflow and the approved look; Escape closes just the menu, and picking a type no longer closes the panel.
- dfa9bc3: Activity feed: a save that moves a task into review (the verification stage) while attesting a verdict now reads as ONE event — the move row carries the Pass/Fail badge, and the companion "changed verify: none → verified" row is folded away instead of splitting the save in two. Standalone attestations (no status move), moves into lanes that draw no verdict, and verdict clears keep their own `verify` row, which is the only record of the verdict there. Rows recorded before this change render exactly as before. Field-change entries are in-session only — a board reload starts with no field rows, as before.

## 0.4.1

### Patch Changes

- 6948c41: The detail panel's activity feed no longer blinks on live updates: rows now carry content-stable keys, so an edited comment or a new message reconciles in place instead of remounting the whole list. New rows slide-fade in (~180ms), in-place text edits earn a brief highlight wash (~600ms), and both animations are skipped entirely under prefers-reduced-motion. Applies to every activity kind (comments, files, status changes, lifecycle entries).
- b353255: The kanban "Add Task" panel no longer waits for the `task.create` round-trip before closing. Clicking Add closes the panel immediately while the already-painted optimistic card stays visible on the board; files pasted during creation still upload in the background once the create resolves with the real id.
- bb60ecb: Card badges now always stay on a single line. Type, priority, assignee and tag pills render in one nowrap row that measures its own fit; once badges no longer fit, only those that fit show plus a "..." chip, and the rest stack one after another in a hover/focus/click tooltip. The chip's accessible name lists every hidden badge, and tooltips never cover the card's action buttons.
- 64a2020: Task cards no longer jump on hover. The `:hover` rule lifted the card 1px with `translateY(-1px)`; hover feedback is now border + background + shadow only, so the card's box is identical before and during hover (measured delta 0).
- 3125561: The child-row copy tab now sits flush at the row's very right edge and blends in: the inline wrapper's right padding is gone and the tab's rounded outer corner is squared off, so the revealed tab reads as part of the row instead of a floating pill. Popover rows keep their own rounding.
- c4de081: The child-row hover background now spans the full card width. The hover well is painted on the row wrapper, which used to sit inside the children zone's horizontal padding — so the highlight stopped ~10px/8px short of the card edges. The zone no longer pads horizontally; the inset moved onto the row wrapper, so the well bleeds edge to edge while the row content stays exactly where it was.
- a24a744: Hovering a parent card's subtask chip now opens the children preview next to the chip. Cards with many subtasks previously showed the preview pinned to the top of the viewport: the position estimate counted every subtask while only the first few rows render, so the popover flipped away from its anchor on a phantom height. The estimate now mirrors what actually renders (visible rows plus header, capped like the stylesheet), so the preview stays adjacent to the chip and inside the viewport.
- f7eddd5: The children hover preview now has breathing room on its left edge: popover rows render with the 10px left padding the stylesheet always intended, instead of the 2.5px tree-indent base that overrode it inline and pinned row text edge-flush. Tree and detail-panel rows are unchanged.
- 1de2ea7: Relation/child rows expose the child's status as `data-status` on the row root in every variant. The detail panel renders status as a coloured dot only (no badge), so live-update assertions and tooling read the status off the row instead of dot colour. No visual change.
- 88c32c5: Compact kanban cards no longer show the copy-ID button. The button stayed invisible until hover but still reserved its width, squeezing the title for no visible affordance — compact rows now end with the title and any file, subtask, or comment indicators. Full-size cards and done-lane rows are unchanged, and the ID can still be copied from the detail panel.
- 5ad7c17: Detail-pane activity feed logs every details-field save as one minimal row: description edits (including live-doc sessions), tags and relations now appear as name-only entries, while title, type, priority and verify keep the established from→to pills. Remote peer and agent/CLI writes arrive through the same shared differ, so they read exactly like local UI writes on both kanban boards.
- 0f9000f: The details ID tile aligns with the Created tile again. Its copy button carried the shared 22px minimum box, growing the ID value row past the Created row's text height — the id sat ~2px low and its underline ~6px below Created's. The detail pill is now capped to the 16px value line so both rows are text-driven and equal; the copy glyph still fits.
- f686d42: Detail-pane markdown editors no longer call the board API for the `#` mention index or task hover cards. Both now take caller-provided in-memory data (`mentionTasks` / `taskLookup`), which the detail panel threads from its task list — so opening a task no longer fires `GET /api/tasks` requests that 404 on hosts without that route. The legacy fetches remain only for callers with no task list (standalone file preview, remote board client).
- 3c16549: Detail-panel screenshot preview now follows the live files channel. A file add/remove while the panel sits on the details tab used to refresh only the files badge count, leaving the screenshot preview stale until the files tab was opened; the panel now reloads the files list on every file broadcast, on any tab.
- c9b7d15: Done lane fits its `+N more` overflow chip without clipping it. The fit count now reserves the chip's real height (44px) plus its flex gap and the scroll container's bottom padding (57px total) instead of 29px, so at short viewport heights the chip no longer sticks past the lane's hidden-overflow container and gets cut off. No drag, hover, or drop behaviour changed.
- 6b585a2: File add/remove activity rows now render a lucide action icon (Paperclip for additions, Trash2 for removals) instead of the stored emoji prefix. The icon is sized to the other activity glyphs and labelled for screen readers, and the human text renders intact minus the emoji. Stored trace text is unchanged, so existing boards and text assertions keep working.
- 89d6227: The card's top-right actions sit closer together: the advance chevron and the copy pill now share a tight 2px cluster instead of inheriting the title row's 5px rhythm, so the pair takes less of the title's width while the copy pill stays flush right. Both buttons keep their in-flow 22px boxes, so the card rect is still identical at rest and on hover.
- f37f37c: Kanban cards: the live-activity badge no longer prints the full user name (it pushed the comment/file/children actions out of view). It now shows initials in a small circle, reusing the detail panel's presence pattern and per-user hue; crowds collapse to a "+N" chip and the full roster lives in the hover tooltip. The badge cluster never wraps and truncates before the action buttons. Child rows carry the full title as a hover tooltip while the visible text stays ellipsis-truncated.
- 37e64f6: The card hover advance control now reaches Done: cards in Review show a "Move to Done" chevron that travels the same column-drop status path as every other lane (board `onDrop` → `patchTask` → `api.updateTask`), so lane guards apply unchanged. Done stays terminal and renders no control.
- 04253f5: Kanban column headers now count the children owned by the column's cards, regardless of the children's own status. A parent in Review with 3 children renders "Review · 1 ↳ 3"; a child whose parent sits in another column counts in the parent's column, never in its own status column.
- 8f7ed1a: Opening a task in the CLI kanban no longer fires a burst of files/comments requests (4 files + 3 comments fetches per open, all 304). `tasks-updated` broadcasts now name what changed (`comments` for comment add/edit/delete, `files`+`comments` for file add/remove which also writes a system trace, `task` for screenshot set/clear), the board refetches the open panel only for named parts with same-tick bursts coalesced to one round, and the detail panel loads with a single comments+files round instead of three badge rounds plus a duplicate files fetch. The kanban API client also stops JSON-parsing body-less (304/empty) responses, returning last-known data instead of throwing.
- 14da934: Restyle activity-feed verification entries to match the agent message rhythm: a header with the author, a glanceable Pass/Fail/Cannot-verify badge and the timestamp, plus a readable card for the detail text. Long cannot-verify reasons now wrap at a comfortable line-height instead of rendering as a dense single-row strip. No data shown changed and all existing variants keep working.
- dd14407: Peer cursors in the task description now sit on the text like real carets: the position marker measured the text baseline, so the caret hung a full line-height below the glyphs and its name flag landed on top of neighbouring text. The marker now measures the line-box top, the flag always hugs from above, and the overlay is split into a clipped mirror layer plus an unclipped caret layer (out-of-view carets are culled) so first-line flags float over the editor chrome instead of being cut off. Full names stay on hover title and screen-reader label.
- 30f3fab: Show a visible processing state the moment a screenshot is pasted: the Files pane renders a pending tile with the shared spinner until the stored attachment is listed, the Upload control disables while a batch is in flight so duplicates cannot stack up, and a failed upload (transform error, rejected upload, or an upload that resolves without the file appearing) lands in the visible upload-error box instead of failing silently. Create-task mode shows a "Processing pasted image…" pill until the paste is buffered, with transform failures surfaced the same way.
- ccd9720: Focus the new-task panel's title input on open. The description editor's mount autofocus used to win the race for initial focus (it fires before the title's deferred focus, which then backs off seeing focus already in-panel), so typing landed in the description instead of the title. The description now autofocuses only for existing tasks; the title focus also uses preventScroll to avoid focus-scroll jank.
- a4bdc35: Compact cards inline file/child/comment counts, presence chips go high-contrast right, file uploads leave a trace

  Compact view cards now show the nonzero file, subtask and comment counts inline with the title (opening the files tab, the task, and the activity tab respectively) instead of hiding them; done-column cards stay title-only. The detail panel's co-presence stack moved to the right edge of the status row and its chips use a darkened fill of the same per-person hue, so white initials clear WCAG AA on every hue (measured floor 5.02:1). Attaching a file now writes the same system activity entry removing one always wrote, and the open panel refreshes its activity and files without a reload. No behaviour changes otherwise: comment edits still leave no feed entry, and presence stays informational and never locks editing.

## 0.4.0

### Minor Changes

- 9387693: Attachments, relations and comments now update live for everyone

  The live board covers the rest of the task surface: a file, a relation or a comment added (or removed) in one session appears — or disappears — in every other session on that board without a reload. Comments stay append-only and are broadcast as they are written; nothing about how they are stored changes. This completes the live surface started with presence and the shared description.

- 698b213: The task description is now a live, shared document

  Two people can type in the same description at the same time without losing text: edits merge character by character (a CRDT document per task, synced over the existing realtime socket) and each session sees the other's cursors and selection. The document is seeded from the saved description and written back through the same board-scoped write path the rest of the board uses, so how the description is stored and read does not change. Cursors appear in the description only; elsewhere the quiet presence line already shows who is present and where.

### Patch Changes

- 97b57f6: Presence copy now agrees with the Activity tab

  The detail-panel presence line and the card activity badge render the comments area as "activity" ("Ana is in activity", "Ana editing · activity") to match the Activity tab and the activity feed. Internal identifiers are unchanged: tab keys, `PresenceArea` wire values, `data-testid`s and the comment data model still use "comments".

- 87c9fb2: The board no longer locks a task while someone else has it open

  Presence is per-task and says _which part_ of the task a person is in (description, comments, files, relations) — a quiet line in the detail panel plus a neutral suffix on the card. Editing is never blocked or disabled: the "🔒 Locked by … — editing disabled" banner, the lock guards and the "locked" activity state are gone. Discrete fields (status, priority, type, title) broadcast and apply for everyone instantly, with no reload.

- bdfda09: Co-presence moves into the status row as initials avatars

  The detail panel no longer spells out "Ana is in description · Ben is in activity" in a text line above the header. Peers now appear as a compact initials stack inlined with the STATUS row (avatar-stack pattern): each 20px chip shows initials in the peer's own colour (the same colour as their description cursor), the full "name is in area" sentence appears on hover and for screen readers, chips are keyboard-focusable, and crowds collapse to a "+N" chip that names everyone hidden.

- 484fc7e: Polished presence UI for live collaboration

  Remote cursor colours now come from a fixed 12-colour palette, so two people in the same description always get easily told-apart colours that stay the same for each person across sessions; the peer-name flag on each cursor keeps a text shadow so it stays readable on the lightest colours. The card activity badge shows a pencil while someone is typing and an eye while they are only viewing, matching the presence line's wording. The presence line in the task panel wraps instead of overflowing on narrow screens. No behaviour changes: presence stays informational and never locks editing.

- 1b12131: Collaborative caret flag shows initials instead of the full name

  The remote-caret name flag spelled out the peer's full name in a wide solid box that covered the line above the text. It now shows the peer's initials (the same helper as the presence chips) in a compact label that hugs the caret, keeping the per-user colour. The full name is still on hover and exposed to screen readers, and the 2px caret itself is unchanged.

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
