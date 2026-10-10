---
"@vibeflow-tools/ui": patch
---

Match the settings fullscreen checkbox to the modal's other checkboxes

The "Open task details fullscreen" checkbox in the kanban settings Board tab
set only `width`, `height` and `cursor`, so the browser painted it with the
OS-default accent while every other checkbox in the same modal uses the
design-token accent (`var(--t-accent)`). It now carries the same token, and it
moved out of "Visible Columns" into its own "Display" section, because showing
the details panel fullscreen is a display preference rather than a column
choice. Behaviour is unchanged: the `panelFullscreen` flag, its toggle and the
Apply path are exactly as before.

### Highlights

- The fullscreen settings checkbox now picks up the theme accent instead of the OS default blue, and sits in its own "Display" section under the column list.
