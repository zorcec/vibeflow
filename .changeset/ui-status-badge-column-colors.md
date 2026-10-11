---
"@vibeflow-tools/ui": patch
---

Match the child-row status badge colours to the kanban columns

The `.status-badge--*` label colours were shifted by one status relative to
the board: a todo badge wore backlog's gray, an in-progress badge wore todo's
orange, and a review badge wore in-progress's blue, so a label never matched
its column (backlog and done happened to be correct). This was a copy/paste
shift in the badge rules, not a design decision. The three wrong rules now
carry their canonical hues — todo amber, in-progress blue, review purple —
mirroring the DetailPanel status buttons, the FilterBar chips, and the list
view, via the theme-aware chip tokens so dark and light themes recolour
together. The CLI prints plain uncoloured `[status]` text, so there was
nothing to match there.
