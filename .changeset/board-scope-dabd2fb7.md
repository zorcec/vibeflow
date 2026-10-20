---
"@vibeflow-tools/cli": patch
---

One shared board-selection rule for every CLI request (ticket dabd2fb7).
`resolveBoardScope` picks the target board in fixed order — explicit
`--board` flag, saved workspace (written by `auth login`), then
auto-select ONLY when the account has exactly one board. An account with
2+ boards and nothing selected never gets a guess: the new
`BoardScopeRequiredError` lists every board and tells you to re-run with
`--board <boardId>` (or `vibeflow auth login` to bind a default) before
any request is sent, so a push can never move the whole local store to
the wrong board. Every request builder sends `X-Vibeflow-Scope` through
the single `scopeHeaderFor` helper, and `vibeflow push` now accepts
`--board <boardId>` (it wins over the saved board). Covered by unit
tests through dependency injection: flag wins and trims, saved board
fallback, single-board auto-select, the 2+ board refusal, and no-token
local mode.
