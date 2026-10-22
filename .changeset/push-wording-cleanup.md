---
"@vibeflow-tools/cli": patch
---

Push result lines now use transport-aware verbs and an outcome headline (wording only — no behaviour, counting, exit-code, or `--json` change): the delta path reads `N sent, M already identical (not sent)` and never claims `created` (the archive reports bytes moved, so one repaired task among 1797 no longer prints `1 created, 1796 updated`); the multipart path keeps the server-reported `N created, M already existed` split (never `updated`); the headline is `Push complete` only for a clean run — `Push stopped` after a refusal or early stop, `Push finished with failures` when atomic skips or file/link failures remain. Mutation not run (on-request only).
