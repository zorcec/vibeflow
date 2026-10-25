---
"@vibeflow-tools/ui": patch
---

Board attribution no longer flips between "agent" and "user" for the same work. One shared rule (`resolveAttribution` + `AgentBadge`, exported from `@vibeflow-tools/ui/kanban`) renders the human behind the row with an agent badge when an agent surface wrote it, and every surface reads it: feed comments, change rows, the card assignee pill, and the details author tile. Agent comments now name the joined human instead of hiding them behind a bare marker; marker-only rows and unknown attribution render honestly with no invented name. Consumed unchanged by both boards (CLI kanban re-exports the same components), so the same record renders the same attribution online and in the CLI.
