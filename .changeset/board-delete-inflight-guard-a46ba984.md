---
"@vibeflow-tools/ui": patch
---

The board delete dialog now blocks Cancel while the delete request is in flight: Cancel is disabled, the confirm button shows progress, and Escape/backdrop are ignored. If the request fails, Cancel re-enables and the error is shown.
