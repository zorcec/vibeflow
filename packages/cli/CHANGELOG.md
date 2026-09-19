# Changelog

## 0.16.0

### Minor Changes

- Replace the `--verified` / `--verify-failed` / `--unset-verified` attestation flags with a single tri-state `--set-verify pass|fail|cannot` flag plus `--verify-reason` (required for `cannot`). BREAKING: the three old flags and `--skip-verify` are removed — callers must switch to `--set-verify`. Semantics: `pass` attests the task IS implemented correctly (verified=true, green badge, review allowed); `fail` attests it is NOT correct (verified=false, amber badge, review BLOCKED); `cannot` with `--verify-reason "<why>"` clears the verdict to absent (no badge) and records the reason in the task's activity so the detail panel shows it. Omitting a verdict on an annotated task at the review transition now blocks with an error naming all three options (`--set-verify pass|fail|cannot`).

## 0.15.0

### Minor Changes

- be7ffc3: Theming support: pick from six curated themes — Dark, Light, High contrast, Rosé Pine Dawn, Dracula and Gruvbox Dark — in Settings → Theme, where each is a swatch chip with a live preview. Apply commits it, Cancel reverts. Built on design tokens, so every surface (board, cards, detail panel, modals) follows the theme.

  ### Highlights

  - Parent-child task linking and many related improvements in the UI!

- 9bd33ee: List and claim root tasks only, and return a root's children with it.

  `vibeflow tasks` now lists ROOT tasks only — a task with a parent is not shown as a peer, because it belongs to its parent, matching how the board renders it. A footer reports how many child tasks the query matched and names the flag that reveals them, so the count is never hidden silently. Pass `--children` to include them.

  `vibeflow tasks --next` now considers only root tasks whose own status is `todo`. It never claims a child: the root is the unit of work, and the result carries that root's children with their ids, titles and statuses so an agent can see what remains without a second call. `--get <id>` is unaffected and still resolves any task, child or root.

  The MCP tools follow the same rule: `list_tasks` returns roots only (set `children: true` to include them, and read `hiddenChildren` for how many were omitted), and `claim_next_task` never claims a child.

### Patch Changes

- be35afc: `verified` is now an agent attestation instead of a mechanical verdict. Until now `vibeflow verify` wrote the flag itself from two page facts — the annotated element still resolved and the page logged no NEW console errors — and nothing else. That cannot tell whether the task was accomplished, so a task asking for a green button could be shipped red and still come back `verified: true`. Verify now stops at evidence: it still produces the diff, the snapshot artifacts and the verdict, and it prints its `ok` signal clearly labelled as page-health evidence, but it no longer writes `verified` or decides anything.

  The agent decides, and attests when it moves the task to review: `tasks --edit <id> --set-status review --verified` records "I verified this and the task IS implemented correctly", while `--verify-failed` records the opposite verdict ("I verified this and it is NOT correct") instead of leaving the state unknown. `--verified` is required by the review gate for annotated tasks (those with a URL and a selector), the rest of the gates unchanged. `verified: false` can never reach review: the transition is rejected whether the agent attested the failure on this transition, attested it earlier, or carries it from before. A stored `true` no longer satisfies the gate either — an attestation must be carried by the transition that moves the task to review, so a stale or mechanically-written value cannot over-claim.

  Claiming a task still resets the flag to absent, and the tri-state keeps its meaning: `true` = verified, implemented correctly; `false` = verified, NOT implemented correctly; absent = nothing assessed yet. Passing the verdict flags with a claim records it explicitly, so an agent can park a task it verified as wrong. The generated agent instructions now say all of this in place of the old "verify the fix" line, which never mentioned that verify sets nothing or what it actually proves. The MCP `update_task` tool accepts the same `verified` boolean for parity; the human/UI PATCH path still cannot set or require the attestation.

- b1a21bb: Fix `--comment` being silently discarded outside a review transition.

  The comment was written only when `--set-status review` was also passed, so adding a note to a todo, backlog or in-progress task accepted the flag and then threw the text away. The CLI printed `comment: added` unconditionally and before the write resolved, so the loss was invisible.

  The comment is now written for any status, awaited, and reported only after the write succeeds — with a real error and a non-zero exit code on failure. `--comment` alone is also treated as an edit, so it no longer falls through to the help output.

- 1ec93d3: Scope the review auto-commit to the task's own file and attachments instead of committing the whole shared index.

  Concurrent agent lanes share one git index in one working tree, so the CLI's plain `git commit` committed whatever any lane had staged: a lane's screenshots and task JSON could land inside a different task's commit, and a foreign deletion was once swept into an unrelated commit. `git show <sha>` then lied about what a task changed. The auto-commit now commits only staged paths that belong to the task being recorded — its `.vibeflow/tasks/<date>/<id>.json` and files under `.vibeflow/tasks/files/<id>/` — and leaves any other lane's staged files untouched.

  When the task's own file is not staged the commit no longer runs, and the failure message now says the task WAS updated (its status and comment are already saved) and names the exact path to stage, rather than the old wording that implied nothing had been written.

- 2a98eb8: The CLI build now syncs every emitted chunk into `dist` and fails loudly if any is missing.

  `tsup`'s onSuccess hook copies the code-split chunks the packaged entry
  (`dist/index.js`) loads. That copy step was a hand-maintained regex allowlist, and
  forgetting to extend it when a new dynamic import was added shipped a broken package:
  `verify-attestation` was emitted but never synced, so every `vibeflow tasks --edit`
  crashed with `ERR_MODULE_NOT_FOUND`. The build succeeded and the unit suite stayed
  green, because the tests import from `src/`, not from `dist/`.

  The allowlist is replaced by a glob that copies every emitted `.js` module, and the
  build now asserts that every relative import in the packaged entry resolves on disk,
  so a broken `dist` can no longer be produced. A regression test
  (`tests/e2e/tsup-chunk-sync.test.ts`) asserts the same invariant against the built
  output.

- 9792296: Fix login test timeout caused by .vibeflow/tasks directory growth in repo root
- 385e4f9: Fix the kanban board's centre drop (make-child) on normal-height cards. The reorder bands above and below a card were clamped to a 32px minimum with no cap, so on any card 64px or shorter the two bands overlapped and consumed the whole card: every drop classified as top or bottom, and dropping on the centre of a card silently reordered instead of nesting the task as a child. The bands are now capped so a centre zone always remains, while edge drops near the top or bottom still reorder.
- 9d3d324: Kanban: a task opened from the In Progress, Review or Done lane is no longer left hidden behind the detail panel.

  The detail panel is an absolutely positioned overlay, so on a viewport narrower than board + panel it covers the card that was just clicked — and the board's own scroll range was too small to bring that card back (at 1440x900 it was 64px), leaving closing the panel as the only recovery. The board is now inset by the panel's live width while the panel is open, and the clicked card is scrolled into the visible band once, restoring the previous scroll position when the panel closes. Wide viewports where nothing is covered are unaffected.

