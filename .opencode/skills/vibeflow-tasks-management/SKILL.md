---
name: vibeflow-tasks-management
description: Vibeflow CLI task management — discover, claim, implement, and submit tasks. Load when the user asks to "implement next task", "list tasks", "claim a task", "open kanban", "set task to review", or anything involving vibeflow tasks.
---

# Vibeflow Task Management

## Binary and Working Directory

```bash
TASKS="node ../vibeflow/packages/cli/dist/cli/index.js tasks"
```

**Always run task commands from `vibeflow-private/`** — the CLI reads/writes tasks relative to the current directory (`.vibeflow/tasks/`). Running from the wrong repo puts tasks in the wrong place.

## Discover Tasks

| Command | Purpose |
|---------|---------|
| `$TASKS` | List tasks (default: 20 most recent) |
| `$TASKS --limit 0` | Show all tasks |
| `$TASKS --status todo` | List tasks ready to work on |
| `$TASKS --status review` | List tasks in review |
| `$TASKS --type Bug` | Filter by type (Task, Bug, Feature, Enhancement, Research) |
| `$TASKS --user <email>` | Filter by author |
| `$TASKS --tag <tag>` | Filter by tag (repeatable for AND) |
| `$TASKS --get <id>` | Full task details with comments and files (supports partial ID) |
| `$TASKS --next` | Pick highest-priority todo task, auto-claim to in-progress |
| `$TASKS --next --type Bug` | Next bug task only |

## Task Workflow

```
1. $TASKS --status todo                          # discover open tasks
2. $TASKS --edit <id> --set-status in-progress   # claim — DO THIS FIRST
3. <implement the change>
4. git add <files>                               # stage changes
5. $TASKS --edit <id> --set-status review --commit-message "summary" --comment "report"
```

The CLI auto-commits the task `.json` and auto-pushes when settings are enabled.

## Edit Commands

| Command | Purpose |
|---------|---------|
| `$TASKS --edit <id> --set-status in-progress` | Claim a task |
| `$TASKS --edit <id> --set-status review --commit-message "..." --comment "..."` | Submit for review |
| `$TASKS --edit <id> --title "..." --description "..."` | Edit task fields |
| `$TASKS --add --title "..." --description "..."` | Create a new task |
| `$TASKS --commit --task <id> --message "..."` | Commit staged changes and link to task |

## Comment Format (`--comment` when setting review)

- **Plain text** for concise one-liners
- **Markdown** for multi-section reports: use **bold**, bullet lists, code fences
- Must cover: what changed, why, key decisions, anything future agents should know
- For long reports, attach a `.md` file and reference it in the comment

## Critical Rules

- **NEVER** edit `.vibeflow/` task files directly — all operations go through CLI
- **NEVER** set status to "done" — use "review". Only humans mark tasks done
- **Always run from `vibeflow-private/`** — wrong directory = wrong task store
- **Set in-progress BEFORE reading/planning** — signals ownership, prevents duplicate work

## Task Types and Statuses

**Types:** Task · Bug · Feature · Enhancement · Research
**Statuses:** backlog → todo → in-progress → review → done
**Priorities:** Critical · High · Medium · Low

## Kanban Board

```bash
cd /home/zorcec/workspace/vibeflow-workspace/vibeflow-private
node ../vibeflow/packages/cli/dist/cli/index.js kanban
```

Opens the live Kanban board in the browser with drag-and-drop columns, agent status display, and file attachments.
