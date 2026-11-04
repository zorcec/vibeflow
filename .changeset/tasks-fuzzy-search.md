---
"@vibeflow-tools/cli": minor
---

`tasks --search "..."` fuzzy-searches the board over title, description, comments and tags (case-insensitive, typo-tolerant; every word must match). A search returns matching children like the other filters and ranks by relevance (score, then id). In remote mode the search narrows with `?q=` and ranks the same way, and the MCP `list_tasks` tool accepts the same `search` field — one query returns the same ids in the same order on every surface.

  ### Highlights

  - Fuzzy task search via `tasks --search` and the MCP search tool (title, description, comments and tags; children included, local and online).
