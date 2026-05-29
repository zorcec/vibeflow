---
"@vibeflow-tools/cli": patch
---

Normalize literal `\n`, `\t`, `\r` escape sequences in task titles and descriptions at creation time. This fixes agent-created tasks that pass descriptions via CLI args (e.g. `--description "Line 1\nLine 2"`) which previously stored literal backslash-n instead of real newlines.
