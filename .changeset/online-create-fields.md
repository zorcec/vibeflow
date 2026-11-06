---
"@vibeflow-tools/cli": patch
---

Fix silent field loss in online task I/O: `tasks --add` and MCP `create_task` now forward `type`, `priority`, `tags`, `url`, `selector` and `cssSelector` to the v0 backend instead of dropping them without warning (previously `--add --type Research` created a plain Task). Reads now round-trip: `toLocalTask` maps the stored `selector`/`url`/`cssSelector` (it hardcoded `selector: "/"`) and the human `--get` output prints the real selector plus the url line. `tasks --get --fields` is applied on the online path too (it was a silent no-op when linked to the hosted backend; local always projected). `sortKey` stays local-only — the v0 create has no column for it. Help text for `--type`/`--tag` now documents the `--add` behaviour.
