# Changelog

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
