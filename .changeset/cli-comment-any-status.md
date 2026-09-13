---
"@vibeflow-tools/cli": patch
---

Fix `--comment` being silently discarded outside a review transition.

The comment was written only when `--set-status review` was also passed, so adding a note to a todo, backlog or in-progress task accepted the flag and then threw the text away. The CLI printed `comment: added` unconditionally and before the write resolved, so the loss was invisible.

The comment is now written for any status, awaited, and reported only after the write succeeds — with a real error and a non-zero exit code on failure. `--comment` alone is also treated as an edit, so it no longer falls through to the help output.
