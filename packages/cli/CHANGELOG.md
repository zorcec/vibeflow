# Changelog

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

- 9cd0d82: Write task files atomically via a .tmp file and renameSync to prevent torn JSON reads during concurrent writes (BUG-09).
- 9cd0d82: Sanitize boardId before embedding in injected HTML/JS to prevent HTML injection via a malformed workspace ID (BUG-10).
- 9cd0d82: Fix addComment, updateComment, and deleteComment to read raw task data so soft-deleted comments are preserved instead of silently dropped (B1).
- 9cd0d82: Remove 2>/dev/null shell redirect from execSync calls in copilot-auth; it was passed as a literal argument without shell: true (BUG-04).
- 9cd0d82: Fix logout to also delete the stored workspace file so the CLI fully returns to local mode (BUG-03).
- 9cd0d82: Add status value validation to PATCH /api/tasks/:id to reject unknown status strings (BUG-05).
- 9cd0d82: Pass projectDir to promptPushLocalTasks so it reads tasks from the correct project root instead of process.cwd() (BUG-07).
- 9cd0d82: Key remoteCommitCache by projectDir to avoid cross-project SHA collisions when multiple projects are open (BUG-02).
- 9cd0d82: Remove undeclared commit field from normalizeTask to prevent stale data from persisting in normalized task objects (B2).
- 9cd0d82: Allowlist known keys in POST /api/settings to prevent writing arbitrary fields to the project settings file (BUG-08).
- 9cd0d82: Replace hardcoded .vibeflow/tasks path in task watcher with PROTO_DIR and TASKS_DIR constants (BUG-06).
- 9cd0d82: Escape double-quote characters in renderMarkdown to prevent XSS via attribute injection in link hrefs (BUG-01).
- 9cd0d82: Use cryptographically random bytes for comment IDs instead of Date.now() to avoid collisions under concurrent writes (I5).
- 9cd0d82: Replace process.exit(1) calls in login.ts with process.exitCode = 1; return to allow async cleanup handlers to run (I1).
- 9cd0d82: Remove unused slugify function from tasks.ts; no production code imports it (F11).
- 9cd0d82: Import PROTO_DIR constant from core/types in settings.ts instead of duplicating the hardcoded string (F13).
- 9cd0d82: Compute commentCount and fileCount from embedded task arrays instead of reading from disk in the /api/tasks response (P3).
- 9cd0d82: Write copilot config file with 0o600 permissions to prevent other users from reading the stored token (SEC-04).
- 9cd0d82: Add file extension allowlist to the CLI file upload endpoint to reject unsupported MIME types (SEC-09).
- 9cd0d82: Reject POST and DELETE mutation requests from cross-origin pages to prevent unauthorized agent-status and settings writes (SEC-02).
- 9cd0d82: Validate workspace URL against an allowlist of production domains before using it as the SaaS API base URL, preventing SSRF (SEC-08).
- 9cd0d82: Serve screenshots through a route handler that validates task ID format instead of an unauthenticated static directory (SEC-05).
- 9cd0d82: Only trust X-Forwarded-For header for rate limiting when TRUSTED_PROXY=1 env var is set, preventing IP spoofing (SEC-01).

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
