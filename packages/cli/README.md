# vibeflow

> **Feedback that becomes code.**

[![npm version](https://img.shields.io/npm/v/%40vibeflow-tools%2Fcli?color=blue)](https://www.npmjs.com/package/@vibeflow-tools/cli)
[![License](https://img.shields.io/badge/license-Apache--2.0-green)](https://www.apache.org/licenses/LICENSE-2.0)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)

Annotate anything in the browser, hand structured context to your AI coding agent, ship. No Slack threads. No tickets nobody reads. No switching context.

```bash
npm install -g vibeflow
npx vibeflow kanban
```

## Website

- Main website: https://www.vibeflow.tools/
- Tutorials: https://www.vibeflow.tools/tutorials.html

---

## The problem

You review your AI agent's output in the browser. You spot issues. Then the hard part: re-explaining every little thing in plain text, hoping the agent understands where to look and what's wrong.

- **"Just sent you a Slack message about it"** — context-switching costs 23 minutes to recover. The fix takes 2 minutes.
- **"Here's a screenshot, the thing on the left"** — screenshots without structure become detective work. Your agent needs selectors, not JPEGs.
- **"I described it to the AI but it got confused"** — prose descriptions lose precision. Agents work best with structured, reproducible context.

**Vibeflow eliminates the guessing loop.**

---

## How it works

Three steps. Zero ceremony.

### 1. Serve

One command starts a local server that injects an annotation overlay into any HTML file or add overlay script to the live app.

```bash
vibeflow serve ./my-project
```

### 2. Annotate

Open the browser. Click any element, write a quick note, set priority. Every annotation becomes a task stored as JSON in `.vibeflow/` — versioned in git, visible in the Kanban board.

```bash
vibeflow kanban          # open the Kanban board
```

### 3. Hand to your agent

Give your AI agent one prompt. It claims the next task, implements it, and marks it for review — all through the CLI.

```bash
vibeflow tasks --next
```

> **The magic prompt for your agent:**
> *"Get new tasks and implement them, once done check again for new ones:*
> *`npx @vibeflow-tools/cli tasks --next`"*

`--next` atomically claims the highest-priority todo task (sets it in-progress), preventing two agents from picking the same task. Run it again after completing each task to get the next one.

---

## Commands

### Serving

| Command | Description |
|---------|-------------|
| `vibeflow serve [target]` | Serve an HTML folder with the annotation overlay injected |
| `vibeflow kanban [dir]` | Start the server and open the Kanban board in your browser |

### Tasks

| Command | Description |
|---------|-------------|
| `vibeflow tasks` | List all tasks |
| `vibeflow tasks --next` | Claim the next todo task (sets in-progress, returns full task details) |
| `vibeflow tasks --status todo` | Filter to open tasks |
| `vibeflow tasks --type Bug` | Filter by type (Task, Bug, Feature, Enhancement, Research) |
| `vibeflow tasks --get <id>` | Full task detail with comments, file attachments, and linked commits |
| `vibeflow tasks --add --title "..." --description "..."` | Create a new task |
| `vibeflow tasks --edit <id> --set-status review --commit-message "..." --comment "..."` | Mark task as review, auto-commit staged files, add report |
| `vibeflow tasks --json` | Machine-readable JSON output |

**Task statuses:** backlog → todo → in-progress → review → done

---

## Features

| Feature | Description |
|---------|-------------|
| **Local-first** | Runs entirely on your machine. Tasks in `.vibeflow/` — committed to git, readable by any tool |
| **Agent-ready** | Works with GitHub Copilot, Claude, Cursor, Windsurf — any tool that accepts a prompt |
| **Click-to-annotate** | Captures exact CSS selector, URL, and source location automatically |
| **Kanban board** | Full task manager with backlog, in-progress, review, done — view in browser or drive from CLI |
| **Screenshots** | Paste a screenshot onto any task, or let the tool capture it automatically |
| **Keyboard shortcut** | `Alt+A` to toggle annotation mode |
| **Error recording** | Captures recent console errors into bug reports |
| **Offline** | Works 100% locally, no account needed |

---

## Quick Start

```bash
# Open the Kanban board
npx vibeflow kanban

# Tell your agent to implement all open tasks (--next workflow)
npx vibeflow tasks --next
```

---

## Agent workflow

When running `vibeflow tasks`, the CLI prints agent instructions automatically. Key rules:

1. **Claim first** — set status to `in-progress` before reading or planning
2. **Never set `done`** — use `review`; only humans mark tasks done
3. **Never edit `.vibeflow/` files directly** — use CLI commands only
4. **Research tasks** — attach a `.md` report before marking review; never generate code
5. **Bug tasks** — include error logs and stack traces in commit comments

---

## Requirements

- **Node.js 22+** — install from [nodejs.org](https://nodejs.org)
- **React in dev mode (recommended)** — for component names, source files, and line numbers. Run in `NODE_ENV=development` (the default for `next dev`).

---

## License

[Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0)
