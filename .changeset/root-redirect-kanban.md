---
"@vibeflow-tools/cli": patch
---

Redirect the board-server root (`/`) to `/kanban` (302). The kanban server previously left `/` as Express's default 404; the redirect covers only the exact root so no other route is shadowed, and the fragment-free Location lets browsers preserve `#task-<id>` board deep links across it.
