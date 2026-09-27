# Vibeflow

> **Tell your AI agent exactly what to fix — by clicking on it.**

Vibeflow eliminates the back-and-forth of describing UI bugs in words. Click any element on a page to create a task with its exact CSS selector, URL, and source location. Your agent gets precise, actionable context — no "the button in the top right" needed.

🌐 [Website](https://vibeflow.tools) · 📖 [Tutorial](https://vibeflow.tools/tutorial)

![Vibeflow kanban board — a task is dragged from Todo to In Progress](https://www.vibeflow.tools/assets/demo/showcase-hq.gif)

▶ **[Watch the full motion demo (MP4)](https://www.vibeflow.tools/assets/demo/showcase.mp4)**

---

## Why It Matters

AI agents write code fast, but **understanding what to change is slow**. Describing a UI issue in prose wastes tokens and produces wrong fixes.

Vibeflow turns visual feedback into structured tasks:

- **Click any element** → instant task with CSS selector, URL, and source file location
- **Track on a Kanban board** → see everything at a glance, drag between columns
- **Agents implement with context** → no guessing, no wrong elements, no wasted iterations

Perfect for small UI fixes, broken layouts, spacing issues, and anything where pointing is faster than explaining.

---

## Install

Run it once with `npx` — nothing to install:

```bash
npx @vibeflow-tools/cli kanban
```

Or install it globally for day two. This adds the short alias `vf`:

```bash
npm install -g @vibeflow-tools/cli
vibeflow kanban                  # or: vf kanban
```

**Requirements:** Node.js >= 22. Apache-2.0 licensed. No account and no cloud — every task is a JSON file in your repo.

---

## Quick Start

```bash
# 1. Start the local server and open the Kanban board
npx @vibeflow-tools/cli kanban

# 2. Annotate a running app: open http://localhost:3700/inject and drag the
#    bookmarklet onto your bookmarks bar (or use the script tag / console snippet)

# 3. Click elements in your app to create tasks — the CSS selector, URL and
#    source location are captured for you. You can also create tasks on the board.

# 4. Let your agent pick up the next task with full context
npx @vibeflow-tools/cli tasks --next
```

---

## See It in Action

![Vibeflow demo — drag a task to another column, expand a parent task into its children, then open the full ticket](https://www.vibeflow.tools/assets/demo/board-flow-hq.gif)

**Drag tasks across the board** — Backlog → Todo → In Progress → Review → Done. Drag a card to change its status and the
board persists the new column and order, even after a reload. Tag, user and type filters
keep their state while you move work, and every change is written straight to the task
store — so the CLI and your agent see it immediately.

**Break work into a parent / child tree** — Turn an epic into child tasks that keep their own status, priority and history. Expand
the tree inline on the card, or create children from the terminal with
`vibeflow tasks --add --title "..." --parent <id>`. The same hierarchy comes back from
`vibeflow tasks --get <id>`, so an agent can pick up a leaf without losing the parent.

**Get the whole ticket in one panel** — Open any card for the full ticket: status, description, tags, priority, author,
relations (children and related tasks), an activity feed and file attachments. Changes
save automatically, and pasting a screenshot or file anywhere in the panel attaches it
to the task instead of your Downloads folder.

---

## MCP Server

Vibeflow exposes its task tools over MCP, so an agent can read and update tickets
directly. Configure **one server per project**: a server resolves its project root once at
startup and every tool call uses that root, so it cannot write into the wrong project.

**stdio (recommended — no port, nothing to keep running):**

```json
{
  "mcpServers": {
    "vibeflow": {
      "command": "npx",
      "args": ["-y", "@vibeflow-tools/cli", "mcp", "--project", "/path/to/project"]
    }
  }
}
```

`--project` is required: a spawned client's working directory (often your home directory)
is never trusted, and the root is validated before anything is created. Put this config
_with_ the project — `.mcp.json` at the repo root, or your editor's workspace config using
`${workspaceFolder}`.

**HTTP (a server you keep running):**

```bash
vibeflow serve --project ./my-project    # MCP endpoint at /api/mcp
```

Loopback-only until you configure a token. Both transports mount the identical tool set;
only the transport differs.

Do **not** run one global server with a per-call project argument — that is deliberately
not supported. One process serves one root, resolved at startup.

---

## Related Packages

- [**@vibeflow-tools/prototyping**](https://www.npmjs.com/package/@vibeflow-tools/prototyping) — in-app variant switching for React with URL persistence. `npm install @vibeflow-tools/prototyping`
- [**Live kanban demo**](https://www.vibeflow.tools/) — try the vibeflow board in your browser.

---

## Commands

| Command | Description |
| --------- | ------------- |
| `vibeflow kanban [dir]` | Start the server and open the live Kanban board in your browser |
| `vibeflow serve [target]` | Serve HTML files with live annotation overlay, or run API-only task server for existing apps |
| `vibeflow tasks` | List, filter, create, edit, and comment on tasks |
| `vibeflow watch [dir]` | Watch the task store and print ticket details for important updates |
| `vibeflow mcp [--project <dir>]` | Run the MCP server over stdio (spawned by an MCP client) |
| `vibeflow telemetry` | Manage CLI usage telemetry (opt-out at any time) |

### `vibeflow kanban [dir]`

```bash
vibeflow kanban                   # open Kanban board for current directory
vibeflow kanban ./my-project      # open Kanban for a specific project
```

The Kanban board provides a visual task tracker with drag-and-drop columns, parent/child
task trees, agent status display, and file attachments. Create tasks directly on the
board or import them from annotated prototypes.

### `vibeflow serve [target]`

```bash
vibeflow serve .                  # serve all HTML files in current directory
vibeflow serve dashboard.html     # serve a single file
vibeflow serve -p 4000 .          # custom port
vibeflow serve --no-open .        # don't open browser automatically
vibeflow serve                    # API-only mode — connects to an existing hosted app
```

Serve HTML prototypes with the annotation overlay — click any element to create a task with its CSS selector, URL, and source location.

### `vibeflow tasks`

Full task management from the command line — designed to be agent-friendly.

```bash
# Pick the next task (auto-claims a todo task)
vibeflow tasks --next                             # picks highest-priority todo task
vibeflow tasks --next --type Bug                  # next bug task only

# List tasks
vibeflow tasks                                    # tasks (default: 5 most recent)
vibeflow tasks --limit 0                          # show all tasks (no limit)
vibeflow tasks --json                             # machine-readable JSON output

# Filter
vibeflow tasks --status todo                      # by status
vibeflow tasks --type Bug                         # by type (Task, Bug, Feature, Enhancement, Research)
vibeflow tasks --user dev@example.com             # by author email
vibeflow tasks --tag frontend --tag urgent        # by tags (AND matching)

# Get full details of a single task
vibeflow tasks --get <id>                         # supports partial ID prefix

# Create a task, or a child of an existing one
vibeflow tasks --add --title "Fix header" --description "Button overflows on mobile"
vibeflow tasks --add --title "Adjust the tour copy" --parent <id>

# Edit a task
vibeflow tasks --edit <id> --set-status in-progress
vibeflow tasks --edit <id> --title "Updated title" --description "More detail"

# Verification verdict (agent attestation — pass/fail/cannot, one only)
vibeflow tasks --edit <id> --set-verify pass                   # task IS implemented correctly (green badge)
vibeflow tasks --edit <id> --set-verify fail                   # task is NOT correct (amber badge; blocks review)
vibeflow tasks --edit <id> --set-verify cannot --verify-reason "<why>"  # unverifiable here (no badge; reason recorded)

# Mark as review (requires implementation report; annotated URL+selector tasks also need a verdict)
vibeflow tasks --edit <id> --set-status review --set-verify pass \
  --commit-message "fix: header layout" \
  --comment "Fixed the alignment issue by adjusting flex-wrap"
```

**JSON output (`--json`):** one envelope, one `ok` discriminant. Success writes `{ok:true, …payload}`
to **stdout** — `tasks` → `{ok:true, tasks:[…], hiddenChildren}`, `--get` → `{ok:true, task:{…}}`,
`--add`/`--edit`/`--next` → `{ok:true, task:{…}, next_actions:[…]}`. Failure writes
`{ok:false, error:{code, message, retryable, suggestion}}` to **stderr** and exits non-zero. **Every**
non-zero exit emits that envelope — a refusal that printed prose left a machine consumer with empty
stdout and no code. Under `--json`, stdout is **empty or exactly one JSON document** on every path,
with one deliberate exception:

- `tasks --next --json` on an **empty board** prints `No todo tasks found. Nothing to work on.` and
  exits 0. An empty board is not a failure, so this path never had an envelope, and three e2e tests
  pin that sentence and exit code on purpose. Guard for it explicitly. (The CLI/MCP divergence here
  — MCP's `claim_next_task` answers the same situation with `NO_TASKS_AVAILABLE` — is a filed ticket,
  not a documented difference.)

One code per meaning:

| code | meaning | retryable |
| --- | --- | --- |
| `E_USAGE` | a bad flag value, or an impossible flag combination (e.g. `--report-file` without `--set-status review`, `--edit` with no id and nothing to edit, `--parent` on the online board) | no |
| `TASK_NOT_FOUND` | the task or parent task does not exist (same code as the MCP tools) | no |
| `E_NOT_FOUND` | something else is missing, e.g. the `--report-file` path | no |
| `E_BACKEND_UNAVAILABLE` | a call to the online backend failed — `retryable: true` only when the host was unreachable | only when unreachable |
| `E_NOT_AUTHENTICATED` | no token, or the session was rejected (HTTP 401/403) — run `vibeflow login` | no |
| `E_COMMENT_SAVE` | the task was written but requested text was NOT saved: the `--comment`, **or** the `--verify-reason` of a `cannot` verdict | no |
| `GIT_COMMIT_FAILED` | in `error.code` nothing was committed; in `notices[].code` the task WAS written and only the commit did not happen | no |
| `REINDEX_WRITE_FAILED` | `--reindex-sort-keys` planned `sortKey` writes and wrote NONE — no task file was changed | no |
| `REVIEW_COMMENT_REQUIRED`, `COMMIT_MESSAGE_REQUIRED`, `BRANCH_REQUIRED`, `VERIFY_REQUIRED`, `VERIFY_FAILED_ATTESTED`, `VERIFY_REASON_REQUIRED`, `RESEARCH_REPORT_REQUIRED`, `RESEARCH_VERIFY_NOT_ALLOWED` | review-gate refusals (see `vibeflow tasks --edit --set-status review`) | no |

Codes are **scoped per command**, not global: `TASK_NOT_FOUND` on `tasks` means "no such task",
while `E_NOT_FOUND` on `tasks` means "no such FILE" (e.g. `--report-file`), and the two surfaces have
their own schemes. Read the code from the command you called.

A failure that happens **after** the task data is safely on disk is not a refusal: the run keeps
`ok:true` and exit code 0, and the success payload gains an optional **`notices` array** of
`{code, message}` — `GIT_COMMIT_FAILED` when the post-review auto-commit did not happen,
`REINDEX_INCOMPLETE` when the sortKey re-keying landed but its post-assert did not pass,
`SET_STATUS_DONE` / `RESEARCH_NO_IMPLEMENT` / `ALREADY_IN_PROGRESS` for the agent-policy and
conflict warnings. The array is always an array (never a bare object, never a plural `notices`/`warnings`
split) and the key is absent on a clean run.

`notices` is this CLI's own structured field. `warning` is a **different** field: the online board's
server-passthrough **string**, present only on the SaaS `--edit` payload. A consumer that branches on
one can never trip over the other's shape.

**Breaking as of 0.18.0:** `tasks --json` used to return a bare array, `--get --json` a flat object,
success payloads carried `success:true` instead of `ok:true`, and an auto-commit failure exited 1
even though the task had been written. The local notice field is `notices` (an array), not `warning`.

`vibeflow verify <id>` only collects page-health evidence (the element resolves, no new console errors); it does not set a verdict. The agent judges correctness and attests with `--set-verify` when it moves the task to review — `pass` (implemented correctly), `fail` (not correct — blocks review), or `cannot` with `--verify-reason` (unverifiable here, recorded in the task's activity).

**Task types:** Task · Bug · Feature · Enhancement · Research  
**Task statuses:** backlog → todo → in-progress → review → done  
**Priorities:** Critical · High · Medium · Low

### `vibeflow watch [dir]`

```bash
vibeflow watch                    # watch the current directory's task store
vibeflow watch ./my-project       # watch a specific project
vibeflow watch --json             # emit events as JSONL to stdout
vibeflow watch --once             # one-shot poll, then exit
```

Runs until interrupted (Ctrl+C) and prints full ticket details whenever a task is
newly created or moved back to `todo` — handy as a driver for AI-agent loops that
react to new work. Events can also be written to a file (`--output <file>`) or POSTed
to a webhook (`--webhook <url>`).

### `vibeflow telemetry`

```bash
vibeflow telemetry              # show current status
vibeflow telemetry --disable    # opt out of usage tracking
vibeflow telemetry --enable     # opt back in
```

No PII is ever collected. User identity is hashed.

---

## Browser Overlay

The overlay is a Shadow DOM panel injected into any page — HTML prototypes or live apps:

- **Click-to-annotate** — click any element to open a task form, pre-filled with CSS selector, URL, and source location
- **Task sidebar** — lists open tasks with status badges; click to jump to the annotated element
- **Task indicators** — numbered markers on annotated elements
- **Real-time sync** — over WebSocket with live file watching
- **Screenshot capture** — attach screenshots to tasks via the overlay
- **Dark theme** — polished dark UI, no configuration needed
- **Keyboard shortcut** — `Alt+A` to toggle annotation mode
- **CSP-safe injection** — bookmarklet bypasses `script-src` restrictions

### Injection Methods

The overlay can be injected into any page three ways:

| Method | Best for | CSP-safe |
| -------- | ---------- | ---------- |
| **Bookmarklet** (recommended) | Any page, including production apps | Yes |
| **Script tag** | Pages you control the HTML of | No |
| **DevTools console** | Quick one-off sessions | Yes |

Visit `/inject` on your running server for ready-to-use bookmarklets and snippets.

---

## How It Works

```
You browse your app  →  click to annotate  →  task created with context
          ↑                                         ↓
    browser reloads  ←  agent implements  ←  vibeflow tasks --next
```

1. **Overlay** — embed the bookmarklet or script into your app, click any element to annotate
2. **Kanban** — open the board to see all tasks at a glance, create new ones directly
3. **Tasks** — `vibeflow tasks --next` picks the highest-priority task with full context for your agent
4. **Iterate** — agent implements, browser reloads, annotate again

---

## Writing Prototypes

Each HTML file is one screen. Use Tailwind CSS, Lucide icons, and Google Fonts via CDN — the annotation contract tells your LLM to use exactly these libraries.

**Rules:**

- One file per screen — name after the route (`login.html`, `dashboard.html`)
- Every meaningful element gets a `data-vibeflow-id` — kebab-case, globally unique
- Navigate between pages with relative links: `<a href="./page.html">`
- Repeat navigation on every page (no shared includes)

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>App — Dashboard</title>
  <script src="https://cdn.tailwindcss.com"></script>
  <script src="https://unpkg.com/lucide@latest/dist/umd/lucide.min.js"></script>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>body { font-family: 'Inter', sans-serif; }</style>
</head>
<body class="bg-gray-50 text-gray-900 min-h-screen">
  <main data-vibeflow-id="main-content" class="max-w-4xl mx-auto px-6 py-8">
    <h1 data-vibeflow-id="page-title" class="text-2xl font-semibold">Dashboard</h1>
  </main>
  <script>lucide.createIcons();</script>
</body>
</html>
```

---

## Agent Integration

Vibeflow tasks are formatted for AI agents with full context:

- **CSS selectors** — exact element targeting, no guesswork
- **Source locations** — file, line, and column where the element is defined
- **Screenshots** — visual context attached to tasks
- **Comments** — threaded discussions on each task
- **File attachments** — research reports, specs, and reference materials
- **Git commits** — changes linked back to tasks via `[proto:task-id]` in commit messages

Agents can also run directly from the Kanban board via `POST /api/agent/run`, which spawns [opencode](https://github.com/opencode-ai/opencode) with full task context.

---

## API

A REST API and tRPC router are available at `http://localhost:3700` for integrations and the browser overlay. Key endpoints:

- `/kanban` — live Kanban board
- `GET/POST /api/tasks` — list and create tasks
- `GET/PATCH/DELETE /api/tasks/:id` — manage individual tasks
- `GET/POST /api/tasks/:id/comments` — task comments
- `GET/POST/DELETE /api/tasks/:id/files` — file attachments
- `POST /api/agent/run` — spawn an AI agent for a task
- `/inject` — overlay injection helper page

See [src/server/server.ts](https://github.com/zorcec/vibeflow/blob/main/packages/cli/src/server/server.ts) for the full API.

---

## Contributing

```bash
pnpm install          # install dependencies
pnpm build:cli        # build CLI
pnpm test             # unit tests
pnpm test:e2e         # end-to-end tests
pnpm test:coverage    # unit coverage only
pnpm test:coverage:e2e  # unit + e2e coverage MERGED (see below)
```

`test:coverage` reports what the in-process unit tests execute. That is not the whole
story for this package: `src/index.ts` is almost entirely command dispatch, and the
commands are exercised by the e2e suite, which spawns the CLI as a **child process** that
v8 coverage cannot follow — so `src/index.ts` sat at ~16% lines while hundreds of e2e
assertions ran through it. `test:coverage:e2e` fixes the measurement: it builds a
sourcemapped, unminified CLI into `.coverage-cli/` (the shipped bundle is minified and its
source maps are deleted, so it cannot be attributed back to `src/**`), runs the e2e suite
against it with `NODE_V8_COVERAGE`, converts and remaps the child counters, and merges them
with the unit counters **by source position** into `coverage/merged/` (text, json, lcov). It
prints the unit-only / e2e-only / merged numbers for `src/index.ts` on stdout. The merge
toolchain is already present as a transitive dependency of `@vitest/coverage-v8`; nothing
was added to `package.json`.

---

## License

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0) — see [NOTICE](https://github.com/zorcec/vibeflow/blob/main/NOTICE) for third-party attributions.
