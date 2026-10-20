---
"@vibeflow-tools/cli": patch
---

Fix the login-time push on a multi-board account.

`auth login` listed the boards and stored the chosen one, then pushed with a
capability probe that omitted the board — so a 2-board account answered
`422 SCOPE_REQUIRED` and the login ended with "Push failed: this account has more
than one board and none is selected", immediately after asking which board to
use. The selected board now travels with the probe (and therefore as
`X-Vibeflow-Scope`), and two tests pin the header being present with a board and
absent without one.
