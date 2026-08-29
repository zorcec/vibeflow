---
"@vibeflow-tools/cli": patch
---

Add next_actions hints to mutation command JSON output

- `tasks --add`: returns next_actions with hints to set status and add description
- `tasks --next`: returns next_actions with implementation workflow hints
- `tasks --edit --set-status`: returns context-appropriate next_actions
- `tasks --commit`: returns next_actions to set review status

Human-readable output shows concise → Next: hint lines.
