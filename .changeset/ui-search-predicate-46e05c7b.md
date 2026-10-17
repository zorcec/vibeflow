---
"@vibeflow-tools/ui": patch
---

Extract the board search into one shared `taskMatchesQuery(task, query)` predicate (`filterTasksByQuery` for lists) and route the board, list view, and header count through it — same case-insensitive title+description substring semantics as before, no behaviour change. The search box now propagates to the board on a 150ms trailing debounce (`useDebouncedValue`, `SEARCH_DEBOUNCE_MS`) instead of re-rendering on every keystroke, while the input echo stays instant.
