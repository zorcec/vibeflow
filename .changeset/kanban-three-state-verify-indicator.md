---
"@vibeflow-tools/cli": patch
"@vibeflow-tools/ui": patch
---

Show all three verify states on kanban cards. The only verify marker used to be a `✓ VERIFIED` chip gated on the `done` column, but verify runs before `review`, so a verified task sitting in review — the normal end state — showed nothing, and a FAILED verify looked exactly like one that never ran. A verify verdict now rides the leading icon slot on every card and child row: a check for passed, an alert for failed, and nothing when there is no verdict. It sits beside the in-progress loader instead of replacing it, so an in-progress task that is also verified reads correctly, and it names itself (`title`/`aria-label`: "Verified" / "Verification failed") so the state never relies on colour alone. The `done` chip is replaced by this glyph so a card never carries two markers for one fact.

The persisted `verified` flag is now genuinely tri-state. Reading a task preserves an absent flag as `undefined` instead of collapsing it to `false`, and claiming a task (status → in-progress) clears the flag rather than writing `false`; `false` therefore uniquely means "the last verify failed" and `undefined` means "never verified". On a failed verify the CLI now ends with an explicit next step — "fix the issues above, then re-run: `vibeflow verify <task-id>`" — instead of stopping at the error.
