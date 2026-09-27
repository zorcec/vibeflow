---
"@vibeflow-tools/cli": patch
---

`serve` and `kanban` now resolve, validate, and announce the project root at startup instead of silently trusting the cwd.

- New `--project <dir>` flag on `serve` and `kanban` selects the project root explicitly (on `serve` it applies to API-only/MCP mode; an HTML target still derives its own directory).
- Startup prints `✓ Project root: <absolute path> (<name>, branch <branch|none>)` before anything is created.
- Obvious non-projects are refused with exit code 2 and an error naming `--project`: the filesystem root, your home directory, and a directory that is neither a git repo nor a `.vibeflow/` store. `.vibeflow/` is never created before validation passes, and the server layer hard-refuses `/` and `$HOME` even for programmatic callers that bypass the CLI.
- The MCP `initialize` handshake now reports the resolved project: `instructions` names the absolute root, project name, git branch, and mode, so a client can see which project it is about to mutate before any tool call.
