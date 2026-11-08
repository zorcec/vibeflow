---
"@vibeflow-tools/cli": patch
---

Fix silent field loss when a board is linked: `tasks --add` and `create_task` keep `type`, `priority`, `tags`, `url`, `selector` and `cssSelector` instead of dropping them without warning (previously `--add --type Research` was stored as a plain Task). Reads round-trip too: the selector is no longer flattened to `/`, `--get` prints the real selector and url, and `--get --fields` is applied instead of being ignored. `sortKey` stays local-only.
