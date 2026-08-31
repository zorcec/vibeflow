---
"@vibeflow-tools/cli": patch
---

feat(verify): add agent evidence tools for targeted style/HTML queries

Adds four new CLI tools that agents can call to explore verify evidence
without reading all files (~34K tokens → ~7K tokens):

- `vibeflow verify style_query <task-id> <property>` — query specific CSS property
- `vibeflow verify style_diff <task-id> [--filter <pattern>]` — get changed properties
- `vibeflow verify element_info <task-id>` — get element details
- `vibeflow verify html_diff <task-id>` — get HTML changes

Also adds tool hints in verify output so agents know what's available.
