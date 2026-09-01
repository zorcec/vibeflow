---
"@vibeflow-tools/cli": minor
---

feat(cli): startup banner always shows a localhost URL alongside the LAN IP

When the server is bound to 0.0.0.0, every user-facing URL in the serve and
kanban startup banners (Kanban board, Task API, /inject guide, overlay script
tag, File lines, "Kanban board ready") now prints an aligned localhost
continuation line. Fixes kanban "request timeouts" when the displayed LAN IP
is unreachable from the local browser. Output is unchanged when bound to a
single host.
