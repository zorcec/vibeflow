---
"@vibeflow-tools/cli": patch
---

Use default model from settings in Agent tab when no model is explicitly chosen. Fixed state disconnect where "Run Agent" passed empty string instead of the displayed default model. CLI kanban now passes defaultModel to DetailPanel.
