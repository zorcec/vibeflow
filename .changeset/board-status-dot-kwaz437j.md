---
"@vibeflow-tools/ui": patch
---

Kanban cards show the ticket's status as a colour dot with the status name on hover. The colour comes from the
existing canonical status-colour mapping (design tokens, no new values); the name rides in the hover tooltip and
in the dot's accessible name, and the tooltip is hover-only. No badge chip, no card redesign.
