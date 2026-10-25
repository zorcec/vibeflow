---
"@vibeflow-tools/cli": patch
---

Fix `tasks --tag` matching nothing on a shared board though the board sends tags. The CLI's server->task mapping dropped the `tags` every board row already carries, so the filter read an absent field for shared boards while local boards read the record — the same command answered differently depending on where the board lives. The mapping now carries tags exactly where the local path puts them (same verbatim rule: every non-empty string, no trim/lowercase/dedupe), and the existing filter keeps doing its one job in both cases — no second tag-specific path.
