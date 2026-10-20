---
"@vibeflow-tools/cli": patch
---

Send the board scope on every v0 request, not just the capability probe.

Fixing only the probe moved the failure one step later: `auth login` then pushed
1758 tasks and 782 files that ALL came back `422 SCOPE_REQUIRED`, because task
create, file upload, online-id listing and link apply each built their own
`Authorization` header without `X-Vibeflow-Scope`. On a 2-board account the
server refuses every one of them.

`scopeHeadersFromSaved()` resolves the saved board per call (not at module load:
login writes the board and pushes in the same process) and is applied at those
sites. 112 targeted tests pass.