- 1c7e9e4: Fix drag reachability: auto-scroll the board and lanes when a dragged card nears an edge.

  Dragging a task to a column or row that was off-screen was previously impossible — there was no edge auto-scroll, so a lane taller or wider than the viewport (the Done column is clipped at 1310px) could not be reached at all. Dragging now scrolls the board horizontally and the lane under the pointer vertically, with the speed ramping up as the pointer approaches the edge.

  The scroll zone is 60px with a maximum of 14px per frame. A pointer held outside the container counts as full penetration rather than stopping the scroll.

- 87748ad: Dragging a kanban card no longer aborts the moment it starts. The dragstart handler updated React state synchronously, and React flushes those updates inside the very dispatch Chromium uses to initiate the native drag — the resulting board re-render (child drop slots inserted into every childless card, column restyling) raced the drag-image capture and killed the session. The drag then ended a few pixels in with no `dragenter`, `dragover` or `drop`, so nothing could be reordered or moved and no request was ever sent. The drag source is now registered synchronously in refs and the drag session, and every rendering side effect (the drag highlight, hover intent, source state) is deferred by one macrotask, after the browser owns the drag. Reordering, cross-column moves, make-child and tree drags all behave as before.
- b1a21bb: Fix the empty leading gutter on unverified cards.

  In a lane where any card shows a verdict, every card reserved an 11px slot — including cards with no verdict, which rendered an empty box that looked like a badge that had failed to load.

  The space is still reserved, because a lane's titles must share one x-offset. It is now an invisible, non-semantic spacer rather than a mark box: `data-role="leading-slot"` exists only when a mark is actually painted.

- f8d6e67: Remove the empty gap before card titles.

  A card with no status mark rendered an empty slot, leaving a visible gap before
  its title — indistinguishable from a badge that had failed to load. This affected
  every card without a verdict in the review and done lanes, including all Research
  tasks, which can never carry one.

  A card that draws no mark now renders nothing at all: no box, and no reserved
  space. Titles in a lane with mixed marks no longer share one x-offset; that
  alignment guarantee is deliberately given up, because a gap that reads as a
  broken badge is worse than a ragged left edge.

- 2ffc278: Draw one status mark per kanban card. The card's leading slot was assembled inline in two places and the copies disagreed: the single-row card (the done lane and the compact view) chose one glyph, while the multi-row card appended a loader, a verify glyph and an unread dot. An in-progress card that was also verified painted up to three marks, and its title started 27px further right than the card below it; a verified review card showed the verdict plus the unread dot. Both layouts now draw the slot through one shared component that picks a single mark by a documented precedence — verify verdict, in-flight activity, done affordance, unread dot, lane dot — inside a fixed-width box, so every card in a lane starts its title at the same x. A verify verdict is also now shown only in the review and done lanes, on cards and on child rows; backlog / todo / in-progress keep their plain status glyph, which means the in-progress + verified pair (a loader beside a check) no longer renders anywhere. The verdict tooltips now state the correctness verdict — "Verified — implemented correctly" / "Failed verification — not implemented correctly" — instead of "Verification failed".
- 1c4374c: Show all three verify states on kanban cards. The only verify marker used to be a `✓ VERIFIED` chip gated on the `done` column, but verify runs before `review`, so a verified task sitting in review — the normal end state — showed nothing, and a FAILED verify looked exactly like one that never ran. A verify verdict now rides the leading icon slot on every card and child row: a check for passed, an alert for failed, and nothing when there is no verdict. It sits beside the in-progress loader instead of replacing it, so an in-progress task that is also verified reads correctly, and it names itself (`title`/`aria-label`: "Verified" / "Verification failed") so the state never relies on colour alone. The `done` chip is replaced by this glyph so a card never carries two markers for one fact.

  The persisted `verified` flag is now genuinely tri-state. Reading a task preserves an absent flag as `undefined` instead of collapsing it to `false`, and claiming a task (status → in-progress) clears the flag rather than writing `false`; `false` therefore uniquely means "the last verify failed" and `undefined` means "never verified". On a failed verify the CLI now ends with an explicit next step — "fix the issues above, then re-run: `vibeflow verify <task-id>`" — instead of stopping at the error.

- 26473be: The verification badge is no longer shown on Research tasks. The verdict gate was scoped to the review and done lanes but never looked at the task's type, so a Research task that carried a `verified` value rendered the amber "failed verification" glyph — a verdict about a UI change that Research tasks never make (they produce a findings report, not code). The gate is now one predicate, read by the cards and the child rows alike, that requires a verdict lane AND a type that can be verified: Research is excluded, and the stored values are left untouched (only their display stops). Every other type the store carries still shows its verdict — Enhancement, Feature and Chore, and the tasks with no type at all, which resolve to the generic Task everywhere else in the board.

  The leading status slot is no longer reserved in a lane that draws no mark. The slot's width was reserved unconditionally so that titles could not shift between cards of the same lane (the "3 marks / title moves 27px" fix), which left an empty 11px gutter before the title of any card with no mark — and an empty 12px one in the single-row (done and compact) layout, whose lane-dot fallback had a colour but no box and so rendered 0px wide. The reservation is now decided once per lane: a lane that draws at least one mark keeps reserving for all of its cards, so their titles stay aligned; a lane that draws none reserves nothing and its titles sit flush. The row layout's lane dot now has a real 7px box.

- 768cd00: MCP `update_task` can now clear the `verified` attestation, matching `tasks --edit --unset-verified`.

  Pass `verified: null` to remove the stored verdict and leave the task with no verdict at all — the honest state for a task that cannot be assessed on this surface. The field was previously `boolean`-only, so an MCP-based agent had no way to express "clear it": it could only leave a stale value or write `false`, and `false` is a completed verdict that the task IS implemented incorrectly, not "not assessed". `null` maps directly onto the tri-state's absent value and is distinct from `false`, which is still stored as a real failure verdict. Omitting the field continues to leave any stored verdict untouched. The tool description now spells out all three values, and the review gate treats `verified: null` as no attestation, so it can never satisfy the positive-attestation requirement.

- 3d413b7: `tasks --edit --report-file` now fails loudly instead of being silently ignored. Providing the flag on a task that is not a Research task exits with a usage error and leaves the task untouched, and using the flag without `--set-status review` exits with a usage error. Previously both invocations appeared to succeed: the report was neither uploaded nor deleted, yet the status change went through.
- 2d6699e: Research tasks can no longer carry a `verified` attestation.

  A Research task produces a report and has no annotated UI element to verify, so any
  `verified` value on it is meaningless — and under the tri-state semantics a stored
  `false` reads as "verified as NOT implemented correctly", an active lie. The value is
  now scrubbed on read (`normalizeTask`) and on write (`updateTask` / `writeTaskJson`),
  so it can never be observed or persisted whatever wrote it.

  The review gate no longer demands a verification attestation for a Research task, even
  when it has a URL and selector (the reproduced case: a Research task with
  `url` + `selector "#main"` had its review transition refused until `--skip-verify`).
  An attestation passed on a Research review transition is now refused loudly with
  `RESEARCH_VERIFY_NOT_ALLOWED` instead of being dropped silently. Task, Bug, Feature,
  and Enhancement tasks are unaffected.

