---
"@vibeflow-tools/cli": patch
---

Rename customer-facing "proto" surfaces to Vibeflow naming: commit tags are now `[vibeflow:<taskId>]` (legacy `[proto:<taskId>]` still parses), CLI output shows `vibeflow:` labels, `proto serve` / `proto server` strings say `vibeflow serve` / `Vibeflow server`, and the annotation contract uses `data-vibeflow-id`. Overlay embeds keep detecting legacy `data-proto-overlay` snippets and `proto-studio-root` hosts.
