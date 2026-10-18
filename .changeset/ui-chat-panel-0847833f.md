---
"@vibeflow-tools/ui": patch
---

Agent chat panel (ticket 0847833f). New reusable `ChatPanel`: messages,
streaming tokens, tool-call cards, approval cards with Approve/Deny,
image paste with previews, and degraded states (no pi / no auth /
unavailable / error). Presentational only — the host drives it via
props, so overlay, kanban, and the web app share one component.