- 6a1467e: The SaaS/online task contract now carries the `verified` tri-state instead of dropping it.

  `updateTaskSchema.patch` accepts `verified` as a nullable boolean — `true`/`false` are the agent's verdicts, `null` clears it back to absent, and omitting it leaves the stored value untouched. The CLI's online client (`SaasTask`, `updateSaasTask`) understands the same tri-state, so a local `--verified` / `--verify-failed` / `--unset-verified` is no longer lost on the way to or from the server: `vibeflow push` already ships the raw task JSON, and the server now round-trips the field unchanged. An absent verdict stays absent — it is never coerced to `false`, which would report a never-assessed task as failed verification.

- b7a71d5: Fix the "Require verify before review" description in Settings — it described the wrong mechanism and ran long.

  The copy said the CLI "enforces vibeflow verify before setting status to review". That is not what happens: the gate requires the agent's `--verified` **attestation** at the review transition. `vibeflow verify` only gathers evidence — it cannot decide whether the task was accomplished, and it does not set the flag. The description now names the attestation, keeps the scope (tasks with a URL and selector) and the reset behaviour (cleared when the task returns to in-progress), and is roughly a third shorter.

- be485d2: Cancel in the kanban Settings modal now undoes a theme changed on the Theme tab instead of leaving it applied. Selecting a theme applies a live preview only; Apply commits it, while Cancel, the X, Escape and the backdrop rewind both the applied theme and the stored preference to the value the modal opened with. The shared `SettingsModal` stays appearance-agnostic: its `appearance` slot may now be a render function that receives a per-open lifecycle handle, which is how the CLI's theme switcher takes part in Apply and Cancel. Choosing "System" reverts to whatever was stored before, including clearing the key again.
- 8d3fd54: Move the kanban theme picker into its own Settings tab and strip it back to a compact swatch grid. The shared `SettingsModal` now renders the `appearance` slot in a dedicated tab named by the surface (`appearanceTab`) instead of appending it to the bottom of the Board tab, so the modal stays appearance-agnostic and other consumers keep their two tabs. Each choice is now one chip — the registry preview swatch plus the theme name — with the per-option descriptions reduced to a native tooltip and the group hint moved to screen-reader-only text; keyboard navigation, focus visibility, radio semantics and the selected state (a check on the active chip) are unchanged.
- 237269f: Agent instructions now tell an agent to attempt verification on **every** task, and give it a way to record that a task genuinely cannot be verified.

  Verification is no longer implied to be optional evidence. The instructions state that a UI task (one with a URL and a selector) must run `vibeflow verify <id>` **and** be judged by the agent, because verify only proves the annotated element still resolves and that the page logged no NEW console errors — it cannot tell whether the ticket was accomplished. They name the real counterexamples that pass verify but are wrong (painting a button green when the ticket said red; fixing a different bug), and spell out how to verify a non-UI task by inspecting its artifact (for a rename, grep the old string and assert zero occurrences; for links, resolve every href and assert none 404; for a README, confirm every referenced file exists and ships in the package's `files` list; for a command reference, confirm each documented command exists in `--help`).

  An unverifiable task must not carry a stale or false verdict, so `verified` can now be cleared back to absent with `tasks --edit <id> --unset-verified`. Absence means "not assessed here" and the kanban renders no badge for it, whereas `--verify-failed` still means "verified as WRONG" and is rejected by the review gate. The three attestation flags are mutually exclusive; combining them fails loudly.

  Also fixes a silent no-op: `tasks --edit <id> --verified` (or `--verify-failed`) with no other edit used to fall through to the browse/help output and exit 0 without writing anything, because the edit guard omitted the attestation flags. The flags are now edits, so the attestation is written (or the clear performed) instead of silently discarded. The `dist/index.js` chunk sync now also copies the dynamically-imported `verify-attestation` chunk, which the CLI edit path loads at runtime.

- 6cbb1fa: Surface page-capture truncation in `vibeflow verify`. The page-wide capture stops at 1000 elements and records `truncated: true` on the snapshot, but nothing read that flag: the style summary hardcoded `truncated: false` and the flag never reached the result, so a page larger than the cap produced a diff over a silent subset while the agent was told nothing had been skipped — a false negative, the one failure mode that cannot be noticed. Verify now carries the snapshot's real value through to the result, the page diff and the structure queries, and prints a prominent warning in the same voice as its other warnings (`WARNING: capture truncated at 1000 elements — elements beyond the cap were NOT compared. "No change" results for those elements are unreliable.`) both in the CLI output and in the system comment it writes. The `style_query` and `html_query` tools report the flag and attach the same warning to their output. No change to what `verified` means: a truncated run still leaves the correctness verdict to the agent, it just can no longer be mistaken for a complete one.
- 2d60fc9: Fix the verify-before-review gate: it now looks for `baseline.json` in the real evidence directory (`.vibeflow/tasks/files/<task-id>`) instead of a hardcoded `.vibeflow/files/<task-id>` path that never held evidence. Unverified UI tasks are once again blocked from moving to review.
- 2e07af0: Fix page-wide verification capture: `vibeflow verify` now runs a self-contained page callback instead of passing helper functions across the Playwright boundary, so `verify-all-styles.json` (and the derived `verify-page-diff.json`) are written again and the page-wide style/HTML query tools work. Evidence-capture failures are now reported instead of being silently swallowed.
- 7182925: Fix the verify style diff: the annotation baseline and the verify-time capture now use the same `RELEVANT_STYLES` property set, and the diff compares only properties recorded on both sides. Previously verify captured every computed style (~476 in chromium) against a 62-property baseline, so a no-op page reported ~437 false `"" → value` changes and buried the real ones.

## 0.14.0

### Minor Changes

- e786873: Remove-link dialog: child-aware confirmation with move-up/delete-children radio options, server-side detach endpoint, and board-level wiring.
- ffcbd90: What's New modal surfaces an aggregated Highlights region from manually tagged `### Highlights` changeset subsections.

- 73a9ef0: Kanban delete dialog offers recursive delete: parent with children now shows keep / unlink / delete-whole-subtree options
- 52f63e2: Kanban card expand/collapse state is now persisted per user and restored across reloads; the unread indicator only shows for tasks you have not opened.

- 0f091ed: Parent task concept: tasks can now be linked hierarchically with parent-child relationships. Children group under their parent in the kanban board with a ⤷N chip that morphs to a chevron on hover. The expanded tree shows child rows with status dots, priority badges, and inline drag-and-drop for reparenting up to 8 levels deep. The detail panel has a Relations area listing children, parents and blocked tasks, with click-through navigation. Parent links survive workspace sync, and a link pointing at a task that is no longer present is flagged as an orphan rather than silently dropped. The delete dialog offers recursive subtree deletion, and the detach dialog allows unlinking children without deleting them.

- 1940099: Kanban task details panel lists every relation type: the Relations area now renders one group per non-empty relation type — CHILDREN as a recursive tree, plus PARENTS, BLOCKS and RELATED as flat rows with a hover Unlink action. `related` and `blocks` links were previously visible only as count chips. The card's in-card children tree is unchanged.
- 52d34dd: Fix kanban drag/order correctness. `tasks --add` and every other create surface now mint a unique, monotonic `sortKey` derived from the store maximum instead of the constant `0000000001000000` that every create collided on (the collision made a card dropped between two such cards jump past both). A new one-time maintenance command, `tasks --reindex-sort-keys` (honors `--dry-run` and `--json`, idempotent, order-preserving), heals the existing keyless and duplicate-key tasks by re-keying them in rendered order while leaving well-formed, store-unique keys untouched. The reindex writes only `sortKey`/`updated` through a byte-preserving path, so legacy fields (such as the singleton `commit`) are never dropped.
- 3c6915e: `vibeflow tasks --add --parent <task-id>` creates a task as a child of an existing task in one command. `--parent` accepts a full id or a unique prefix (resolved the same way `--get`/`--set-parent` resolve ids), writes the same `parent` link the `--edit --set-parent` path writes (`links: [{ taskId, type: "parent" }]`), and rejects a dangling target with the same wording. It is `--add`-only; without `--add` it prints a usage error. The MCP `create_task` tool and `POST /api/tasks` accept the same optional `parent`, and `--add --json` returns the new task with its `links` field. `--edit` keeps using `--set-parent` / `--no-parent` unchanged.

### Patch Changes

- 77f8c09: Fix task `author` attribution: `tasks --add` and status transitions now stamp the task-store git identity, so an agent-created or transitioned task shows the same author as a human-created one.
- 0b9ac7d: Cascade done status to descendants: when a parent task is moved to done, all children and grandchildren are also marked done. Server-side authoritative cascade in PATCH handler + client-side optimistic update in kanban drag-drop.
- 9cead5d: Server: accept legacy comment IDs in `isValidCommentId` (and the matching tRPC `commentIdSchema`). SaaS-era IDs (10–14 lowercase alphanumerics such as `mnrrhpi0f9mxv`) and hand-written `-`/`_` slugs (e.g. `fix-comment-1`) no longer 400 on comment PATCH/DELETE. Traversal and non-conforming IDs are still rejected.
- 70b9a4c: Kanban drag-and-drop: drag state is now released on every drop outcome, so a drop onto a child row or children zone can no longer leave the board stuck. The drop handler clears the drag context in a `finally` (a rejected/ignored drop counts too), the window-level `dragend` cleanup also strips leftover `dragging`/`dnd-*` classes from the DOM, tree child rows register their drag source before touching `dataTransfer` and clear their own drag marker on `dragend`, and a rejected reparent in the detail-panel relations tree releases the drag session instead of leaving it latched.
- Kanban card children toggle reworked: the child-count chip sits at the end of the card footer and morphs into a chevron on hover or focus, pointing up while the tree is expanded. The floating chevron at the card's bottom edge is gone. In-progress child rows show a small loading indicator in place of the tree chevron.
- 5574ca7: Kanban board drag & drop: reordering cards in a column now persists the intended order.

  - A column reorder uses the shared `computeReorder` plan, but only the dragged card's `sortKey` was written back — the plan's normalization patches (which assign real keys to keyless siblings) were applied to local state only. Since a task without a `sortKey` always sorts after every keyed task, the dragged card jumped to the top of the column on the next load, so the drop silently did nothing. The reorder now persists the dragged card plus every normalization patch, and a partial failure self-heals by reloading.
  - The same normalization is now applied when a card is dragged out of a parent onto a column background, so it lands at the bottom of a mostly-keyless column instead of jumping above it.

- dfa209b: fix(kanban): anchor a no-neighbour drop to the store max, not the initial constant

  A drag that had no neighbour in its target column — a parented task dropped on
  an empty column, or a task reordered when it is its parent's only child — called
  `computeReorder` with no before/after key. That fell through to
  `generateSortKeyBetween(null, null)`, the store's initial constant
  `0000000001000000`, which another task already owned (`fd1ddc21`), minting a
  cross-column duplicate and pinning the dropped card to the top of its column.

  `computeReorder` now accepts the store's highest key as an append anchor, used
  only when both neighbours are absent; the card, column and tree drop paths pass
  it (`maxSortKey` over the loaded tasks). An empty store still mints the initial
  key, as before. Adds `maxSortKey` to the shared kanban utils and regression
  tests for the empty-column, only-child and mixed-width-fractional cases.

- 830ae8a: Kanban task-details Relations area: PARENTS / BLOCKS / RELATED rows are draggable again.

  `RecursiveChildrenTree` wired a row's drag source through the same `dndActive` flag that decides whether the tree accepts drop intents. The flat relation groups in the detail panel deliberately pass no drop intent, so their rows silently lost the drag source too: no `draggable`, no `dragSession` entry, and a drag started from them could never resolve a target. A rendered row always represents a task, so it is now always a drag source; drop-intent handling stays exclusive to the CHILDREN tree. Task `9cd3f4bb` was the only task in the store whose sole relation is `related`, so it was the one where every relation row was inert.

- 0eceae7: Kanban board: the children tree of a card now starts flush with the card's own content edge. The root level of the tree no longer pays a nesting step — only the levels below it do — so the collapsed tree sits noticeably tighter, while the 14px step between nested levels is unchanged. The detail panel's children tree keeps its root step so its rows stay aligned under the CHILDREN group label, and the depth-8 cap is unaffected.
- bcd5d87: **Kanban drag & drop fix.** Drag & drop could look completely dead on boards with parent-child tasks. The card and children-zone `dragover` handlers resolved the dragged task from the board's card ref alone, so a drag started from the detail-panel relations tree — the one source that registers through the `dragSession` singleton without writing the card ref — never produced a drop intent. The drop then silently fell back to a column status change (or nothing at all). Both handlers now use the same `dragSession.get()` fallback that `handleDrop` already used, and the children-zone handler is no longer gated on board-only `isDragging` state, so the zone stops swallowing the `dragover`.

  Reported as a shipped regression after the previous kanban drop-state release; covered by new `KanbanBoard.session-drag` tests.

- 3a4ba1b: Kanban tree drag & drop reliability: sibling reordering now persists the intended order, and a child nested under another child can be dragged back to the root parent.

  - Reordering siblings computed a `sortKey` around neighbours that had never been reordered, but only the dragged task's key was written. Sibling order falls back to timestamps when a task has no `sortKey`, so the drag appeared to do nothing (or landed in the wrong slot). The reorder/reparent drop now uses the shared `computeTreeReorder` plan and persists its normalization patches too.
  - Dropping an already-parented task on a card centre or a card's children zone was rejected by the single-parent rule, so a grandchild could not be moved back to its root/ancestor parent. Those drops now reparent the task instead of doing nothing.

- Kanban visual polish: columns now highlight clearly on drag-over with the column's accent colour instead of a faint dashed outline, and the children tree renders as an unbroken spine across nested subtrees with aligned status badges.
- 072790d: Add unused-symbol detection and remove dead code.

  Internal only — no runtime behaviour change. The repo previously had no ESLint, so `tsc --noEmit` never flagged unused imports/locals. A single `@typescript-eslint/no-unused-vars` rule now gates unused symbols for `pnpm lint`, unused symbols in the CLI and prototyping sources were removed, and three unreferenced UI files (`Board.tsx`, `TaskCard.tsx`, `TaskList.tsx`) were deleted.

- 7309f08: MCP `update_task` now accepts a `links` array, so an agent can set, replace, or clear a task's parent/relates/blocks links. The field was missing from the tool's input schema, so Zod silently dropped it and `update_task` reported success while the link was never written. The array replaces the task's full link set (pass `[]` to clear), and each entry is validated against the post-replace state with the same self-link, dangling-target, duplicate and cycle checks the `--set-parent` path uses.
- e119486: Move DeleteConfirmDialog to shared @vibeflow-tools/ui/kanban package so both CLI and web use the same radio-list delete confirmation component. Web app re-exports from shared (deletes stale local copy).
- f97ab8d: Task details: the parent relation type label is now plain "Child of" instead of "Child of →". The trailing arrow was redundant next to the target row and read as a stray glyph in the add-link type picker.
- a279c33: Fix a stale `.sortkey-ceiling` sidecar: after `--reindex-sort-keys` (which deletes the sidecar) the next `updateTask` re-seeded the monotonic ceiling from the single task it had just written. When that task did not sort last, the following `tasks --add` minted `thatKey + gap` and landed mid-store instead of appending. `updateTask` now rescans for the true store max via `maxStoreSortKey` when the cache is absent, matching the create path.
- 3e169ab: Auto-assign a `sortKey` when a task is created without one, so tasks created via the CLI, MCP or HTTP API always carry a well-formed column ordering key.
- beb7472: Add `--set-parent <task-id>` and `--no-parent` options to `tasks --edit` for setting, replacing, or clearing a task's parent link (validated: parent must exist, no self-parenting, no cycles).
- 6ec23aa: Rename "Remove" to "Unlink" in task details — unlink only removes parent link (never deletes). Delete children only via the Delete dialog (2 modes: roots / recursive).

## 0.13.0

### Minor Changes

- 7437017: Expand watch notifications + output modes

  - New event types: status, comment, file, priority, description changes
  - New output modes: --json (JSONL stdout), --output <file> (append to file), --webhook <url> (POST events)
  - New --once mode: one-shot poll with gap detection (>1 min old events trigger gap event)
  - State: .vibeflow/watch-state.json (append-only journal, per-consumer cursors, 1-min cap)
  - New modules: watch-events.ts, watch-state.ts, watch-sinks.ts
  - All existing new/moved-to-todo semantics preserved for backward compat

### Patch Changes

- Kanban and overlay annotate task now has Advanced collapsible area where label and priority can be set

## 0.12.1

### Patch Changes

- 6881de6: Fix verify gate: skip enforcement when no baseline.json exists

  Auto-created log-cluster tasks have selector+url but no baseline screenshot. The verify gate now checks baseline.json existence before blocking review.

## 0.12.0

### Minor Changes

> ⚠️ The `MCP server` is experimental and may change without notice.

- 405b3f8: MCP server: streamable HTTP endpoint at `/api/mcp` exposing 10 task tools (list_tasks, get_task, create_task, update_task, claim_next_task, add_comment, attach_file, export_prompt, verify_task, push_tasks). Manifest-driven — new CLI commands are auto-discovered. Auth: loopback-only locally, Bearer token for SaaS. Session management with 30-min TTL.
- 148cd3c: Kanban: new Compact view mode (Board | Compact | List). Compact shows one-line rows across all lanes — no tags, no comment/file counts. Done lane fits cards to screen height with "+N more" indicator. Overlay: add-task dialog now has an Advanced section with tag chips and priority selector.
- c57b423: Verify gate: optional enforcement in Settings > Enforcement. When ON, agents must run `vibeflow verify` before setting status to review. Auto-skips for non-UI tasks. `--skip-verify` flag available as bypass.

### Patch Changes

- ef67d56: Comment edits now broadcast to live UI. File uploads reject reserved filenames (.env, .git\*, .linked.json). Task schema limits enforced (titles 500 chars, descriptions 10K, URLs 2K).
- 7f96921: File upload validation hardened: rejects filenames with leading dots, enforces max length (255 chars), and validates extensions against an allowlist. 24 new tests.
- 074e376: Concurrent task writes now safely serialized via cross-process lock. GET endpoints are side-effect-free. Unified priority sorting across CLI and API.
- 16112b3: Atomic task claim: `--next` now re-checks status inside a lock, preventing double-claims under concurrent access.
- 803ca05: Review gate shared between CLI and REST. PATCH route now filters unexpected fields. Comment and verify requirements enforced.
- cf9dc82: Push dry-run mode, orphan task cleanup, verify cancellation via AbortSignal, serve deduplication.
- 1c3385d: Schema validation now enforces max lengths on task titles, descriptions, URLs, and selectors. Oversized fields are rejected with a clear error instead of being silently stored.
- 405b3f8: Fix file count badge display and changelog button styling in the kanban UI.

## 0.11.0

### Minor Changes

- abbda12: feat(cli): startup banner always shows a localhost URL alongside the LAN IP

  When the server is bound to 0.0.0.0, every user-facing URL in the serve and
  kanban startup banners (Kanban board, Task API, /inject guide, overlay script
  tag, File lines, "Kanban board ready") now prints an aligned localhost
  continuation line. Fixes kanban "request timeouts" when the displayed LAN IP
  is unreachable from the local browser. Output is unchanged when bound to a
  single host.

- 76d664c: feat(verify): page-wide baseline capture and diff

  > ⚠️ The `verify` command is experimental and may change without notice.

  - Capture page-wide baseline at annotation time, store as baseline-page.json
  - Remove baseline from task.json (too large), use file reference instead
  - Enable page-wide diff at verify time (verify-page-diff.json)
  - Add html_query tool for structural HTML changes
  - Back-fill baseline values in verify-all-styles.json for accurate diffs

- c3c3fd7: Show the changelog after updates and add a `vibeflow changelog` command.

  - The update notice in `vibeflow kanban` now prints the newest CHANGELOG section below it; suppress with `--no-changelog`.
  - New `vibeflow changelog [--all]` command prints the latest (or full) changelog to the terminal.
  - Kanban board shows a one-time "What's New" modal after a CLI update and a header **Changelog** button to browse the full changelog at any time.

- adac672: feat(verify): page-wide query system with progressive exploration

  > ⚠️ The `verify` command is experimental and may change without notice.

  Adds page-wide element capture and query tools for agents to explore verify evidence:

  - `vibeflow verify style_diff <id>` — summary of all style changes across the page
  - `vibeflow verify style_query <id> <prop>` — ALL elements where a property changed
  - `vibeflow verify html_query <id> children|text|attributes` — structural changes
  - `vibeflow verify element_info <id>` — element details

  Captures `verify-all-styles.json` with element tree, styles, and structure for every element with classes or data-attributes.

### Patch Changes

- 5881018: Add verified property to tasks with green VERIFIED badge in kanban UI.
- 857d597: feat(verify): add agent evidence tools for targeted style/HTML queries

  > ⚠️ The `verify` command is experimental and may change without notice.

  Adds four new CLI tools that agents can call to explore verify evidence
  without reading all files (~34K tokens → ~7K tokens):

  - `vibeflow verify style_query <task-id> <property>` — query specific CSS property
  - `vibeflow verify style_diff <task-id> [--filter <pattern>]` — get changed properties
  - `vibeflow verify element_info <task-id>` — get element details
  - `vibeflow verify html_diff <task-id>` — get HTML changes

  Also adds tool hints in verify output so agents know what's available.

- d0eceb5: fix(kanban): add vertical scrollbar to lanes except Done

  Lanes now have `overflow-y: auto` so tasks are scrollable when they exceed the viewport height. The Done lane keeps `overflow-y: hidden` since it already limits visible cards to 20.

- fix(kanban): What's New changelog modal scrollbar not working

  The full changelog view (8000+ pixels of content) overflowed the modal without a scrollbar because the scrollable child wasn't constrained by the modal's maxHeight. Fixed by making modal-box a flex column container so children shrink within bounds.

- 9085faf: Add Playwright page HTML, screenshot, and element HTML to verify evidence artifacts.

  > ⚠️ The `verify` command is experimental and may change without notice.

- fix(cli): security hardening — XSS, SSRF, open redirects, config crash protection

  - Sanitize all user data in kanban-template.html with `esc()` and `safeHttpUrl()` helpers; replace `innerHTML=''` clears with `replaceChildren()`
  - Add same-origin guard on kanban file preview to prevent open redirects
  - Validate outbound URL scheme (http/https only) in SaaS client to prevent SSRF
  - Wrap config JSON.parse in try/catch to prevent CLI crash on corrupted config
  - Add SAFETY comments on verified-safe innerHTML usages (renderMarkdown, SVG namespaces)

- 3405e3b: Improve verify command output: show evidence file paths and agent instructions instead of generic "Verification passed". Add verify step to agent workflow instructions.

  > ⚠️ The `verify` command is experimental and may change without notice.

## 0.10.0

### Minor Changes

- 2929354: Add a `vibeflow watch` command that watches the local task store and prints full ticket details whenever a task is newly created or moved back to `todo`.

  Also includes several hardening and consistency fixes:

  - tRPC task-ID inputs now enforce the 30-char hex shape, matching the REST API's `isValidTaskId` guard and blocking path-traversal IDs in file/comment endpoints.
  - `tasks --edit` now resolves a unique partial task-ID prefix to the full ID, consistent with `--get` and `--commit`.
  - The login push preview now handles legacy flat `.json` task files in addition to date-based subdirectories.

- 98ea6a6: Remove the experimental agent-run feature and its supporting packages.

  - Delete the `opencode-telegram-bridge` package.
  - Remove the agent-run API endpoints (`/api/agent/run`, `/api/agent/stop`, `/api/agent/agents`, `/api/agent/models`) and the `models` tRPC procedure from the CLI server.
  - Remove the Agent tab, model/agent pickers, agent queue panel, and multi-select (long-press) mode from the kanban UI.
  - Remove agent/model-related settings keys (`defaultModel`, `perTypeModels`, `defaultModelBug/Research/Task`, `defaultAgent`, `experimentalAgents`).
  - Remove `AgentStatus`/`AgentRun` types and the `getModels`/`getAgents` API methods from `@vibeflow-tools/ui`.

### Patch Changes

- c4b85d4: Add next_actions hints to mutation command JSON output

  - `tasks --add`: returns next_actions with hints to set status and add description
  - `tasks --next`: returns next_actions with implementation workflow hints
  - `tasks --edit --set-status`: returns context-appropriate next_actions
  - `tasks --commit`: returns next_actions to set review status

  Human-readable output shows concise → Next: hint lines.

- 7c49b56: Add semantic exit codes to the CLI. Instead of always exiting with code 1, the CLI now uses purpose-specific codes: 2 for usage/argument errors, 3 for not-found, 4 for auth failures, and 5 for conflicts. Exit code 1 is reserved for general/unexpected errors.
- b03bdc7: Add --dry-run, --fields, and structured JSON error output for agent-friendly CLI
- 9b600ac: Fix the file-upload endpoint documented in `vibeflow --help` and used by the legacy kanban template: the correct route is `POST /api/tasks/<id>/files/<filename>` (path segment), not `?filename=` (query parameter).

  Also document the `vibeflow watch` command and `vibeflow tasks --next` in the CLI help quick reference and README.

- 4a2d8c0: Harden REST API input validation for comments and file uploads to match tRPC validation: add `isValidCommentId` (16-char hex) for all comment endpoints, `isValidFilename` rejecting traversal/control chars for file endpoints, and whitespace-only rejection on comment text.
- d402441: Harden watch command error handling and tRPC input validation

## 0.9.1

### Patch Changes

- 141638a: fix(cli): align tRPC/REST semantics, add router tests, and harden agent API

  - tRPC `tasks` and `searchTasks` now count only non-deleted comments and read file counts from task metadata instead of the filesystem.
  - tRPC `updateTask` now accepts `tags`, `sortKey`, and `branchName` like the REST endpoint.
  - Removed an unused `pageScope` parameter from tRPC `searchTasks`.
  - Kanban multi-select agent runs now use the task/model or configured default model instead of a hardcoded value.
  - WebSocket task upserts now filter deleted comments when computing `commentCount`.
  - Added unit tests for the tRPC router and API validation helpers.
  - Validated task IDs, model names, and agent names in the agent run/stop APIs to prevent option injection.
  - Increased Vitest timeouts to keep the pre-commit suite stable under load.

## 0.9.0

### Minor Changes

- 4dc1975: Add "🎨 Prototyping" option to the overlay page-level right-click context menu when `@vibeflow-tools/prototyping` is installed. Clicking the option opens the variant switcher panel via the `__vf_prototyping` API.

### Patch Changes

- 3e4b441: Add "Hide Vibeflow" and "Disable Vibeflow" to the page-level right-click context menu.

  - "Hide Vibeflow" now appears in the page context menu when the badge is visible (mirrors the badge's own context menu)
  - "Disable Vibeflow" completely removes all overlay activity for the current page session (resets on page refresh)

- ba09800: Cancel multiselect mode when a task is dragged on the Kanban board.
- f4cf385: Add "Disable Vibeflow" option to the corner trigger right-click menu.

  The bottom-right Vibeflow icon button's context menu now shows both "Hide Vibeflow" and "Disable Vibeflow", matching the options already available in the page-level right-click menu. Clicking "Disable Vibeflow" removes the overlay completely for the current session (resets on page refresh).

- a1c2b76: Fix overlay button (corner trigger) not visible on fresh injection after "Hide Vibeflow" was previously used. The hidden state now resets on every fresh page load / bookmarklet injection so the button always appears when the overlay is first mounted.
- 8db8f88: Fix overlay corner trigger rendering off-screen when a position saved on a larger monitor is restored from localStorage. The saved coordinates are now clamped to the current viewport bounds on load, so the button is always visible regardless of screen size changes.
- e015fdc: Improve agent instructions: add --next auto-claim, blocked task escape hatch, structured bug format, and richer research task guidance.
- 38c3da6: Normalize literal `\n`, `\t`, `\r` escape sequences in task titles and descriptions at creation time. This fixes agent-created tasks that pass descriptions via CLI args (e.g. `--description "Line 1\nLine 2"`) which previously stored literal backslash-n instead of real newlines.
- 4e191ff: feat: add Show Vibeflow option to page context menu when badge is hidden

  When the Vibeflow badge is hidden via the corner trigger's right-click menu,
  it was previously impossible to restore it. Now, right-clicking any page element
  shows a "Show Vibeflow" option in the context menu, allowing users to bring the
  badge back.

  The hidden state is also persisted to localStorage so it survives page reloads.

- 4bbe370: fix: silence opencode stderr when not installed

  Add `stdio: "pipe"` to all `execSync` calls for opencode commands in
  `server.ts` and `trpc.ts`. Without this option, the OS "command not found"
  error was written to the terminal each time the Kanban board started and
  fetched models/agents — even though the errors were caught and handled.
  Users who don't have opencode installed should see no output about it.

## 0.8.1

### Patch Changes

- c917033: Increase kanban multi-select long-press timeout to 750ms with drag cancellation

## 0.8.0

### Minor Changes

- 9916d73: Replace select button with long-press multiselect and change default task limit

  - Removed the "Select" button from the kanban header
  - Multiselect is now activated by long-pressing (300ms) any task card
  - Pressing ESC exits select mode
  - A minimalistic indicator (pulsing dot + count) shows when in select mode
  - Changed default task list limit from 20 to 5

## 0.7.0

### Minor Changes

- 8065d50: Use default agent from settings in the agent picker dropdown, pre-selecting the configured default agent when opening the Agent tab.
- 8065d50: Persist overlay burger icon position to localStorage so it appears at the last dragged position after page reload.

### Patch Changes

- 2e7a840: Change CLI console log prefix from [Proto] to [Vibeflow]

  All console.log and console.error calls in the server now use
  `[Vibeflow]` as the prefix instead of the legacy `[Proto]` name.

- 8065d50: Fix kanban agent runs: dispatch webapp agent runs to local CLI server, show agent badge only when agent has actually run (commits exist), add optimistic agent run entry to prevent empty UI on agent start, and ensure board icon container has consistent dimensions for dual mode.
- 8065d50: Remove the agent badge from task cards, list view rows, and detail panel metadata. Agent status badges (running/queued/done) for active runs remain.
- 8065d50: Increase file preview modal max-width from 700px to 1100px for better readability of large screenshots and code previews.

## 0.6.1

### Patch Changes

- 52d796e: Add current git branch name display in kanban header, reorder workflow settings toggles, and fix agent instruction step numbering for createBranch workflow. Also add 'editing' state to collaborative editing event types.
- 52d796e: Improve CLI README with comprehensive command documentation, browser overlay injection methods, prototype writing guide, API reference, and agent integration details.

## 0.6.0

### Minor Changes

- Add agent queue side panel with button in header
- Fix agent run: use positional message instead of invalid --task flag, add agent picker, list agents/models endpoints, align Run Agent button right, sync model/agent live updates
- Implement real agent execution: Run Agent button now spawns opencode with task context via server endpoint. Output streams via WebSocket to the UI. Replaced simulated agent runs with actual opencode process spawning.

### Patch Changes

- Add agent session metadata display: capture tokens, cost, and duration from opencode JSON output and show in AgentTab footer.
- Add minimal agent badge to kanban task cards and detail panel.

  - TaskCard footer now shows a purple "Agent" pill with Bot icon when `task.agent` is set.
  - KanbanListView rows also display the agent badge inline with the title.
  - TaskDetailsTab metadata section includes an "Agent" tile when present.
  - All styles blend with existing badge sizing (font-size 10, compact padding, purple tint).

- Parse opencode JSON events into human-readable text in the agent streaming output.
- Auto-move task to in-progress status when agent run is started
- Auto-select default model in Agent tab so "Run Agent" works without user interaction.
- Add `experimentalAgents` feature flag to gate all agent-related UI features. When disabled (default), the agent tab, agent queue, agent status badges, "Run Agents" multi-select toolbar, and agent settings are hidden from the kanban UI. The flag can be toggled in Settings > Agent.
- Fix agent run: pass full task context, fix model picker dropdown clicks, and sync default model selection between UI and API request.
- Fix agent run: replace fake model IDs with real opencode models, add integration test with WebSocket event verification.
- Fix commit hash display in detail panel: show commit tile when commits array is present even if commit string is absent.
- Fix experimentalAgents flag to properly hide agent UI by default. Changed all gating conditions from `experimentalAgents !== false` (which evaluated to true when undefined) to `experimentalAgents === true`, ensuring agent features are hidden unless explicitly enabled.
- Fix model picker dropdown closing detail panel when selecting a model
- Two fixes for model pickers in the kanban UI:

  1. **CLI kanban now parses tRPC response correctly** — the `/trpc/models` endpoint returns `{ result: { data: { models: [...] } } }` but the CLI API client was expecting the inner shape directly. Now unwraps the tRPC envelope.

  2. **ModelPicker dropdown no longer clipped by modal** — replaced absolute positioning with a `createPortal` that renders the dropdown at `position: fixed` using measured button coordinates. The dropdown now expands upward above the button and escapes any parent overflow clipping.

- Fix sortKey not being accepted when creating tasks via POST /api/tasks, enabling multi-select drag-to-reorder to work correctly.
- Fix web tRPC models endpoint path: `/api/trpc/settings.models` not `/api/trpc/models`
- Move "Press Ctrl+C to stop" hint to the end of kanban startup output so it appears after the agent prompt block.
- Kanban web app now loads models dynamically from OpenCode CLI via tRPC `settings.models` endpoint
- Move agent action buttons from agent tab body to detail panel footer
- Fix multi-select drag to compute sort keys incrementally, preserving relative order of selected tasks.
- Add multi-select drag support: dragging a selected task in select mode moves all selected tasks together.
- Remove AgentQueueBar from kanban UI — the bottom queue bar is no longer shown.
- Settings modal Agent tab now uses the same searchable ModelPicker as the AgentTab task agent picker
- Share agent task formatting between CLI --get and server agent-run endpoint via new `renderTaskForAgent` function.
- Use default model from settings as initial selection in agent tab
- Use default model from settings in Agent tab when no model is explicitly chosen. Fixed state disconnect where "Run Agent" passed empty string instead of the displayed default model. CLI kanban now passes defaultModel to DetailPanel.

## 0.5.1

### Patch Changes

- de759ff: Include agent workflow instructions in agent run context. Previously, `vibeflow tasks --get` printed CLI instructions but the server agent-run endpoint did not include them in the prompt sent to opencode. Now both entry points share the same `renderAgentInstructions()` formatter, ensuring agents always receive workflow rules, settings flags, and critical constraints.
- defc6cf: Fix multi-select drag & drop to preserve relative order of selected tasks. Previously, all selected tasks were appended to the column bottom. Now they are inserted at the drop position with correct sort keys computed from the final arrangement. Added e2e Playwright test verifying the behavior.

## 0.5.0

### Minor Changes

- `tasks --next` now supports combining with `--type`, `--user`, and `--tag` filters to pick the next available todo task matching specific criteria.

### Patch Changes

- Fix detail panel content being clipped instead of scrollable: TaskDetailsTab wrapper now has `flex-shrink: 0` so long task content (large descriptions, screenshots, annotated element text) overflows the pane and triggers the scroll bar instead of being compressed invisibly. Also adds annotated element text display to the legacy HTML kanban template.
- Fix kanban drag-and-drop: tasks no longer jump to the top of a column after being dragged.
- Fix kanban board columns being unequal widths; all columns are now a fixed 280px.
- f88415f: Fix overlay API/kanban URLs pointing to wrong host when used as bookmarklet on non-CLI pages. Detect server origin from `document.currentScript.src` instead of `window.location.host`.
- fix: dragging a task to reorder now only updates the dragged task, not all others in the column

## 0.4.2

### Patch Changes

- Fix task file corruption when multiple processes write simultaneously.
- Fix potential HTML injection via malformed workspace ID.
- Fix soft-deleted comments being permanently lost when edited.
- Fix copilot auth failing silently on some systems.
- Fix logout not fully clearing workspace data.
- Reject invalid task status values instead of silently accepting.
- Fix push command reading tasks from wrong directory in some cases.
- Fix commit hash display showing wrong commits when multiple projects are open.
- Fix stale commit data persisting in task objects.
- Reject unknown settings keys to prevent accidental config corruption.
- Fix XSS vulnerability in markdown link rendering.
- Fix comment ID collisions when multiple users comment simultaneously.
- Fix CLI not running cleanup handlers on login errors.
- Faster task listing by computing counts from memory instead of disk.
- Fix copilot config file readable by other users on shared systems.
- Reject unsupported file types on upload.
- Block cross-origin mutation requests for security.
- Fix potential SSRF via malformed workspace URL.
- Fix screenshots accessible without authentication.
- Fix rate limiting bypass via spoofed X-Forwarded-For header.

## 0.4.1

### Patch Changes

- f88415f: Fix overlay API/kanban URLs pointing to wrong host when used as bookmarklet on non-CLI pages. Detect server origin from `document.currentScript.src` instead of `window.location.host`.

## 0.4.0

### Minor Changes

- a2f86f2: Replace manual version:patch/minor/major npm scripts with Changesets CLI (`@changesets/cli`) for versioning and changelog management. Agents now create `.changeset/*.md` files; the publish script runs `pnpm changeset version` to apply all pending changesets before publishing.
- 44b73b7: Enable tags in the new-task creation form: tags are now editable before saving (previously disabled). Draft tags are stored in panel state and included when the task is created. The task creation API endpoint now also accepts and persists `tags`.
- 360e8ba: Fix remote serving via `--host 0.0.0.0`: kanban browser code now uses `window.location.origin` and `window.location.host` for all API and WebSocket URLs instead of hardcoded `localhost`. CLI startup output now shows the LAN IP as the primary URL when `--host 0.0.0.0` is specified, with local URL shown as secondary.

### Patch Changes

- fe9c8fd: Document the `--next` workflow as the primary AI agent workflow: update kanban command prompt suggestion, CLI README step 3, and website hero/how-it-works section to show `tasks --next` instead of `tasks --status todo`.

All notable changes to `@vibeflow-tools/cli` are documented here.

Format follows [Conventional Commits](https://www.conventionalcommits.org/) → [SemVer](https://semver.org/).

---

## [0.3.2] - 2026-04-24

### Bug Fixes

- add comprehensive error handling to board creation endpoints (workspace.create, workspace.createWithBoard) with detailed logging of input, user ID, and root error cause
- improves debuggability when board creation fails due to database constraints or other issues

---

## [0.3.1] - 2026-04-24

### Bug Fixes

- improve error logging to capture comprehensive diagnostic details: extract full stack traces, error types, and file locations from any error-like value (Error, string, object, arbitrary values)
- GlobalErrorHandler now gracefully handles minimal errors (e.g., single-character messages) and supplements them with context (stack, line number, error name)

### Tests

- add 11 comprehensive unit tests for error extraction logic covering Error objects, strings, objects with message property, null/undefined, and edge cases

---

## [0.3.0] - 2026-04-24

### Features

- require `X-Overlay-Api-Key` header on `GET /api/overlay/tasks` — overlay GET endpoint is now authenticated (breaking: clients must include API key)
- overlay `fetchTasks` now sends `X-Overlay-Api-Key` header when `data-overlay-api-key` is set on the script tag

### Bug Fixes

- fix backspace key in header tag search not removing the last active filter tag
- fix `BETTER_AUTH_SECRET` empty-string bypass (`??` → `||` so empty string correctly falls back to `NEXTAUTH_SECRET`)

### Chores

- fix telemetry config path lazy evaluation — improves test isolation when `HOME` env is overridden

---

## [0.2.1] - 2026-04-24

### Bug Fixes

- fix telemetry config path to use lazy evaluation so tests correctly isolate `HOME` override

---

## [0.2.0] - 2026-04-24

### Features

- inline token search field with `#tag` picker — type `#` to open tag autocomplete dropdown; active tag chips appear as removable pills inside the search box (Proposals 1 + 3 combined)

---

## [0.1.2] - 2026-04-24

### Features

- add `--tag` filter to `tasks` command — filter tasks by one or more tags
- add `--next` flag to `tasks` command — select highest-priority next task automatically
- add `telemetry` command with `--enable`/`--disable`/`--status` options
- collect CLI usage telemetry via PostHog (EU cloud, opt-out, no PII)
- add `--host` flag to `serve` and `kanban` commands for LAN sharing (0.0.0.0 binds all interfaces)

### Bug Fixes

- fix tag sync in CLI kanban detail panel (tags were lost after WS round-trip)
- fix tag add failure (missing DB migration for tags column)

---

## [0.1.1] - 2026-04-10

### Features

- initial kanban board browser UI
- overlay script injection for HTML prototypes
- SaaS API integration (tasks sync, comments, files)

---

## [0.1.0] - 2026-04-01

### Features

- initial release: `serve`, `tasks`, `push`, `auth` commands
- HTML prototype annotation with overlay
- local task management via `.vibeflow/tasks/`
