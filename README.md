# Vibeflow

> Annotate, iterate, and ship faster with your AI agent — from a single CLI command.

Vibeflow sits between your browser and your AI agent. Click any element to leave precise feedback, export it as a structured prompt, and let Copilot or Claude implement it. No copy-pasting, no context loss, no "what did you mean?" loops.

<!-- TODO: Add demo GIF (10–30s: annotate → export → agent implements → browser reloads) -->
<!-- Use LICEcap, Kap, or ttyrec to record. Target <3MB. -->

```bash
npm install -g @vibeflow-tools/cli
vibeflow serve
```

---

## Why Vibeflow

AI agents are fast at writing code, but slow at *understanding what you mean*. Vibeflow eliminates the translation step:

- **Click any element** → instant task with exact CSS selector, URL, and source location
- **Export** → one structured prompt with all the context your agent needs
- **Done** → agent implements it, Kanban task closes, browser reloads

No more describing layouts in prose. No more "the button in the top right."

---

## Features

### CLI

| Command | Description |
|---------|-------------|
| `vibeflow serve [target]` | Serve HTML files with live overlay, or run API-only task server |
| `vibeflow kanban [dir]` | Start the server and open the Kanban board in the browser |
| `vibeflow export <target>` | Export annotations/tasks as a structured LLM prompt |
| `vibeflow tasks` | List, filter, create, edit, and comment on tasks |
| `vibeflow login` | Authenticate CLI against the SaaS backend (device flow) |
| `vibeflow logout` | Remove stored auth token, switch to local mode |
| `vibeflow mode` | Show current operating mode (local or SaaS) |
| `vibeflow status` | Show login status, connection info, task statistics |
| `vibeflow push` | Push all local tasks to the SaaS app |

**Task management** (`vibeflow tasks`):
- Filter: `--status <status>` · `--type <type>` · `--user <email>`
- Create: `--add --title "..." --description "..."`
- Edit: `--edit <id> --set-status <status> --title "..." --description "..."`
- Comment: `--comment "..."` (required when marking review)
- Auto-commit on review: `--set-status review --commit-message "..." --comment "..."`
- Attach report files for Research tasks: `--report-file ./report.md`
- Full task details: `--get <id>`
- Machine-readable output: `--json`

**Task types**: Task · Bug · Research  
**Task statuses**: backlog → todo → in-progress → review → done

---

### Browser Overlay

The overlay is a shadow-DOM panel injected into any page (HTML prototypes or live apps):

- **Click-to-annotate** — click any element to open a task form, pre-filled with CSS selector, URL, and source location
- **Task sidebar** — lists open tasks with status badges; click to jump to annotated element
- **Task indicators** — numbered markers on annotated elements
- **Real-time sync** — over WebSocket (local) or polling (SaaS)
- **Error recording** — captures recent console errors into bug reports automatically
- **Dark theme** — polished dark UI, no configuration needed
- **Keyboard shortcut** — `Alt+A` to toggle annotation mode
- **CSP-safe injection** (SaaS mode) — bookmarklet bypasses `script-src` restrictions

**Injection methods**: `<script>` tag · bookmarklet · DevTools snippet

---

## Installation

```bash
npm install -g @vibeflow-tools/cli
```

Or run without installing:

```bash
npx @vibeflow-tools/cli serve
```

---

## Quick Start

```bash
# 1. Serve your project with annotation overlay (opens in browser)
vibeflow serve

# 2. Click elements in the browser to annotate them
# 3. Export annotations as a structured AI prompt
vibeflow export .

# 4. Paste into Copilot / Claude / any LLM and say "Implement all annotations"
```

---

## How It Works

```
LLM generates HTML  →  vibeflow serve  →  you annotate in browser
        ↑                                         ↓
  implements changes  ←  vibeflow export  ←  structured prompt
```

1. **Serve** — HTML files with invisible annotation overlay injected
2. **Annotate** — click any element, type your feedback, tag it with intent
3. **Export** — assembles all annotations into a ready-to-paste LLM prompt
4. **Iterate** — LLM updates files, browser reloads, annotate again

---

## Writing Prototypes

Each HTML file is one screen. Use Tailwind CSS, Lucide icons, and Google Fonts via CDN — the annotation contract tells your LLM to use exactly these libraries.

**Rules:**
- One file per screen — name after the route (`login.html`, `dashboard.html`)
- Every meaningful element gets a `data-proto-id` — kebab-case, globally unique
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
  <main data-proto-id="main-content" class="max-w-4xl mx-auto px-6 py-8">
    <h1 data-proto-id="page-title" class="text-2xl font-semibold">Dashboard</h1>
  </main>
  <script>lucide.createIcons();</script>
</body>
</html>
```

---

## Commands Reference

### `vibeflow serve [target]`

```bash
vibeflow serve .                  # serve all HTML files in current directory
vibeflow serve dashboard.html     # serve a single file
vibeflow serve -p 4000 .          # custom port
vibeflow serve --no-open .        # don't open browser automatically
vibeflow serve                    # API-only mode — use with an existing project
```

### `vibeflow export <target>`

```bash
vibeflow export .                        # print to stdout
vibeflow export . --clipboard            # copy to clipboard
vibeflow export . --output prompt.txt    # write to file
```

### `vibeflow tasks`

```bash
vibeflow tasks                                      # list all tasks
vibeflow tasks --status todo                        # filter by status
vibeflow tasks --type Research                      # filter by type
vibeflow tasks --get <id>                           # full task details
vibeflow tasks --add --title "Fix header" --description "..."
vibeflow tasks --edit <id> --set-status in-progress
vibeflow tasks --edit <id> --set-status review \
  --commit-message "fix: header layout" \
  --comment "Fixed the alignment issue"
```

---

## SaaS Cloud Sync (Optional)

Sign up at [vibeflow.tools](https://vibeflow.tools) to get a shared Kanban board, real-time collaboration, and CLI sync.

```bash
# Authenticate (device flow — opens browser)
vibeflow login

# Tasks now sync to the cloud board automatically
vibeflow tasks

# Migrate local tasks to SaaS
vibeflow push

# Check connection status
vibeflow status
```

The CLI works 100% offline in local mode without an account.

---

## Where to Find Vibeflow

| Platform | Category | Link |
|----------|----------|-------|
| **npm** | CLI packages | `npm install -g @vibeflow-tools/cli` |
| **Product Hunt** | Developer Tools | [producthunt.com](https://www.producthunt.com) |
| **DevHunt** | Developer Tools | [devhunt.org](https://devhunt.org) |
| **There's An AI For That** | AI Productivity | [theresanaiforthat.com](https://theresanaiforthat.com) |
| **Futurepedia** | AI Tools | [futurepedia.io](https://futurepedia.io) |
| **AI Top Tools** | AI Productivity | [aitoptools.com](https://aitoptools.com) |
| **Peerlist** | Developer Projects | [peerlist.io](https://peerlist.io) |
| **BetaList** | Early-stage SaaS | [betalist.com](https://betalist.com) |
| **Hacker News** | Show HN | [news.ycombinator.com](https://news.ycombinator.com) |
| **awesome-cli-apps** | GitHub Awesome List | [github.com/agarrharr/awesome-cli-apps](https://github.com/agarrharr/awesome-cli-apps) |

---

## Contributing

```bash
pnpm install       # install dependencies
pnpm build:cli     # build CLI
pnpm test          # unit tests
pnpm test:e2e      # end-to-end tests
```

---

## License

[Apache-2.0](LICENSE) — see [NOTICE](NOTICE) for third-party attributions.
