---
"@vibeflow-tools/cli": minor
---

Auth is now project-scoped: `vibeflow login` stores the credential user-scoped (keyed by API host) and links the board to the current project instead of the whole machine, and every command resolves that project's own pointer. No data migration — local stores are untouched; run `vibeflow login` once per project to link it (a leftover machine-global token is ignored with a one-line notice).
